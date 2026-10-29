import { cosine, ranked } from "./similarity";
import { EvidenceBudget } from "./evidence-budget";
import type { MemoryStore } from "./store";
import type { Evidence, ExpansionReason, Hit, Memory, RetrievalMode, RetrievalPolicy } from "./types";

export const DEFAULT_RETRIEVAL_POLICY: RetrievalPolicy = {
  firstCandidates: 100, firstLimit: 15, neighborsPerSeed: 100, secondLimit: 15,
  sourceCandidatesPerMemory: 4, sourceLimitPerMemory: 2,
  maxRecords: 15, maxContextChars: 18_000, maxEstimatedTokens: 6000, maxRecordChars: 5000,
};

export function normalizePolicy(input: Partial<RetrievalPolicy> = {}): RetrievalPolicy {
  const result = { ...DEFAULT_RETRIEVAL_POLICY };
  const limits: Record<keyof RetrievalPolicy, [number, number]> = {
    firstCandidates: [1, 500], firstLimit: [1, 15], neighborsPerSeed: [1, 500], secondLimit: [1, 15],
    sourceCandidatesPerMemory: [1, 4], sourceLimitPerMemory: [1, 4],
    maxRecords: [1, 15], maxContextChars: [128, 100_000], maxEstimatedTokens: [32, 32_000],
    maxRecordChars: [64, 20_000],
  };
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = input[key], [min, max] = limits[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = Math.max(min, Math.min(max, Math.floor(value)));
  }
  result.firstLimit = Math.min(result.firstLimit, result.firstCandidates);
  result.sourceLimitPerMemory = Math.min(result.sourceLimitPerMemory, result.sourceCandidatesPerMemory);
  return result;
}

export function retrievalPolicyFromEnv(): RetrievalPolicy {
  const keys: Record<keyof RetrievalPolicy, string> = {
    firstCandidates: "RAG_FIRST_CANDIDATES", firstLimit: "RAG_FIRST_LIMIT", neighborsPerSeed: "RAG_NEIGHBORS_PER_SEED",
    secondLimit: "RAG_SECOND_LIMIT", maxRecords: "RAG_MAX_RECORDS", maxContextChars: "RAG_CONTEXT_MAX_CHARS",
    sourceCandidatesPerMemory: "RAG_SOURCE_CANDIDATES_PER_MEMORY", sourceLimitPerMemory: "RAG_SOURCE_LIMIT_PER_MEMORY",
    maxEstimatedTokens: "RAG_CONTEXT_MAX_TOKENS", maxRecordChars: "RAG_RECORD_MAX_CHARS",
  };
  const input: Partial<RetrievalPolicy> = {};
  for (const key of Object.keys(keys) as (keyof RetrievalPolicy)[]) {
    const raw = process.env[keys[key]];
    if (raw?.trim()) input[key] = Number(raw);
  }
  return normalizePolicy(input);
}

export function retrieveFrom(store: MemoryStore, scope: string, space: string, query: number[], strategy: RetrievalMode,
  minScore: number, options: Partial<RetrievalPolicy> = {}): Evidence {
  const policy = normalizePolicy(options);
  // Cold summaries are audit history only; all rounds use current hot memories.
  const all = store.memories(scope, space, "hot");
  const candidates = ranked(all, query, policy.firstCandidates, minScore);
  const budget = new EvidenceBudget(policy);
  const first: Hit[] = [], second: Hit[] = [];

  const admit = (candidate: Memory & { score: number }, extras: Partial<Hit> = {}): Hit | undefined => {
    if (!budget.addSummary(candidate.id, candidate.createdAt, candidate.summary, candidate.sourceIds.length)) return undefined;
    const { vector: _vector, ...hit } = candidate;
    return { ...hit, ...extras, includedSourceIds: [] };
  };

  for (const candidate of candidates) {
    if (first.length >= policy.firstLimit || !budget.canAddMore()) break;
    const hit = admit(candidate, { originalScore: candidate.score });
    if (hit) first.push(hit);
  }
  let reason: ExpansionReason;
  if (strategy === "sources") reason = "sources-only";
  else if (!first.length) reason = "no-first-results";
  else if (!budget.canAddMore()) reason = "budget-exhausted";
  else if (first.length < 4) reason = "below-four-results";
  else reason = "enough-first-results";
  const expanded = reason === "below-four-results";

  if (expanded) {
    const excluded = new Set(first.map(x => x.id));
    const byId = new Map(all.map(x => [x.id, x]));
    const originalScores = new Map(all.map(x => [x.id, cosine(query, x.vector)]));
    const eligible = all.filter(x => !excluded.has(x.id));
    const neighbors = new Map<string, Memory & { score: number; originalScore: number; neighborScore: number; via: string }>();
    for (const seed of first) {
      for (const candidate of ranked(eligible, byId.get(seed.id)!.vector, policy.neighborsPerSeed, minScore)) {
        const originalScore = originalScores.get(candidate.id)!;
        const hit = { ...candidate, originalScore, neighborScore: candidate.score,
          score: originalScore * 0.75 + candidate.score * 0.25, via: seed.id };
        if (hit.score < minScore) continue;
        if (!neighbors.has(hit.id) || neighbors.get(hit.id)!.score < hit.score) neighbors.set(hit.id, hit);
      }
    }
    const secondCap = Math.min(policy.secondLimit, policy.maxRecords - first.length);
    for (const candidate of [...neighbors.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))) {
      if (second.length >= secondCap || !budget.canAddMore()) break;
      const hit = admit(candidate);
      if (hit) second.push(hit);
    }
  }
  const suggestions: Hit[] = candidates.length === 0
    ? ranked(all, query, 3, -1).map(({ vector: _vector, ...hit }) => hit)
    : [];
  return { first, second, suggestions, records: budget.records, stages: budget.stages, context: budget.context, strategy,
    trace: { expanded, reason, firstCandidates: candidates.length, minScore, policy, usage: budget.usage() } };
}

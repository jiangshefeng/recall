import { cosine, ranked } from "./similarity";
import { EvidenceBudget } from "./evidence-budget";
import type { MemoryStore } from "./store";
import type { Evidence, ExpansionReason, Hit, Memory, RetrievalMode, RetrievalPolicy } from "./types";

export const DEFAULT_RETRIEVAL_POLICY: RetrievalPolicy = {
  firstCandidates: 20, firstLimit: 3, neighborsPerSeed: 5, secondLimit: 3,
  sourceCandidatesPerMemory: 4, sourceLimitPerMemory: 2,
  maxRecords: 12, maxContextChars: 18_000, maxEstimatedTokens: 6000, maxRecordChars: 5000,
  minFirstResults: 3, minStrongResults: 2, strongScore: 0.75,
};

export function normalizePolicy(input: Partial<RetrievalPolicy> = {}): RetrievalPolicy {
  const result = { ...DEFAULT_RETRIEVAL_POLICY };
  const limits: Record<Exclude<keyof RetrievalPolicy, "strongScore">, [number, number]> = {
    firstCandidates: [1, 100], firstLimit: [1, 20], neighborsPerSeed: [1, 20], secondLimit: [1, 20],
    sourceCandidatesPerMemory: [1, 4], sourceLimitPerMemory: [1, 4],
    maxRecords: [1, 50], maxContextChars: [128, 100_000], maxEstimatedTokens: [32, 32_000],
    maxRecordChars: [64, 20_000], minFirstResults: [1, 20], minStrongResults: [1, 20],
  };
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = input[key], [min, max] = limits[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = Math.max(min, Math.min(max, Math.floor(value)));
  }
  if (typeof input.strongScore === "number" && Number.isFinite(input.strongScore)) result.strongScore = Math.max(0, Math.min(1, input.strongScore));
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
    minFirstResults: "RAG_MIN_FIRST_RESULTS", minStrongResults: "RAG_MIN_STRONG_RESULTS", strongScore: "RAG_STRONG_SCORE",
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
    const includedSourceIds: string[] = [];
    // Keep full provenance; fetch only recent uncovered candidates, then select the latest sources.
    const covered = new Set(candidate.stage?.sourceIds ?? []);
    const originals = store.recentRecords(scope, candidate.sourceIds.filter(id => !covered.has(id)), policy.sourceCandidatesPerMemory)
      .slice(0, policy.sourceLimitPerMemory);
    for (const record of originals) if (budget.add(record)) includedSourceIds.push(record.id);
    if (candidate.stage && budget.addStage(candidate.stage)) includedSourceIds.push(...candidate.stage.sourceIds);
    if (!includedSourceIds.length) return undefined;
    const { vector: _vector, ...hit } = candidate;
    return { ...hit, ...extras, includedSourceIds };
  };

  for (const candidate of candidates) {
    if (first.length >= policy.firstLimit || !budget.canAddMore()) break;
    const hit = admit(candidate, { originalScore: candidate.score });
    if (hit) first.push(hit);
  }
  const strongFirstResults = first.filter(x => x.score >= Math.max(minScore, policy.strongScore)).length;
  let reason: ExpansionReason;
  if (strategy === "sources") reason = "sources-only";
  else if (!first.length) reason = "no-first-results";
  else if (!budget.canAddMore()) reason = "budget-exhausted";
  else if (first.length < policy.minFirstResults) reason = "few-first-results";
  else if (strongFirstResults < policy.minStrongResults) reason = "few-strong-results";
  else reason = "enough-first-results";
  const expanded = reason === "few-first-results" || reason === "few-strong-results";

  if (expanded) {
    const excluded = new Set(first.map(x => x.id));
    const byId = new Map(all.map(x => [x.id, x]));
    const originalScores = new Map(all.map(x => [x.id, cosine(query, x.vector)]));
    // Apply original-query relevance BEFORE the per-seed cap, so irrelevant neighbours cannot crowd out valid ones.
    const eligible = all.filter(x => !excluded.has(x.id) && originalScores.get(x.id)! >= minScore);
    const neighbors = new Map<string, Memory & { score: number; originalScore: number; neighborScore: number; via: string }>();
    for (const seed of first) {
      for (const candidate of ranked(eligible, byId.get(seed.id)!.vector, policy.neighborsPerSeed, minScore)) {
        const originalScore = originalScores.get(candidate.id)!;
        const hit = { ...candidate, originalScore, neighborScore: candidate.score,
          score: originalScore * 0.75 + candidate.score * 0.25, via: seed.id };
        if (!neighbors.has(hit.id) || neighbors.get(hit.id)!.score < hit.score) neighbors.set(hit.id, hit);
      }
    }
    for (const candidate of [...neighbors.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))) {
      if (second.length >= policy.secondLimit || !budget.canAddMore()) break;
      const hit = admit(candidate);
      if (hit) second.push(hit);
    }
  }
  const suggestions: Hit[] = candidates.length === 0
    ? ranked(all, query, 3, -1).map(({ vector: _vector, ...hit }) => hit)
    : [];
  return { first, second, suggestions, records: budget.records, stages: budget.stages, context: budget.context, strategy,
    trace: { expanded, reason, firstCandidates: candidates.length, strongFirstResults, minScore, policy, usage: budget.usage() } };
}

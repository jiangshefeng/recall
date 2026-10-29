import { ranked } from "./similarity";
import { EvidenceBudget } from "./evidence-budget";
import type { MemoryStore } from "./store";
import type { Evidence, ExpansionReason, Hit, Memory, RetrievalMode, RetrievalPolicy } from "./types";

export const DEFAULT_RETRIEVAL_POLICY: RetrievalPolicy = {
  firstCandidates: 100, firstLimit: 5, neighborsPerSeed: 100, secondLimit: 10,
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
  else reason = "source-linked-results";
  const expanded = reason === "source-linked-results";

  if (expanded) {
    const excluded = new Set(first.map(x => x.id));
    const sourceToSeed = new Map<string, string>();
    for (const seed of first) for (const sourceId of seed.sourceIds) {
      if (!sourceToSeed.has(sourceId)) sourceToSeed.set(sourceId, seed.id);
    }
    // Traverse source IDs once, without reading originals or following newly
    // admitted summaries. Cold versions never enter this candidate pool.
    const eligible = all.filter(x => !excluded.has(x.id) && x.sourceIds.some(id => sourceToSeed.has(id)));
    const secondCap = Math.min(policy.secondLimit, policy.maxRecords - first.length);
    for (const candidate of ranked(eligible, query, eligible.length, -1)) {
      if (second.length >= secondCap || !budget.canAddMore()) break;
      const via = first.find(seed => candidate.sourceIds.some(id => seed.sourceIds.includes(id)))!.id;
      const hit = admit(candidate, { originalScore: candidate.score, via });
      if (hit) second.push(hit);
    }
    if (!eligible.length) reason = "no-linked-results";
  }
  const suggestions: Hit[] = candidates.length === 0
    ? ranked(all, query, 3, -1).map(({ vector: _vector, ...hit }) => hit)
    : [];
  return { first, second, suggestions, records: budget.records, stages: budget.stages, context: budget.context, strategy,
    trace: { expanded, reason, firstCandidates: candidates.length, minScore, policy, usage: budget.usage() } };
}

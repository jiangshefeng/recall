import { EvidenceBudget } from '../src/lib/evidence-budget';
import { cosine } from '../src/lib/similarity';
import type { Evidence, Memory } from '../src/lib/types';

// Evaluation-only, one-hop source-ID expansion. No original text or extra LLM calls.
export function supplementLinkedSummaries(evidence: Evidence, memories: Memory[], query: number[]) {
  const hits = new Map([...evidence.first, ...evidence.second].map(hit => [hit.id, hit]));
  const seeds = evidence.context.filter(entry => entry.kind === 'summary').slice(0, 8).map(entry => {
    const hit = hits.get(entry.id);
    if (!hit) throw new Error('Missing selected summary hit');
    return hit;
  });
  const identity = seeds[0];
  if (seeds.some(seed => seed.scope !== identity.scope || seed.space !== identity.space)) {
    throw new Error('Expansion seeds must share scope and embedding space');
  }
  const sourceIds = new Set(seeds.flatMap(seed => seed.sourceIds));
  const existing = new Set(evidence.context.map(entry => entry.id));
  const unique = new Map<string, Memory>();
  for (const memory of memories) {
    if (!identity || memory.status !== 'hot' || memory.scope !== identity.scope || memory.space !== identity.space) continue;
    if (!existing.has(memory.id) && memory.sourceIds.some(id => sourceIds.has(id))) unique.set(memory.id, memory);
  }
  const candidates = [...unique.values()].map(memory => {
    if (!query.length || memory.vector.length !== query.length || !query.every(Number.isFinite) || !memory.vector.every(Number.isFinite)) {
      throw new Error('Expansion requires compatible finite query and memory vectors');
    }
    return { memory, score: cosine(query, memory.vector), sourceIds: [...new Set(memory.sourceIds.filter(id => sourceIds.has(id)))].sort() };
  }).sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id));
  // Keep the original evidence verbatim; only the entry-count cap is expanded.
  // All candidates compete for the existing shared character/token budget.
  const budget = new EvidenceBudget({ ...evidence.trace.policy, maxRecords: evidence.context.length + candidates.length });
  budget.context.push(...structuredClone(evidence.context));
  const selected: { id: string; score: number; sourceIds: string[] }[] = [];
  for (const { memory, score, sourceIds: via } of candidates) {
    if (!budget.canAddMore()) break;
    if (budget.addSummary(memory.id, memory.createdAt, memory.summary, memory.sourceIds.length)) {
      selected.push({ id: memory.id, score, sourceIds: via });
    }
  }
  return {
    context: budget.context, usage: budget.usage(), seedIds: seeds.map(seed => seed.id), sourceIds: [...sourceIds].sort(),
    candidates: candidates.map(({ memory, score, sourceIds }) => ({ id: memory.id, score, sourceIds })), selected,
    addedSummaries: budget.context.slice(evidence.context.length),
  };
}

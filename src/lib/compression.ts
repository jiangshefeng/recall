import type { Memory, RecordEntry } from "./types";

function limit(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}
export function compressionPlan(previous: Memory, incoming: Memory, records: RecordEntry[]) {
  const sourceIds = [...new Set([...previous.sourceIds, ...incoming.sourceIds])];
  const covered = new Set(previous.stage?.sourceIds ?? []);
  const pending = records.filter(r => sourceIds.includes(r.id) && !covered.has(r.id));
  const chars = pending.reduce((sum, r) => sum + JSON.stringify(r).length, 0);
  return { sourceIds, pending: pending.length, chars,
    required: pending.length > limit("RAG_STAGE_SOURCE_THRESHOLD", 10, 1, 100) ||
      chars > limit("RAG_STAGE_CHAR_THRESHOLD", 12000, 500, 500000) };
}

// Keep full provenance in storage, but never reopen covered archives for routine merging.
export function pendingSourceIds(memory: Memory): string[] {
  const covered = new Set(memory.stage?.sourceIds ?? []);
  return memory.sourceIds.filter(id => !covered.has(id));
}

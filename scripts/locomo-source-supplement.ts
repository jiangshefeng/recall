import { EvidenceBudget } from '../src/lib/evidence-budget';
import type { Evidence, RecordEntry } from '../src/lib/types';

// Evaluation-only ablation. Preserve the selected summaries and use the same
// text/token budgets, adding no stages or previous-message context.
export function supplementSources(evidence: Evidence, records: RecordEntry[]) {
  const policy = { ...evidence.trace.policy, maxRecords: evidence.context.length + 8 };
  const budget = new EvidenceBudget(policy);
  budget.context.push(...structuredClone(evidence.context));
  const byId = new Map(records.map(r => [r.id, r]));
  const hits = new Map([...evidence.first, ...evidence.second].map(h => [h.id, h]));
  const seen = new Set<string>();
  const selected: { seedId: string; recordId: string }[] = [];
  const candidates: { seedId: string; ids: string[] }[] = [];
  let duplicateCandidates = 0;
  for (const entry of evidence.context.slice(0, 4)) {
    if (selected.length === 8) break;
    const hit = hits.get(entry.id);
    if (!hit) throw Error('Missing summary hit');
    const sourceRecords = [...new Set(hit.sourceIds)].map(id => {
      const record = byId.get(id);
      if (!record) throw Error('Missing linked original record');
      return record;
    }).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0,4);
    candidates.push({ seedId: entry.id, ids: sourceRecords.map(r=>r.id) });
    for (const record of sourceRecords) {
      if (selected.length === 8) break;
      if (seen.has(record.id)) { duplicateCandidates++; continue; }
      seen.add(record.id);
      // The LoCoMo adapter stores both named human speakers in these fields.
      const text = `Historical original dialogue; both fields contain named human speech.\n${record.question}\n${record.answer}`;
      if (budget.addSummary(record.id,record.createdAt,text,1)) {
        const admitted = budget.context.at(-1)!;
        delete admitted.kind;
        selected.push({ seedId:entry.id,recordId:record.id });
      }
    }
  }
  return { context:budget.context, selected, candidates, duplicateCandidates,
    usage:budget.usage(), addedOriginals:budget.context.slice(evidence.context.length) };
}

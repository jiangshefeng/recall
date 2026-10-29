import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { supplementLinkedSummaries } from './locomo-linked-summaries';
import { cosine } from '../src/lib/similarity';
import type { Memory } from '../src/lib/types';

// No providers, network calls, model answers or database writes in this audit.
const parentDir = resolve('artifacts/locomo-human-dialogue-conv30-50-v2-20261030');
const cacheDir = resolve('artifacts/locomo-human-dialogue-rank-audit-20261030');
const out = resolve('artifacts/locomo-top8-linked-summaries-audit-20261030');
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const parentPath = resolve(parentDir, 'report.json'), dbPath = resolve(parentDir, 'dynamic.sqlite');
const before = { report: hash(parentPath), database: hash(dbPath) };
const parent = JSON.parse(readFileSync(parentPath, 'utf8'));
const cache = JSON.parse(readFileSync(resolve(cacheDir, 'query-vectors.json'), 'utf8'));
const audit = JSON.parse(readFileSync(resolve(cacheDir, 'rank-audit.json'), 'utf8'));
assert.equal(cache.sourceReportSha256, before.report);
assert.equal(audit.sourceReportSha256, before.report);
assert.equal(audit.databaseSha256, before.database);
assert.equal(cache.embeddingModel, parent.manifest.embeddingModel);
const db = new DatabaseSync(dbPath, { readOnly: true });
const memories: Memory[] = db.prepare('SELECT m.*,k.kind FROM memories m LEFT JOIN memory_kinds k ON k.memory_id=m.id WHERE m.scope=? AND m.status=?')
  .all(parent.manifest.sample, 'hot').map((m: any) => ({
    id: m.id, scope: m.scope, space: m.space, summary: m.summary, vector: JSON.parse(m.vector), status: m.status,
    kind: m.kind || 'fact', sourceIds: JSON.parse(m.source_ids), parentIds: JSON.parse(m.parent_ids), reason: m.reason, createdAt: m.created_at,
  }));
db.close();
assert.equal(memories.length, parent.stats.dynamic.hot);
const rows = audit.results.map((job: any) => {
  const row = parent.results.find((r: any) => r.index === job.index);
  const cacheIndex = cache.questions.indexOf(row.qa.question);
  assert.ok(cacheIndex >= 0, 'Exact cached question required');
  const query: number[] = cache.vectors[cacheIndex];
  for (const hit of row.dynamic.evidence.first) {
    const memory = memories.find(m => m.id === hit.id)!;
    assert.ok(Math.abs(hit.score - cosine(query, memory.vector)) < 0.00001, 'Frozen query scores must match');
  }
  const result = supplementLinkedSummaries(row.dynamic.evidence, memories, query);
  assert.deepEqual(result.context.slice(0, row.dynamic.evidence.context.length), row.dynamic.evidence.context);
  assert.equal(new Set(result.context.map(m => m.id)).size, result.context.length);
  assert.ok(result.context.every(m => m.kind === 'summary'));
  assert.ok(result.usage.chars <= row.dynamic.evidence.trace.policy.maxContextChars);
  assert.ok(result.usage.estimatedTokens <= row.dynamic.evidence.trace.policy.maxEstimatedTokens);
  return {
    index: row.index, seedCount: result.seedIds.length, linkedOriginals: result.sourceIds.length,
    candidateCount: result.candidates.length, addedCount: result.selected.length, usage: result.usage,
    targets: job.targets.map((t: any) => {
      const entry = result.context.find(e => e.id === t.id);
      return { label: t.label, id: t.id, before: t.inOriginal15,
        candidate: result.candidates.some(c => c.id === t.id), after: !!entry, truncated: entry?.truncated ?? false };
    }),
    selected: result.selected, context: result.context,
  };
});
assert.equal(hash(parentPath), before.report);
assert.equal(hash(dbPath), before.database);
const targets = rows.flatMap((row: any) => row.targets);
const output = {
  status: 'completed', sourceHashes: before, frozenSourcesUnchanged: true,
  method: 'Eight previously diagnosed development questions; cached exact queries; first eight selected summaries, all their source IDs, all linked hot summaries in same scope/space. Deduplicate, preserve old evidence, rank new candidates by query cosine without minimum score; shared original text/token budgets, no recursive expansion.',
  cloudCalls: 0, embeddingCalls: 0, answerCalls: 0, scoredAnswers: 0,
  targetCount: targets.length, targetsBefore: targets.filter((t: any) => t.before).length,
  targetsAfter: targets.filter((t: any) => t.after).length,
  sourceCode: Object.fromEntries(['scripts/locomo-linked-summaries.ts', 'scripts/audit-locomo-linked-summaries.ts'].map(p => [p, hash(p)])),
  results: rows,
};
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'audit.json'), JSON.stringify(output, null, 2));
const lines = ['# Top8 同源摘要扩展：离线诊断', '',
  '只检查此前人工指定的8道差异题及目标摘要，不生成新回答，不是新的官方F1或正确率。云端、Embedding调用均为0，冻结数据库及旧报告未变。', '',
  '|题号|关联原文ID数|新增候选摘要|实际补入|最终估算token|', '|---|---:|---:|---:|---:|'];
for (const row of rows) lines.push(`|${row.index}|${row.linkedOriginals}|${row.candidateCount}|${row.addedCount}|${row.usage.estimatedTokens}|`);
lines.push('', '|题号|诊断目标|原证据包含|扩展后包含|截断|', '|---|---|---|---|---|');
for (const row of rows) for (const t of row.targets) lines.push(`|${row.index}|${t.label}|${t.before ? '是' : '否'}|${t.after ? '是' : '否'}|${t.truncated ? '是' : '否'}|`);
lines.push('', '人工指定目标仅用于事后核对；候选生成、排序及预算选择均不使用题目标准答案或目标ID。不能据此推断其他题的覆盖率或回答得分。');
writeFileSync(resolve(out, 'audit.md'), lines.join('\n'));
console.log(JSON.stringify({ ...output, results: rows.map(({ context: _context, selected: _selected, ...row }: any) => row) }, null, 2));

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { complete, embedMany, modelConfig } from '../src/lib/providers';
import { cosine } from '../src/lib/similarity';
import { readSSE } from '../src/lib/sse';
import { supplementLinkedSummaries } from './locomo-linked-summaries';
import { chargeUsage, remainingAllows, reserveTokens } from './locomo-small-support';
import type { Memory } from '../src/lib/types';

async function main() {
  const parentDir = resolve('artifacts/locomo-human-dialogue-conv30-50-v2-20261030');
  const out = resolve('artifacts/locomo-top8-linked-summaries-conv30-50-20261030');
  const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const parentPath = resolve(parentDir, 'report.json'), dbPath = resolve(parentDir, 'dynamic.sqlite');
  const parent = JSON.parse(readFileSync(parentPath, 'utf8'));
  assert.equal(parent.status, 'completed'); assert.equal(parent.results.length, 50);
  const cfg = modelConfig();
  assert.equal(cfg.llmModel, parent.manifest.chatModel);
  assert.equal(cfg.llmApiStyle, parent.manifest.apiStyle);
  assert.equal(cfg.reasoningEffort, parent.manifest.reasoningEffort);
  assert.equal(cfg.embeddingModel, parent.manifest.embeddingModel);
  assert.ok(Object.entries(parent.manifest.sourceCode).every(([p, h]) => sha(p) === h), 'Core source must match frozen bank');
  const sourceHashes = { report: sha(parentPath), database: sha(dbPath) };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const memories: Memory[] = db.prepare('SELECT m.*,k.kind FROM memories m LEFT JOIN memory_kinds k ON k.memory_id=m.id WHERE m.scope=? AND m.space=? AND m.status=?')
    .all(parent.manifest.sample, cfg.space, 'hot').map((m: any) => ({
      id: m.id, scope: m.scope, space: m.space, summary: m.summary, vector: JSON.parse(m.vector), status: m.status,
      kind: m.kind || 'fact', sourceIds: JSON.parse(m.source_ids), parentIds: JSON.parse(m.parent_ids), reason: m.reason, createdAt: m.created_at,
    }));
  db.close(); assert.equal(memories.length, parent.stats.dynamic.hot);
  mkdirSync(resolve(out, 'responses'), { recursive: true });
  const questions: string[] = parent.results.map((r: any) => r.qa.question);
  const cachePath = resolve(out, 'query-vectors.json');
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8'))
    : { sourceReportSha256: sourceHashes.report, embeddingModel: cfg.embeddingModel, questions, vectors: [] };
  assert.equal(cache.sourceReportSha256, sourceHashes.report); assert.equal(cache.embeddingModel, cfg.embeddingModel);
  assert.deepEqual(cache.questions, questions);
  const localBase = new URL(cfg.embeddingBase), originalFetch = globalThis.fetch;
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(localBase.hostname), 'Only local embeddings permitted');
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.origin, localBase.origin); assert.ok(url.pathname.endsWith('/embeddings'));
    return originalFetch(input, init);
  };
  try {
    while (cache.vectors.length < questions.length) {
      cache.vectors.push(...await embedMany(questions.slice(cache.vectors.length, cache.vectors.length + 4)));
      writeFileSync(cachePath + '.tmp', JSON.stringify(cache)); renameSync(cachePath + '.tmp', cachePath);
    }
  } finally { globalThis.fetch = originalFetch; }
  const manifest = { ...parent.manifest, budgetTokens: 500000, ingestLimit: 0, answerReserve: 0,
    sourceCode: { ...parent.manifest.sourceCode, ...Object.fromEntries([
      'scripts/locomo-linked-summaries.ts', 'scripts/evaluate-locomo-linked-summaries.ts',
    ].map(p => [p, sha(p)])) },
    frozenSource: { parentDir, ...sourceHashes }, queryVectorsSha256: sha(cachePath),
    experiment: { firstSummaries: 8, allLinkedSourceIds: true, hotSummariesOnly: true, recursive: false,
      candidateMinScore: null, order: 'query cosine DESC, ID ASC', preserveBaseline: true,
      entryCap: 'original count + unique linked candidate count', sharedOriginalTextTokenBudgets: true,
      baselineUsageNotChargedAgain: true, partialWritesRetained: parent.ingestion.filter((r: any) => r.action === 'partial').length },
  };
  const file = resolve(out, 'report.json');
  const report: any = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {
    manifest, status: 'prepared', requests: [], ingestion: parent.ingestion, memories: parent.memories, stats: parent.stats,
    results: parent.results.map((row: any, i: number) => {
      const query = cache.vectors[i];
      for (const hit of row.dynamic.evidence.first) {
        assert.ok(Math.abs(hit.score - cosine(query, memories.find(m => m.id === hit.id)!.vector)) < 0.00001, 'Query embedding drift');
      }
      const supplement = supplementLinkedSummaries(row.dynamic.evidence, memories, query);
      assert.deepEqual(supplement.context.slice(0, row.dynamic.evidence.context.length), row.dynamic.evidence.context);
      return { index: row.index, qa: row.qa, baselineDynamic: row.dynamic, raw: row.raw, raw3: row.raw3, supplement };
    }),
  };
  assert.deepEqual(report.manifest, manifest, 'Resume requires identical source and settings');
  assert.ok(!report.requests.some((r: any) => r.status !== 'ok'), 'Unresolved request; never silently repeat unknown charges');
  const save = () => { report.updatedAt = new Date().toISOString(); writeFileSync(file + '.tmp', JSON.stringify(report, null, 2)); renameSync(file + '.tmp', file); };
  save();
  if (process.env.LOCOMO_PREPARE_ONLY === 'true') {
    console.log(JSON.stringify({ status: report.status, questions: report.results.length, cloudCalls: report.requests.length })); return;
  }
  let activeQuestion: number | undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.href, `${cfg.llmBase}/responses`, 'Only answering endpoint permitted');
    const payload = JSON.parse(String(init?.body)), reserve = reserveTokens(payload);
    assert.ok(remainingAllows(report.requests, reserve, manifest.budgetTokens), 'Budget guard: request not sent');
    const metric: any = { kind: 'chat', phase: 'evaluate-dynamic', questionIndex: activeQuestion, status: 'pending', reserveTokens: reserve, chargedTokens: reserve };
    const index = report.requests.push(metric) - 1, started = Date.now(); save();
    try {
      const response = await originalFetch(input, init); metric.httpStatus = response.status;
      if (!response.ok || !response.body) throw new Error(`Provider HTTP ${response.status}; reservation retained`);
      let data: any;
      for await (const event of readSSE(response.body)) {
        if (event.data.trim() === '[DONE]') continue;
        const value = JSON.parse(event.data);
        if (['response.completed', 'response.failed', 'response.incomplete'].includes(value.type)) data = value.response;
      }
      if (!data) throw new Error('Terminal response missing; no automatic retry');
      metric.responseFile = `responses/${index}.json`; writeFileSync(resolve(out, metric.responseFile), JSON.stringify(data, null, 2));
      assert.ok(chargeUsage(metric, { prompt_tokens: data.usage?.input_tokens, completion_tokens: data.usage?.output_tokens, total_tokens: data.usage?.total_tokens }), 'Usage missing; reservation retained');
      assert.equal(data.model, cfg.llmModel); assert.equal(data.status, 'completed'); metric.status = 'ok';
      // Consume the upstream stream once for accounting, then pass its saved
      // terminal payload to the normal parser; do not depend on tee replay.
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: data })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    } catch (error) { metric.status = 'failed'; metric.error = error instanceof Error ? error.message : 'Call failed'; throw error; }
    finally { metric.ms = Date.now() - started; save(); }
  };
  try {
    report.status = 'running'; save();
    for (const row of report.results) {
      if (row.dynamic?.answer) continue;
      activeQuestion = row.index;
      const started = Date.now();
      const answer = await complete(parent.manifest.answerSystem, [{ role: 'user', content: JSON.stringify({ question: row.qa.question, historicalEvidence: row.supplement.context }) }], parent.manifest.answerMaxTokens);
      row.dynamic = { answer, evidence: { ...row.baselineDynamic.evidence, context: row.supplement.context,
        trace: { ...row.baselineDynamic.evidence.trace, usage: row.supplement.usage } }, retrievalMs: 0, answerMs: Date.now() - started };
      save(); console.log(`ANSWER ${report.results.filter((r: any) => r.dynamic?.answer).length}/50 q${row.index}; tokens=${report.requests.reduce((n: number, r: any) => n + r.chargedTokens, 0)}`);
    }
    assert.equal(sha(parentPath), sourceHashes.report); assert.equal(sha(dbPath), sourceHashes.database);
    report.status = 'completed'; report.sourceFilesUnchanged = true; save();
  } catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : 'Failed'; save(); throw error; }
  finally { globalThis.fetch = originalFetch; }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Failed'); process.exitCode = 1; });

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = resolve('artifacts/locomo-top8-linked-summaries-conv30-50-20261030');
const parent = resolve('artifacts/locomo-human-dialogue-conv30-50-v2-20261030');
const sourceTrial = resolve('artifacts/locomo-top4-sources8-conv30-50-20261030');
const load = (dir: string, name: string) => JSON.parse(readFileSync(resolve(dir, name), 'utf8'));
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const report = load(out, 'report.json'), old = load(parent, 'report.json');
const scores = load(out, 'scores.json'), oldScores = load(parent, 'scores.json');
const sourceScores = load(sourceTrial, 'scores.json');
const judge = load(out, 'semantic-judge/report.json'), oldJudge = load(parent, 'semantic-judge/report.json');
assert.equal(report.status, 'completed'); assert.equal(judge.status, 'completed');
assert.equal(report.manifest.frozenSource.report, hash(resolve(parent, 'report.json')));
assert.equal(report.manifest.frozenSource.database, hash(resolve(parent, 'dynamic.sqlite')));
assert.equal(report.manifest.queryVectorsSha256, hash(resolve(out, 'query-vectors.json')));
assert.equal(judge.manifest.sourceReportSha256, hash(resolve(out, 'report.json')));
assert.equal(judge.inheritedVerdicts.sourceJudgeReportSha256, hash(resolve(parent, 'semantic-judge/report.json')));
assert.ok(Object.entries(report.manifest.sourceCode).every(([p, h]) => hash(p) === h));
assert.equal(report.results.length, 50); assert.equal(report.requests.length, 50);
assert.ok(report.requests.every((r: any) => r.status === 'ok'));
const verdicts = (state: any) => {
  const map = new Map<string, any>();
  for (const v of Object.values(state.verdicts) as any[]) for (const ref of v.refs) map.set(`${ref.index}:${ref.arm}`, v);
  return map;
};
const beforeVerdicts = verdicts(oldJudge), afterVerdicts = verdicts(judge);
const metrics: any = {};
for (const [key, score, arm, verdict] of [
  ['summaryOnly', oldScores, 'dynamic', beforeVerdicts], ['linkedSummaries', scores, 'dynamic', afterVerdicts],
  ['top3', scores, 'raw3', afterVerdicts], ['top6', scores, 'raw', afterVerdicts],
] as const) {
  const rows = score.arms[arm].rows; assert.equal(rows.length, 50);
  const nonAbstention = rows.filter((r: any) => r.category !== 5);
  assert.ok(nonAbstention.every((r: any) => verdict.has(`${r.index}:${arm}`)));
  metrics[key] = { f1: score.arms[arm].f1Categories1to4, categories: score.arms[arm].categories,
    semanticCorrect: nonAbstention.filter((r: any) => verdict.get(`${r.index}:${arm}`).label === 'CORRECT').length,
    semanticCount: nonAbstention.length, abstention: score.arms[arm].categories['5'].mean };
}
const changed: any[] = [];
for (const row of report.results) {
  const original = old.results.find((r: any) => r.index === row.index);
  assert.deepEqual(row.qa, original.qa); assert.deepEqual(row.raw, original.raw); assert.deepEqual(row.raw3, original.raw3);
  assert.deepEqual(row.baselineDynamic, original.dynamic);
  assert.deepEqual(row.supplement.context.slice(0, original.dynamic.evidence.context.length), original.dynamic.evidence.context);
  assert.equal(new Set(row.supplement.context.map((e: any) => e.id)).size, row.supplement.context.length);
  assert.ok(row.supplement.context.every((e: any) => e.kind === 'summary'));
  assert.ok(row.supplement.seedIds.length <= 8);
  assert.ok(row.supplement.usage.chars <= original.dynamic.evidence.trace.policy.maxContextChars);
  assert.ok(row.supplement.usage.estimatedTokens <= original.dynamic.evidence.trace.policy.maxEstimatedTokens);
  if (row.qa.category !== 5) {
    const before = beforeVerdicts.get(`${row.index}:dynamic`), after = afterVerdicts.get(`${row.index}:dynamic`);
    if (before.label !== after.label) changed.push({ index: row.index, before: before.label, after: after.label,
      reason: after.reason, question: row.qa.question, oldAnswer: row.baselineDynamic.answer, newAnswer: row.dynamic.answer });
  }
}
const sum = (xs: any[], key: string) => xs.reduce((n, r) => n + (r[key] || 0), 0);
const usage = (xs: any[]) => ({ calls: xs.length, input: sum(xs, 'promptTokens'), output: sum(xs, 'completionTokens'),
  known: sum(xs, 'totalTokens'), unknownReserved: xs.filter(r => r.totalTokens === undefined).reduce((n, r) => n + r.chargedTokens, 0) });
const newUsage = usage(report.requests), judgeUsage = usage(judge.attempts);
const baselineUsage = usage(old.requests.filter((r: any) => r.phase === 'evaluate-dynamic' && r.kind === 'chat'));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const added = report.results.map((r: any) => r.supplement.selected.length);
const summary = {
  status: 'completed', sample: report.manifest.sample, questions: 50, firstFourQuestions: 37, model: report.manifest.chatModel,
  metrics, sourceSupplementF1: sourceScores.arms.dynamic.f1Categories1to4,
  officialF1ChangePoints: (metrics.linkedSummaries.f1 - metrics.summaryOnly.f1) * 100,
  semanticTransitions: changed, newAnswerUsage: newUsage, baselineAnswerUsage: baselineUsage,
  answerTokenRatio: newUsage.known / baselineUsage.known, newJudgeUsage: judgeUsage,
  reusedJudgeVerdicts: judge.inheritedVerdicts.count, newTokensTotal: newUsage.known + judgeUsage.known,
  unknownReserved: newUsage.unknownReserved + judgeUsage.unknownReserved,
  meanAddedSummaries: mean(added), minAddedSummaries: Math.min(...added), maxAddedSummaries: Math.max(...added),
  truncatedAddedSummaries: report.results.flatMap((r: any) => r.supplement.addedSummaries).filter((e: any) => e.truncated).length,
  meanEvidenceEstimatedTokensBefore: mean(old.results.map((r: any) => r.dynamic.evidence.trace.usage.estimatedTokens)),
  meanEvidenceEstimatedTokensAfter: mean(report.results.map((r: any) => r.supplement.usage.estimatedTokens)),
  baselineAndSourceUnchanged: true, recoveryEvents: report.recoveryEvents || [],
  limitations: ['Same 50 development questions and frozen old controls; single new generation, sampling variation not isolated.',
    'Only conv-30, 19 sessions/369 utterances, not full LoCoMo; F1 is not accuracy.',
    'Same-model independent blinded judging is supplementary, not human accuracy or strict official J-score reproduction.',
    'No bank rebuild or production integration. Expansion changes evidence volume; it does not isolate selection from volume effects.'],
};
writeFileSync(resolve(out, 'summary.json'), JSON.stringify(summary, null, 2));
const pct = (x: number) => (x * 100).toFixed(2) + '%';
const keys = ['summaryOnly', 'linkedSummaries', 'top3', 'top6'];
const lines = ['# Top8 同源摘要扩展：固定50题对照', '',
  '保留原15摘要，从前8条摘要沿全部原文ID查找关联热区摘要，全局ID去重，新增摘要按问题向量排序，沿用共享长度预算；不发送原文、不递归扩展。旧答案冻结，仅新增一组动态回答。', '',
  '|指标|原15摘要|Top8扩展摘要|普通Top3|普通Top6|', '|---|---:|---:|---:|---:|',
  `|官方F1，37题|${keys.map(k => pct(metrics[k].f1)).join('|')}|`,
  `|辅助语义判分，37题|${keys.map(k => metrics[k].semanticCorrect + '/37').join('|')}|`,
  `|官方弃答规则，13题|${keys.map(k => pct(metrics[k].abstention)).join('|')}|`,
  ...[1, 2, 4].map(c => `|类别${c} F1|${keys.map(k => pct(metrics[k].categories[c].mean)).join('|')}|`), '',
  `先前补原文组官方F1为${pct(summary.sourceSupplementF1)}，不是本次新生成的控制组。`, '',
  `平均新增${summary.meanAddedSummaries.toFixed(2)}条摘要，范围${summary.minAddedSummaries}～${summary.maxAddedSummaries}；新增截断${summary.truncatedAddedSummaries}条。`, '',
  `新答题${newUsage.known} token，原动态答题${baselineUsage.known} token，比例${summary.answerTokenRatio.toFixed(2)}。新增裁判${judgeUsage.calls}次/${judgeUsage.known} token；复用${summary.reusedJudgeVerdicts}个精确哈希判决。本次新增合计${summary.newTokensTotal} token；未知预留${summary.unknownReserved}，旧建库和控制组费用不重复累计。`, '',
  '题5曾发生本地响应流解析失败，已保存的终态响应完整成功且用量已知，直接恢复答案，没有再次请求。失败快照与transport-only迁移记录保留于report.stream-parser-failure.json和recovery-events.json。', '',
  '## 辅助语义判分变化', '', ...changed.flatMap(r => [`### 题${r.index}：${r.before} → ${r.after}`, '', r.question, '',
    `原：${r.oldAnswer}`, '', `新：${r.newAnswer}`, '', `理由：${r.reason}`, '']),
  '## 限制', '', ...summary.limitations.map(s => '- ' + s), '', '## 逐题对照', ''];
for (const row of report.results) {
  const lookup = (s: any, arm: string) => s.arms[arm].rows.find((r: any) => r.index === row.index).score;
  lines.push(`### 题${row.index} · 类别${row.qa.category}`, '', row.qa.question, '', `参考：${row.qa.answer ?? 'No information available'}`, '',
    `原动态：${row.baselineDynamic.answer}；官方分${pct(lookup(oldScores, 'dynamic'))}`, '',
    `新动态：${row.dynamic.answer}；官方分${pct(lookup(scores, 'dynamic'))}`, '',
    `Top6：${row.raw.answer}；官方分${pct(lookup(scores, 'raw'))}`, '', `新增摘要${row.supplement.selected.length}条。`, '');
}
writeFileSync(resolve(out, 'comparison.md'), lines.join('\n'));
console.log(JSON.stringify(summary, null, 2));

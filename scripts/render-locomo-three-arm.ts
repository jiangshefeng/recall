import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const dir = resolve(process.argv[2]);
const python = process.argv[3] || process.env.LOCOMO_PYTHON || "python";
const scored = spawnSync(python, ["scripts/score-locomo.py", resolve(dir, "report.json"), "artifacts/locomo-data/official-evaluation.py"],
  { encoding: "utf8", env: process.env, maxBuffer: 4_000_000 });
assert.equal(scored.status, 0, scored.stderr);
const report = JSON.parse(readFileSync(resolve(dir, "report.json"), "utf8"));
const scores = JSON.parse(readFileSync(resolve(dir, "scores.json"), "utf8"));
const arms = ["dynamic", "raw3", "raw"] as const;
const names = { dynamic: "动态 RAG", raw3: "普通 Top3", raw: "普通 Top6" };
type Scored = { index: number; category: number; score: number };
const rows = Object.fromEntries(arms.map(arm => [arm, scores.arms[arm].rows as Scored[]])) as Record<typeof arms[number], Scored[]>;
const common = rows.dynamic.map(r => r.index).filter(i => arms.every(a => rows[a].some(r => r.index === i)));
const average = (values: number[]) => values.length ? values.reduce((n, v) => n + v, 0) / values.length : null;
const pct = (v: number | null | undefined) => v == null ? "—" : `${(100 * v).toFixed(2)}%`;
const judgeFile = resolve(dir, "semantic-judge/report.json");
const judge = existsSync(judgeFile) ? JSON.parse(readFileSync(judgeFile, "utf8")) : undefined;
const semantic = new Map<string, { correct: boolean; reason: string }>();
if (judge) for (const value of Object.values(judge.verdicts) as any[]) for (const ref of value.refs)
  semantic.set(`${ref.index}:${ref.arm}`, { correct: value.label === "CORRECT", reason: value.reason });
const judged = common.filter(i => rows.dynamic.find(r => r.index === i)!.category !== 5 && arms.every(a => semantic.has(`${i}:${a}`)));
const categories = [1, 2, 3, 4, 5].map(category => {
  const indices = common.filter(i => rows.dynamic.find(r => r.index === i)!.category === category);
  return { category, count: indices.length, ...Object.fromEntries(arms.map(a => [a, average(rows[a].filter(r => indices.includes(r.index)).map(r => r.score))])) };
});
const metrics = Object.fromEntries(arms.map(a => [a, {
  completed: rows[a].length, missingOrErrors: report.results.length - rows[a].length,
  f1: average(rows[a].filter(r => common.includes(r.index) && r.category !== 5).map(r => r.score)),
  semanticScore: average(judged.map(i => Number(semantic.get(`${i}:${a}`)!.correct))),
  semanticCorrect: judged.filter(i => semantic.get(`${i}:${a}`)!.correct).length, semanticJudged: judged.length,
  meanEvidenceEntries: average(report.results.filter((r: any) => common.includes(r.index)).map((r: any) => r[a].evidence.context.length)),
  meanEvidenceEstimatedTokens: average(report.results.filter((r: any) => common.includes(r.index)).map((r: any) => r[a].evidence.trace.usage.estimatedTokens)),
}]));
const allRequests = [...report.requests, ...(judge?.attempts || []).map((r: any) => ({ ...r, kind: "chat" }))];
const phases: Record<string, { calls: number; input: number; output: number; known: number; unknownReserved: number }> = {};
for (const r of allRequests) {
  if (r.kind !== "chat") continue;
  const p = phases[r.phase] ||= { calls: 0, input: 0, output: 0, known: 0, unknownReserved: 0 };
  p.calls++; p.input += r.promptTokens || 0; p.output += r.completionTokens || 0;
  p.known += r.totalTokens || 0;
  if (r.totalTokens === undefined) p.unknownReserved += r.chargedTokens;
}
const sourceHash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const priorFile = resolve(dir, "prior-attempts.json");
const priorAttempts = existsSync(priorFile) ? JSON.parse(readFileSync(priorFile, "utf8")) : [];
let priorKnown = 0, priorUnknown = 0;
for (const prior of priorAttempts) {
  assert.equal(sourceHash(prior.reportPath), prior.sha256, "Prior attempt must remain archived unchanged");
  const old = JSON.parse(readFileSync(prior.reportPath, "utf8"));
  for (const request of old.requests) if (request.kind === "chat") {
    priorKnown += request.totalTokens || 0;
    if (request.totalTokens === undefined) priorUnknown += request.chargedTokens;
  }
}
const summary = { status: report.status, model: report.manifest.chatModel, sample: report.manifest.sample,
  fullHistory: report.manifest.benchmark, sessions: report.manifest.sessionCount,
  sourceTurns: report.manifest.turnCount, importedSourceTurns: new Set(report.ingestion.flatMap((r: any) => r.turnIds || [r.id])).size,
  records: report.ingestion.length, plannedRecords: report.manifest.ingestion?.records || report.manifest.turnCount,
  completeTriples: common.length, plannedQuestions: report.results.length, firstFourQuestions: common.filter(i => rows.dynamic.find(r => r.index === i)!.category !== 5).length,
  metrics, categories, stats: report.stats, phases,
  partialWrites: report.ingestion.filter((r: any) => r.action === "partial").map((r: any) => ({ id: r.id, message: r.message, diagnostics: r.diagnostics })),
  recoveryEvents: report.recoveryEvents || [],
  unknownRequests: allRequests.filter((r: any) => r.kind === "chat" && r.totalTokens === undefined).map((r: any) => ({ phase: r.phase, status: r.status, reserved: r.chargedTokens })),
  skippedRecords: report.ingestion.filter((r: any) => r.action === "skipped").length,
  activeMemoryKinds: report.memories?.filter((m: any) => m.status === "hot").reduce((o: any, m: any) => { o[m.kind] = (o[m.kind] || 0) + 1; return o; }, {}),
  currentRunKnownTokens: Object.values(phases).reduce((n, p) => n + p.known, 0), currentRunUnknownReserved: Object.values(phases).reduce((n, p) => n + p.unknownReserved, 0),
  priorAttempts, priorKnownTokens: priorKnown, priorUnknownReserved: priorUnknown,
  knownTokens: priorKnown + Object.values(phases).reduce((n, p) => n + p.known, 0), unknownReserved: priorUnknown + Object.values(phases).reduce((n, p) => n + p.unknownReserved, 0),
  judgeStatus: judge?.status || "not_run", judgeUniqueVerdicts: judge ? Object.keys(judge.verdicts).length : 0,
  judgeMissingOrFailedQuestions: common.filter(i => rows.dynamic.find(r => r.index === i)!.category !== 5 && !judged.includes(i)).length,
  sourceHashesMatch: Object.entries(report.manifest.sourceCode).every(([file, sha]) => sourceHash(file) === sha),
  officialScoring: scores.scoringVersions, note: "F1 is not accuracy. Semantic judging is supplementary, single-pass, same model in separate blinded calls; not human accuracy or exact official J-score reproduction." };
writeFileSync(resolve(dir, "summary.json"), JSON.stringify(summary, null, 2));
const lines = ["# 历史人物对话导入：LoCoMo 三组对照", "",
  `状态：${report.status}；模型：${summary.model}；样本：${summary.sample}，${summary.sessions}次完整会话、${summary.sourceTurns}条原始发言。`, "",
  `从空库写入${summary.records}/${summary.plannedRecords}个对话片段，覆盖${summary.importedSourceTurns}条不同原始发言；完成${common.length}/${summary.plannedQuestions}道三组共同题。`, "",
  "| 指标 | 动态 RAG | 普通 Top3 | 普通 Top6 |", "|---|---:|---:|---:|",
  `| 官方前四类 F1（${summary.firstFourQuestions}题） | ${arms.map(a => pct(metrics[a].f1)).join(" | ")} |`,
  `| 补充语义判分（${judged.length}题） | ${arms.map(a => `${pct(metrics[a].semanticScore)}（${metrics[a].semanticCorrect}/${judged.length}）`).join(" | ")} |`,
  ...categories.map(c => `| 类别${c.category}${c.category === 5 ? "弃答规则" : " F1"}（${c.count}题） | ${arms.map(a => pct((c as any)[a])).join(" | ")} |`), "",
  "F1为未修改的官方类别评分函数，不能称为准确率。第五类弃答规则分单列。语义判分使用当前同一模型的独立盲测调用，按语义允许同义表达和日期格式差异，仍有裁判偏差；不是人工正确率或严格官方J-score复现。", "",
  "## 导入和对照条件", "",
  `- 动态导入模式：${report.manifest.ingestion?.sourceType || "single-utterance"}。两个字段保留带姓名的人物原话；不是将一位人物当成AI。目标1600字符、不跨会话，边界重叠一条发言；片段不等于推断出的问答配对。`,
  "- 两个字段中的明确事实都可提取，无事实时只保存原文，不生成占位问答。片段最多20条事实，事实拆分、合并、向量及检索使用当前代码。",
  "- 原文记录与原始发言不是一一对应，来源映射保留全部原始发言ID。阶段阈值5按关联的写入片段数计算，不能等同旧测试的5条发言。来源ID覆盖不证明信息在摘要中完整保留。",
  `- 普通RAG原文分块目标1400字符，共${report.manifest.ordinaryRag.chunkCount}块，单轮向量Top3/Top6；动态两轮合计最多15条摘要，阈值${report.manifest.minScore}，原文与阶段摘要不送入回答。`,
  `- 本轮动态策略（以运行清单为准）：${report.manifest.dynamicRag}`,
  "- 三组相同原始历史、回答模型、查询向量、回答提示词和最终证据预算，实际输入长度不同。答案不回写，标准答案和参考证据仅在本地评分及裁判阶段使用。",
  "- 题号按类别容量分配后类内等距选择，在调用前固定；这是一段完整对话上的小样本，不是全量LoCoMo或严格未见集。对比历史结果须核对题号、导入方式、源码和生成参数；重新建库与模型生成也有波动，不能把变化全部归因于单个改动。", "",
  `实际库统计：${JSON.stringify(report.stats)}；热区类型：${JSON.stringify(summary.activeMemoryKinds)}；partial写入${summary.partialWrites.length}条；无事实跳过索引${summary.skippedRecords}条。`, "",
  "## Token", "", "| 阶段 | 调用 | 输入 | 输出 | 未知预留 |", "|---|---:|---:|---:|---:|",
  ...Object.entries(phases).map(([phase, p]) => `| ${phase} | ${p.calls} | ${p.input} | ${p.output} | ${p.unknownReserved} |`), "",
  `当前正式运行及裁判已知${summary.currentRunKnownTokens.toLocaleString("en-US")} token；当前未知预留${summary.currentRunUnknownReserved.toLocaleString("en-US")}。`, "",
  `另保留停止的适配验证尝试：已知${priorKnown.toLocaleString("en-US")} token，未知用量预留${priorUnknown.toLocaleString("en-US")}；不会作为零消耗或并入成绩。所有本次尝试及裁判合计已知${summary.knownTokens.toLocaleString("en-US")} token，未知预留${summary.unknownReserved.toLocaleString("en-US")}。本地向量另计请求，不消耗云端聊天token。`, "",
  ...(report.error ? [`评测异常：${report.error}`, ""] : []),
  ...summary.partialWrites.flatMap((p: any) => [`partial ${p.id}：${p.message}`, ""]),
  ...summary.recoveryEvents.flatMap((e: any) => [`恢复记录：请求${e.requestIndex}未知用量预留${e.unknownReserved}；${e.action}。原报告已归档，没有重试该请求，继续后续片段。`, ""]),
  ...(judge?.error ? [`裁判异常：${judge.error}`, ""] : []),
  "## 逐题回答", ""];
for (const row of report.results) {
  lines.push(`### 题${row.index} · 类别${row.qa.category}`, "", row.qa.question, "", `参考：${row.qa.answer ?? "No information available"}`, "");
  for (const a of arms) {
    const score = rows[a].find(r => r.index === row.index)?.score;
    const verdict = semantic.get(`${row.index}:${a}`);
    lines.push(`${names[a]}：${row[a]?.answer ?? row[a]?.error ?? "未完成"}`, "",
      `官方分：${pct(score)}；语义：${verdict ? `${verdict.correct ? "CORRECT" : "WRONG"} — ${verdict.reason}` : row.qa.category === 5 ? "使用官方弃答规则" : "未评分"}`, "");
  }
}
writeFileSync(resolve(dir, "results.md"), lines.join("\n"));
const memories = ["# 本轮实际摘要", "", "数据库原文，未重新生成；按记忆状态分组。", ""];
for (const status of ["hot", "cold"]) {
  const group = report.memories?.filter((m: any) => m.status === status) || [];
  memories.push(`## ${status}（${group.length}条）`, "");
  for (const [i, m] of group.entries()) memories.push(`### ${i + 1}. ${m.kind} · 关联${m.sourceIds.length}个片段`, "", m.summary, "", `ID：${m.id}`, "");
}
writeFileSync(resolve(dir, "memory-summaries.md"), memories.join("\n"));
console.log(JSON.stringify(summary, null, 2));

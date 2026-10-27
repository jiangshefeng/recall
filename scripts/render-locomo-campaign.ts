// Offline scoring only. Never calls a language model or combines different chat models.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(process.env.LOCOMO_CAMPAIGN || "artifacts/locomo-deepseek-v4-pro-0813-3plus3");
const python = process.env.LOCOMO_PYTHON || "C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe";
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const plan = read(resolve(root, "plan.json")), runs = read(resolve(root, "runs.json"));
const arms = ["dynamic", "raw3", "raw"] as const;
type Arm = typeof arms[number];
type Score = { index: number; category: number; score: number; question: string; gold: string | number; answer: string };
type Row = { sample: string; originalIndex: number; category: number; repetition?: number; scores: Record<Arm, Score> };
const avg = (xs: number[]) => xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : null;
const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
const pct = (x: number | null) => x === null ? "—" : `${(x * 100).toFixed(1)}%`;
function scoreThree(report: any, dir: string): Row[] {
  const maps: Partial<Record<Arm, Map<number, Score>>> = {};
  for (const rawArm of ["raw3", "raw"] as const) {
    const path = resolve(dir, `score-${rawArm}`); mkdirSync(path, { recursive: true });
    const projection = { status: report.status, manifest: { sample: report.manifest.sample || "repeat" }, results: report.results.map((r: any, i: number) => ({ index: i, qa: r.qa, dynamic: r.dynamic, raw: r[rawArm] })) };
    const file = resolve(path, "report.json"); writeFileSync(file, JSON.stringify(projection, null, 2));
    const proc = spawnSync(python, ["scripts/score-locomo.py", file, "artifacts/locomo-data/official-evaluation.py"], { encoding: "utf8", windowsHide: true, env: { ...process.env, LOCOMO_PYTHON_PACKAGES: resolve("artifacts/locomo-tools") } });
    if (proc.status !== 0) throw Error(proc.stderr || proc.stdout || "Official scorer failed");
    const scored = read(resolve(path, "scores.json"));
    maps[rawArm] = new Map(scored.arms.raw.rows.map((r: Score) => [r.index, r]));
    maps.dynamic = new Map(scored.arms.dynamic.rows.map((r: Score) => [r.index, r]));
  }
  return report.results.flatMap((r: any, i: number) => arms.every(a => maps[a]?.has(i)) ? [{ sample: r.sample || report.manifest.sample, originalIndex: r.index, category: r.qa.category, repetition: r.repetition, scores: Object.fromEntries(arms.map(a => [a, maps[a]!.get(i)!])) as Record<Arm, Score> }] : []);
}
function metrics(rows: Row[]) {
  return { questions: rows.length, f1Questions: rows.filter(r => r.category !== 5).length,
    f1: Object.fromEntries(arms.map(a => [a, avg(rows.filter(r => r.category !== 5).map(r => r.scores[a].score))])) as Record<Arm, number | null>,
    categories: [1, 2, 3, 4, 5].map(c => ({ category: c, n: rows.filter(r => r.category === c).length, scores: Object.fromEntries(arms.map(a => [a, avg(rows.filter(r => r.category === c).map(r => r.scores[a].score))])) as Record<Arm, number | null> })) };
}
const reports = runs.filter((r: any) => existsSync(resolve(r.out, "report.json"))).map((r: any) => ({ ...r, report: read(resolve(r.out, "report.json")) }));
for (const { report } of reports) {
  assert.equal(report.manifest.chatModel, plan.model);
  assert.equal(report.manifest.policy.firstLimit, 3); assert.equal(report.manifest.policy.secondLimit, 3);
  assert.equal(report.manifest.policy.sourceCandidatesPerMemory, 4); assert.equal(report.manifest.policy.sourceLimitPerMemory, 2);
  assert.equal(report.manifest.stageSourceThreshold, 5);
}
const rows: Row[] = reports.flatMap((r: any) => scoreThree(r.report, r.out));
assert.equal(new Set(rows.map(r => `${r.sample}:${r.originalIndex}`)).size, rows.length);
const repeatPath = resolve(root, "repeat/report.json");
const repeat = existsSync(repeatPath) ? read(repeatPath) : undefined;
const repeated = repeat ? scoreThree(repeat, resolve(root, "repeat")) : [];
const preflight = read(resolve(root, "preflight.json"));
const requests = [...reports.flatMap((r: any) => r.report.requests), ...(repeat?.requests || [])].filter((r: any) => r.kind === "chat");
const chargedTokens = preflight.attempt.chargedTokens + sum(requests.map((r: any) => r.chargedTokens));
assert.ok(chargedTokens <= plan.tokenCap);
const phases = [...new Set(requests.map((r: any) => r.phase))].map(phase => {
  const subset = requests.filter((r: any) => r.phase === phase);
  return { phase, calls: subset.length, input: sum(subset.map((r: any) => r.promptTokens || 0)), output: sum(subset.map((r: any) => r.completionTokens || 0)), charged: sum(subset.map((r: any) => r.chargedTokens)) };
});
const bySample = reports.map((r: any) => ({ sample: r.sample, sessions: r.report.manifest.sessionCount, turns: r.report.ingestion.length, chunks: r.report.manifest.ordinaryRag.chunkCount, stages: r.report.stats?.uniqueActiveStages,
  partials: r.report.ingestion.filter((x: any) => x.action === "partial").length, status: r.report.status, plannedQuestions: r.report.results.length, ...metrics(rows.filter(x => x.sample === r.sample)) }));
const repeatMetrics = [...new Set(repeated.map(r => r.repetition))].map(repetition => {
  const subset = repeated.filter(r => r.repetition === repetition);
  const originals = subset.flatMap(r => rows.filter(x => x.sample === r.sample && x.originalIndex === r.originalIndex));
  return { repetition, ...metrics(subset), originalSameSubset: metrics(originals), exactAnswerMatches: Object.fromEntries(arms.map(a => [a, subset.filter(r => rows.find(x => x.sample === r.sample && x.originalIndex === r.originalIndex)?.scores[a].answer === r.scores[a].answer).length])) };
});
const partialDetails = reports.flatMap((r: any) => r.report.ingestion.filter((x: any) => x.action === "partial").map((x: any) => ({ sample: r.sample, id: x.id, message: x.message, diagnostics: x.diagnostics })));
const summary = { model: plan.model, generatedAt: new Date().toISOString(), unique: metrics(rows), bySample, repeatTriplets: repeated.length, repeatMetrics, partialDetails,
  chargedTokens, tokenCap: plan.tokenCap, remainingTokens: plan.tokenCap - chargedTokens, phases, preflightTokens: preflight.attempt.chargedTokens,
  abnormalRequests: requests.filter((r: any) => r.status !== "ok"), requestsWithoutUsage: requests.filter((r: any) => r.totalTokens === undefined).length,
  limitation: "Short continuous prefixes; not full LoCoMo. F1 is not accuracy. Model and retrieval both changed versus previous Qwen tests. Repeats excluded from unique scores." };
writeFileSync(resolve(root, "summary.json"), JSON.stringify(summary, null, 2));
const table = (m: ReturnType<typeof metrics>) => `| ${m.questions}（F1 ${m.f1Questions}） | ${pct(m.f1.dynamic)} | ${pct(m.f1.raw3)} | ${pct(m.f1.raw)} |`;
const names = ["多跳", "时间", "开放域", "单事实", "对抗题弃答规则分"];
const lines = ["# LoCoMo 三组对照：3+3 / 最近2条 / 阶段阈值5", "", `模型：${plan.model}；本地向量：qwen3-embedding:0.6b。更新时间：${summary.generatedAt}。`, "",
  "| 完整三组题数 | 动态 RAG F1 | 普通 Top3 F1 | 普通 Top6 F1 |", "|---|---:|---:|---:|", table(summary.unique), "",
  "按官方前四类逐题F1平均；F1不是正确率。只合并三组都回答的共同独立题，第五类单列。重复题不计入上表。", "",
  "| 对话 | 完整会话数 | 原文条数 / 块数 | 独立题数 | 动态 F1 | Top3 F1 | Top6 F1 |", "|---|---:|---:|---:|---:|---:|---:|",
  ...bySample.map((r: any) => `| ${r.sample} | ${r.sessions} | ${r.turns} / ${r.chunks} | ${r.questions} | ${pct(r.f1.dynamic)} | ${pct(r.f1.raw3)} | ${pct(r.f1.raw)} |`), "",
  "| 类型 | 题数 | 动态 | Top3 | Top6 |", "|---|---:|---:|---:|---:|", ...summary.unique.categories.map(c => `| ${names[c.category - 1]} | ${c.n} | ${pct(c.scores.dynamic)} | ${pct(c.scores.raw3)} | ${pct(c.scores.raw)} |`), "",
  `已计入 ${chargedTokens.toLocaleString("en-US")} / ${plan.tokenCap.toLocaleString("en-US")} token，包括建库、回答、预检及重复测试。实际免费额度抵扣以百炼控制台为准。`, "",
  "| 阶段 | 请求数 | 输入 token | 输出 token | 计入预算 |", "|---|---:|---:|---:|---:|", `| 独立接口预检 | 1 | ${preflight.attempt.promptTokens} | ${preflight.attempt.completionTokens} | ${preflight.attempt.chargedTokens} |`, ...phases.map(p => `| ${p.phase} | ${p.calls} | ${p.input} | ${p.output} | ${p.charged} |`), "",
  ...bySample.map((r: any) => `- ${r.sample}：${r.status}，完成 ${r.questions}/${r.plannedQuestions} 题；partial ${r.partials} 条，活动阶段摘要 ${r.stages ?? "尚未统计"}。`),
  `- 异常聊天请求 ${summary.abnormalRequests.length}；未取得用量的请求 ${summary.requestsWithoutUsage}。`, "",
  "partial并非接口报错：前两批5条导入存在模型返回无效候选编号，相关操作被拦截并保留原文；第三批2条是多个事实选择同一个旧目标，冲突事实保留独立摘要。完整诊断见summary.json的partialDetails。唯一活动阶段摘要覆盖5条原文，完整关联仍保留。", "",
  "## 重复回答（单列）", "", `共 ${repeated.length} 道重复三组对照，复用固定证据，不重新建库，不增加独立题数。`, "",
  ...repeatMetrics.map(r => `- 第${r.repetition}轮 ${r.questions} 题：动态 ${pct(r.f1.dynamic)}，Top3 ${pct(r.f1.raw3)}，Top6 ${pct(r.f1.raw)}；相同子集首次分别 ${pct(r.originalSameSubset.f1.dynamic)}、${pct(r.originalSameSubset.f1.raw3)}、${pct(r.originalSameSubset.f1.raw)}。`), "",
  "## 测试范围与限制", "",
  "每批从头建独立动态库和普通原文库，不写生产数据库。动态检索3+3，每条记忆最多4个原文候选、默认送最近2条，完整关联保留；未被阶段摘要覆盖的原文达到5条触发阶段压缩。普通组1400字符分块，重叠一条完整发言，单轮向量Top3/Top6，无摘要和二跳。三组聊天模型、回答提示词、temperature=0、关闭thinking和最终证据预算一致；动态原文可带前6条上下文。", "",
  "按预先固定的会话顺序和参考证据范围选题，没有按预测成绩删题。只取短历史前缀，原文块少，Top6可能接近全文；不能代表长历史或全量LoCoMo。部分题在之前的Qwen测试中用过。本次同时换了模型和检索配置，不能将跨轮分数变化直接归因于参数修改。官方词匹配F1受数字、词形、额外名字影响，上游参考证据也可能有误，需结合原始答案阅读。", "",
  "## 具体失分与评分案例", "",
  "- conv-48 题18（Seraphim在哪里买）：原文D2:24是“I bought it a year ago in Paris.”，本轮存储的摘要为“Jolene bought the item being discussed a year ago in Paris.”，缺少Seraphim实体名。该问的动态证据没有包含这条原文，动态弃答，普通组回答France。这说明代词未消解、摘要缺少可检索实体是实际问题；不能单凭此例将失分归因于最近2条上限。",
  "- conv-48 题17（何时购买Seraphim）：动态证据的历史上下文中实际上包含“a year ago in Paris”，但回答成会话日期January 27, 2023；普通组回答January 2022。这里还存在模型对相对时间的读取错误。",
  "- conv-48 题12：动态回答January 26, 2023得1分，普通两组回答2023-01-26得0分，日期相同，差异来自官方词匹配评分。题6三组都提到pendant，但参考仅为pendants，额外描述拉低分数。保留官方原分，同时避免把所有分差解读成事实正确性差异。", "",
  "## 逐题结果", ""];
for (const r of rows) lines.push(`### ${r.sample} · 题 ${r.originalIndex}`, "", r.scores.dynamic.question, "", `参考：${r.scores.dynamic.gold}`, "", ...arms.flatMap(a => [`${a === "dynamic" ? "动态" : a === "raw3" ? "普通 Top3" : "普通 Top6"}：${r.scores[a].answer}（${pct(r.scores[a].score)}）`, ""]));
writeFileSync(resolve(root, "comparison.md"), lines.join("\n"));
console.log(JSON.stringify({ unique: summary.unique, bySample, chargedTokens, repeatTriplets: repeated.length, abnormalRequests: summary.abnormalRequests.length }, null, 2));

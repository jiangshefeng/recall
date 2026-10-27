// Offline: score using unchanged official functions, then combine unique questions.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve("artifacts/locomo-extra-max0902");
const python = process.argv[2] || process.env.LOCOMO_PYTHON || "python";
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const plan = read(resolve(root, "plan.json"));
const arms = ["dynamic", "raw3", "raw"] as const;
type Arm = typeof arms[number];
type Score = { index: number; category: number; score: number; question: string; gold: string | number; answer: string };
type Row = { sample: string; originalIndex: number; category: number; scores: Record<Arm, Score> };
const avg = (xs: number[]) => xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : null;
const pct = (n: number | null) => n === null ? "—" : `${(n * 100).toFixed(1)}%`;
const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
const score = (reportPath: string) => {
  const child = spawnSync(python, ["scripts/score-locomo.py", reportPath, "artifacts/locomo-data/official-evaluation.py"], { encoding: "utf8", env: process.env });
  if (child.status !== 0) throw Error(child.stderr || child.stdout || "Official scorer failed");
  return read(resolve(reportPath, "..", "scores.json"));
};
function scoreThree(report: any, dir: string) {
  const scorePath = resolve(dir, "score-top3"); mkdirSync(scorePath, { recursive: true });
  const projection = { status: report.status, manifest: { sample: report.manifest.sample || "repeat" }, results: report.results.map((r: any, i: number) => ({ index: i, qa: r.qa, dynamic: r.dynamic, raw: r.raw3 })) };
  writeFileSync(resolve(scorePath, "report.json"), JSON.stringify(projection, null, 2));
  const top3 = score(resolve(scorePath, "report.json"));
  const sixPath = resolve(dir, "score-top6"); mkdirSync(sixPath, { recursive: true });
  projection.results = report.results.map((r: any, i: number) => ({ index: i, qa: r.qa, dynamic: r.dynamic, raw: r.raw }));
  writeFileSync(resolve(sixPath, "report.json"), JSON.stringify(projection, null, 2));
  const top6 = score(resolve(sixPath, "report.json"));
  const maps: Record<Arm, Map<number, Score>> = {
    dynamic: new Map(top6.arms.dynamic.rows.map((r: Score) => [r.index, r])),
    raw3: new Map(top3.arms.raw.rows.map((r: Score) => [r.index, r])),
    raw: new Map(top6.arms.raw.rows.map((r: Score) => [r.index, r])),
  };
  return report.results.flatMap((r: any, i: number) => {
    if (!arms.every(a => maps[a].has(i))) return [];
    return [{ sample: r.sample || report.manifest.sample, originalIndex: r.index, category: r.qa.category,
      repetition: r.repetition, scores: Object.fromEntries(arms.map(a => [a, maps[a].get(i)!])) }];
  }) as (Row & { repetition?: number })[];
}
function metrics(rows: Row[]) {
  return { questions: rows.length, f1Questions: rows.filter(r => r.category !== 5).length,
    f1: Object.fromEntries(arms.map(a => [a, avg(rows.filter(r => r.category !== 5).map(r => r.scores[a].score))])),
    categories: [1, 2, 3, 4, 5].map(c => ({ category: c, n: rows.filter(r => r.category === c).length,
      ...Object.fromEntries(arms.map(a => [a, avg(rows.filter(r => r.category === c).map(r => r.scores[a].score))])) as Record<Arm, number | null> })) };
}
const oldDir = resolve("artifacts/locomo-plain-rag-max0902-conv48-s2");
const oldSix = read(resolve(oldDir, "scores.json")), oldThree = read(resolve(oldDir, "ordinary-top3/scores.json"));
const oldRows: Row[] = oldSix.arms.dynamic.rows.map((d: Score) => ({ sample: "conv-48", originalIndex: d.index, category: d.category, scores: {
  dynamic: d, raw: oldSix.arms.raw.rows.find((r: Score) => r.index === d.index), raw3: oldThree.arms.raw.rows.find((r: Score) => r.index === d.index),
} }));
assert.ok(oldRows.every(r => arms.every(a => r.scores[a])));
const reports = plan.samples.filter((s: any) => existsSync(resolve(s.out, "report.json"))).map((s: any) => ({ sample: s.sample, out: resolve(s.out), report: read(resolve(s.out, "report.json")) }));
const fresh: Row[] = reports.flatMap((r: any) => scoreThree(r.report, r.out));
const rows = [...oldRows, ...fresh];
const repeatedPath = resolve(root, "repeat/report.json");
const repeat = existsSync(repeatedPath) ? read(repeatedPath) : undefined;
const repeated = repeat ? scoreThree(repeat, resolve(root, "repeat")) : [];
const additionalTokens = sum(reports.map((r: any) => sum(r.report.requests.map((x: any) => x.chargedTokens)))) + (repeat ? sum(repeat.requests.map((x: any) => x.chargedTokens)) : 0);
assert.ok(additionalTokens <= plan.additionalTokenCap, "Shared additional budget exceeded");
const bySample = ["conv-48", ...plan.samples.map((s: any) => s.sample)].map(sample => ({ sample, ...metrics(rows.filter(r => r.sample === sample)) }));
const repeatedRuns = [...new Set(repeated.map(r => r.repetition))].map(repetition => {
  const subset = repeated.filter(r => r.repetition === repetition);
  const originals = subset.flatMap(r => { const original = fresh.find(f => f.sample === r.sample && f.originalIndex === r.originalIndex); return original ? [original] : []; });
  return { repetition, ...metrics(subset), originalSameSubset: metrics(originals), exactAnswerMatches: Object.fromEntries(arms.map(arm => [arm, {
    same: subset.filter(r => fresh.find(f => f.sample === r.sample && f.originalIndex === r.originalIndex)?.scores[arm].answer === r.scores[arm].answer).length,
    total: subset.length,
  }])) };
});
const phases = ["preflight", "dynamic-ingest", "evaluate-dynamic", "evaluate-raw3", "evaluate-raw"].map(phase => {
  const requests = reports.flatMap((r: any) => r.report.requests.filter((q: any) => q.kind === "chat" && q.phase === phase));
  return { phase, calls: requests.length, tokens: sum(requests.map((r: any) => r.chargedTokens)) };
});
const summary = { model: plan.model, fresh: metrics(fresh), combinedUnique: metrics(rows), bySample,
  additionalTokens, additionalTokenCap: plan.additionalTokenCap, previousTokens: plan.previousTotal, allTokens: plan.previousTotal + additionalTokens,
  repeatedRuns, repeatTriplets: repeated.length, phases, reports: reports.map((r: any) => ({ sample: r.sample, status: r.report.status,
    plannedQuestions: r.report.results.length, completeTriplets: fresh.filter(f => f.sample === r.sample).length,
    sessions: r.report.manifest.sessionCount, chunks: r.report.manifest.ordinaryRag.chunkCount,
    ingestion: r.report.ingestion.length, plannedTurns: r.report.manifest.turnCount, partialWrites: r.report.ingestion.filter((x: any) => x.action === "partial").length,
    stages: r.report.stats?.uniqueActiveStages, errors: r.report.requests.filter((x: any) => x.kind === "chat" && x.status !== "ok").length })) };
writeFileSync(resolve(root, "summary.json"), JSON.stringify(summary, null, 2));
const table = (m: ReturnType<typeof metrics>) => `| ${m.questions} 题，其中 ${m.f1Questions} 题计 F1 | ${pct(m.f1.dynamic)} | ${pct(m.f1.raw3)} | ${pct(m.f1.raw)} |`;
const names = ["多跳", "时间", "开放域", "单事实", "对抗题弃答规则分"];
const lines = ["# LoCoMo 追加测试：动态 RAG 与普通 RAG", "", `模型：${plan.model}；本地向量：qwen3-embedding:0.6b。新增样本顺序、选题和三组对照均在调用前固定。`, "",
  "## 结果", "", "| 范围 | 动态 RAG | 普通 Top3 | 普通 Top6 |", "|---|---:|---:|---:|", table(summary.fresh), "",
  "上表只含本轮新增且三组都有结果的独立题目。加上上一轮，去重汇总如下：", "", "| 范围 | 动态 RAG | 普通 Top3 | 普通 Top6 |", "|---|---:|---:|---:|", table(summary.combinedUnique), "",
  "F1 为官方类别评分的按题数加权结果，不是正确率；第五类独立报告。同题重复回答不增加独立题数。", "",
  "| 对话 | 独立题数 | 动态 F1 | Top3 F1 | Top6 F1 |", "|---|---:|---:|---:|---:|",
  ...bySample.map(s => `| ${s.sample} | ${s.questions} | ${pct(s.f1.dynamic)} | ${pct(s.f1.raw3)} | ${pct(s.f1.raw)} |`), "",
  "| 合并后题型 | 题数 | 动态 | Top3 | Top6 |", "|---|---:|---:|---:|---:|",
  ...summary.combinedUnique.categories.map(c => `| ${names[c.category - 1]} | ${c.n} | ${pct(c.dynamic)} | ${pct(c.raw3)} | ${pct(c.raw)} |`), "",
  "## 调用与预算", "", `本轮新增 ${additionalTokens.toLocaleString("en-US")} / ${plan.additionalTokenCap.toLocaleString("en-US")} token；上轮 ${plan.previousTotal.toLocaleString("en-US")}；累计 ${summary.allTokens.toLocaleString("en-US")}。输入和输出均计数，包含动态建库和重复测试。免费额度实际抵扣以百炼账单为准。`, "",
  "| 新样本阶段 | 调用次数 | token |", "|---|---:|---:|", ...phases.map(p => `| ${p.phase} | ${p.calls} | ${p.tokens} |`),
  ...(repeat ? [`| 复用证据的重复回答 | ${repeat.requests.length} | ${sum(repeat.requests.map((r: any) => r.chargedTokens))} |`] : []), "",
  ...summary.reports.map((r: any) => `- ${r.sample}：${r.status}，${r.sessions} 次完整会话、原文 ${r.chunks} 块；导入 ${r.ingestion}/${r.plannedTurns} 条，完成 ${r.completeTriplets}/${r.plannedQuestions} 道三组对照；partial ${r.partialWrites} 条，聊天请求异常 ${r.errors} 次，活动阶段摘要 ${r.stages ?? "未知"}。`), "",
  ...(plan.amendments?.length ? ["预算调整：第一段花费 371,126 token 后，在第二段任何调用之前，将其范围由两次完整会话缩为一次，所有该范围内符合条件的题目仍按原规则选择。原始计划保存在 initial-plan.json，调整及时间保存在 plan.json；没有依据第二段成绩缩题。", ""] : []),
  "## 重复测试（单列）", "", `完整重复答题共 ${repeated.length} 组三组对照，复用新样本的固定证据和数据库，未重新提取/合并记忆。`, "",
  ...repeatedRuns.map(r => `- 重复第 ${r.repetition} 轮：${r.questions} 题；动态 ${pct(r.f1.dynamic)}，Top3 ${pct(r.f1.raw3)}，Top6 ${pct(r.f1.raw)}。相同子集首次得分依次为 ${pct(r.originalSameSubset.f1.dynamic)}、${pct(r.originalSameSubset.f1.raw3)}、${pct(r.originalSameSubset.f1.raw)}；文字完全相同的答案依次为 ${r.exactAnswerMatches.dynamic.same}/${r.questions}、${r.exactAnswerMatches.raw3.same}/${r.questions}、${r.exactAnswerMatches.raw.same}/${r.questions}，不等同于语义一致率。${r.questions < fresh.length ? "预算只覆盖部分题，不能直接与完整新样本均分比较。" : ""}`), "",
  "## 值得关注的案例", "",
  "- conv-30 题7（广告发布日期）：动态和Top6均回答29 January 2023，Top3弃答。说明动态检索在部分题目上能比仅取三块原文找到更多有效信息。",
  "- conv-30 题83（对抗题，询问Jon最喜欢的舞蹈回忆）：动态和Top6均回答舞团比赛获第一名，官方预期弃答。提到一次比赛经历不足以确认它是最喜欢的回忆，需要控制这类过度推断。",
  "- conv-49 题4（问Sam在2023年5月开始了什么爱好）：动态回答Painting获得满分，两个普通组弃答。但D1:11只说正在考虑尝试绘画，不能充分证明已经开始。保留官方原分，同时不能把这道得分优势当成可靠的事实推理提升。",
  "- conv-49 题3：三组均回答数字2，参考答案是英文two，官方词语F1均为0。这类评分差异不代表事实答错。", "",
  "## 解释边界", "", "普通 RAG 使用原文连续分块、单轮余弦检索；动态使用正式记忆提取、合并、冷热存储和条件二跳。三组共用聊天模型、回答提示词和最终证据预算，实际输入长度不同。动态原文可以带前六条上下文，普通组仅原文块。", "",
  "每段仅取前一或两次完整会话，普通索引块数很少，Top6 接近全文；conv-49 只有两块，因此 Top3 和 Top6 实际提供相同范围的原文。没有覆盖完整长期历史，阶段摘要是否发生见上方统计。参考证据筛选依赖上游标注，不能保证没有错误；没有按成绩删题或修改官方评分。短语表达、额外实体名和时间格式会影响 F1，需结合原始答案解读。结果只说明这些样本，不能推广为产品排名。", "",
  "## 全部独立题逐题对照", ""];
for (const r of rows) {
  lines.push(`### ${r.sample} · 题 ${r.originalIndex}`, "", r.scores.dynamic.question, "", `参考：${r.scores.dynamic.gold}`, "",
    `动态：${r.scores.dynamic.answer}（${pct(r.scores.dynamic.score)}）`, "", `普通 Top3：${r.scores.raw3.answer}（${pct(r.scores.raw3.score)}）`, "", `普通 Top6：${r.scores.raw.answer}（${pct(r.scores.raw.score)}）`, "");
}
writeFileSync(resolve(root, "comparison.md"), lines.join("\n"));
console.log(JSON.stringify(summary, null, 2));

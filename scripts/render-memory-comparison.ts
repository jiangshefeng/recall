import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Grades are a separately reviewed artifact, never inferred from keyword matches.
type Grade = { id: string; repeat: number; baseline: boolean; rag: boolean; reason: string };
type Arm = { answer: string; answerMs: number; retrievalMs: number; error?: string };
type Entry = { id: string; repeat: number; baseline: Arm; rag: Arm; evidenceEstimatedTokens: number;
  evidence: { context: unknown[]; first: { summary: string; score: number }[]; second: { summary: string; score: number }[] } };
const dir = resolve(process.argv[2] || "");
assert.ok(process.argv[2], "Usage: tsx scripts/render-memory-comparison.ts <report-directory>");
const report = JSON.parse(readFileSync(resolve(dir, "report.json"), "utf8"));
const review = JSON.parse(readFileSync(resolve(dir, "grades.json"), "utf8")) as { grades: Grade[]; findings: string[]; limitations: string[] };
const results = report.results as Entry[];
assert.equal(review.grades.length, results.length);
assert.equal(new Set(review.grades.map(g => `${g.id}/${g.repeat}`)).size, results.length);
for (const row of results) {
  assert.ok(row.baseline && row.rag && !row.baseline.error && !row.rag.error, "Report service failures separately before grading");
  assert.ok(review.grades.some(g => g.id === row.id && g.repeat === row.repeat));
}
const count = (arm: "baseline" | "rag", list = review.grades) => list.filter(g => g[arm]).length;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const wins = review.grades.filter(g => g.rag && !g.baseline).length;
const losses = review.grades.filter(g => !g.rag && g.baseline).length;
const inputDependent = report.cases.filter((c: { required: string[]; id: string }) => c.required.length && c.id !== "recent-control").map((c: { id: string }) => c.id);
const oldGrades = review.grades.filter(g => inputDependent.includes(g.id));
const lines = ["# 动态记忆效果对比", "", `模型：${report.chatModel}；Embedding：${report.embeddingModel}。检索阈值 ${report.searchThreshold}，合并候选阈值 ${report.mergeThreshold}。`, "",
  "A 使用最近 6 条聊天；B 使用完全相同的聊天和回答提示词，再加入动态记忆。15 个问题各运行两次，共 30 组、60 个回答。", "",
  "## 结果", "", "| 指标 | A：近期聊天 | B：加动态记忆 |", "| --- | ---: | ---: |",
  `| 按预设标准回答达标 | ${count("baseline")}/${results.length} | ${count("rag")}/${results.length} |`,
  `| 依赖较早信息的题目 | ${count("baseline", oldGrades)}/${oldGrades.length} | ${count("rag", oldGrades)}/${oldGrades.length} |`,
  `| 回答阶段耗时中位数 | ${(median(results.map(r => r.baseline.answerMs)) / 1000).toFixed(2)} 秒 | ${(median(results.map(r => r.rag.answerMs + r.rag.retrievalMs)) / 1000).toFixed(2)} 秒（含检索） |`,
  `| 额外历史证据 token 中位数（估算） | 0 | ${median(results.map(r => r.evidenceEstimatedTokens))} |`, "",
  `逐组比较：B 改善 ${wins} 组，退步 ${losses} 组，其余 ${results.length - wins - losses} 组同分。`, "",
  "评分为当前助手逐条复核预设标准的二值结果；A 诚实说明不记得仍可能未完成回忆任务，不等于产生幻觉。语义正确但缺少引用未单独扣分。", "",
  "## 每题结果", "", "| 测试 | 类别 | A（两次） | B（两次） | 复核说明 |", "| --- | --- | ---: | ---: | --- |"];
for (const c of report.cases) {
  const grades = review.grades.filter(g => g.id === c.id);
  lines.push(`| ${c.id} | ${c.category} | ${count("baseline", grades)}/2 | ${count("rag", grades)}/2 | ${[...new Set(grades.map(g => g.reason))].join("；").replaceAll("|", " / ")} |`);
}
lines.push("", "## 发现", "", ...review.findings.map(f => `- ${f}`), "", "## 实验边界", "", ...review.limitations.map(f => `- ${f}`), "",
  "## 写入与成本", "", `测试主空间最终：${report.stats.hot} 条热区、${report.stats.cold} 条冷区、${report.stats.records} 条原始问答。`, "",
  `15 轮主空间记忆写入总耗时 ${(report.ingestion.filter((i: { ms?: number }) => i.ms).reduce((n: number, i: { ms: number }) => n + i.ms, 0) / 1000).toFixed(1)} 秒，包含摘要、向量及有候选时的整理；这部分未计入上表查询耗时。`, "",
  `出现 partial 的写入：${report.ingestion.filter((i: { action: string }) => i.action === "partial").map((i: { id: string }) => i.id).join("、") || "无"}。详见原始 JSON 中的 message。没有采集服务商实际 token usage，不能把证据估算当成账单费用。`, "",
  "## 逐题完整回答", "");
for (const row of results) {
  const c = report.cases.find((c: { id: string }) => c.id === row.id);
  const grade = review.grades.find(g => g.id === row.id && g.repeat === row.repeat)!;
  lines.push(`### ${c.id} · 第 ${row.repeat} 次`, "", `问题：${c.question}`, "", `标准：${c.expected}`, "",
    `**A · ${grade.baseline ? "达标" : "未达标"}**`, "", row.baseline.answer, "", `**B · ${grade.rag ? "达标" : "未达标"}**`, "", row.rag.answer, "",
    `复核：${grade.reason}`, "", `B 检索 ${row.rag.retrievalMs}ms；命中 ${row.evidence.context.length} 条证据。`, "",
    ...[...row.evidence.first, ...row.evidence.second].map(m => `- ${m.score.toFixed(3)}：${m.summary}`), "");
}
writeFileSync(resolve(dir, "comparison.md"), lines.join("\n"));
console.log(JSON.stringify({ dir, baseline: count("baseline"), rag: count("rag"), total: results.length, wins, losses }));

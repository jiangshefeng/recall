import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(process.argv[2] || "artifacts/locomo-mem0-pilot-conv-30-t8-luna-v2");
const report = JSON.parse(readFileSync(resolve(dir, "report.json"), "utf8"));
const arms = ["dynamic", "raw", "raw3", "mem0"] as const;
const normalize = (input: unknown) => String(input ?? "").toLowerCase().replaceAll(",", "")
  .replace(/[!"#$%&'()*+\-./:;<=>?@[\\\]^_`{|}~]/g, " ")
  .replace(/\b(a|an|the|and)\b/g, " ").trim().split(/\s+/).filter(Boolean);
function tokenF1(prediction: string, gold: string) {
  const p = normalize(prediction), g = normalize(gold), counts = new Map<string, number>();
  for (const token of p) counts.set(token, (counts.get(token) || 0) + 1);
  let common = 0;
  for (const token of g) { const count = counts.get(token) || 0; if (count) { common++; counts.set(token, count - 1); } }
  return common ? 2 * common / (p.length + g.length) : 0;
}
function score(category: number, prediction: string, gold: string) {
  if (category === 5) return /no information available|not mentioned/i.test(prediction) ? 1 : 0;
  if (category === 3) gold = gold.split(";")[0].trim();
  if (category === 1) {
    const predictions = prediction.split(",").map(s => s.trim());
    const answers = gold.split(",").map(s => s.trim());
    return answers.length ? answers.reduce((sum, answer) => sum + Math.max(...predictions.map(p => tokenF1(p, answer))), 0) / answers.length : 0;
  }
  return tokenF1(prediction, gold);
}
const rows = report.results.map((r: any) => {
  const gold = String(r.qa.answer ?? "No information available");
  return { index: r.index, category: r.qa.category, question: r.qa.question, gold,
    predictions: Object.fromEntries(arms.map(arm => [arm, r[arm]?.answer ?? r[arm]?.error ?? "missing"])),
    scores: Object.fromEntries(arms.map(arm => [arm, r[arm]?.answer ? score(r.qa.category, r[arm].answer, gold) : null])) };
});
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const summary: Record<string, any> = { status: report.status, model: report.manifest.chatModel, sample: report.manifest.sample,
  turns: report.manifest.turnCount, questions: rows.length, tokenUsage: report.usage, scoring: "Offline pilot approximation: upstream punctuation/article normalization and category rules, token F1 without Porter stemming. Not the official LoCoMo score.", arms: {} };
const chatPhases = [...new Set(report.requests.filter((r: any) => r.kind === "chat").map((r: any) => r.phase))] as string[];
summary.chatUsageByPhase = Object.fromEntries(chatPhases.map(phase => {
  const requests = report.requests.filter((r: any) => r.kind === "chat" && r.phase === phase);
  return [phase, { calls: requests.length, inputTokens: requests.reduce((n: number, r: any) => n + (r.promptTokens || 0), 0),
    outputTokens: requests.reduce((n: number, r: any) => n + (r.completionTokens || 0), 0),
    estimatedUsd: requests.reduce((n: number, r: any) => n + (r.chargedUsd ?? r.reserveUsd ?? 0), 0) }];
}));
for (const arm of arms) {
  const completed = rows.filter((r: any) => typeof r.scores[arm] === "number");
  summary.arms[arm] = { completed: completed.length,
    categories: Object.fromEntries([1, 2, 3, 4, 5].map(category => {
      const subset = completed.filter((r: any) => r.category === category);
      return [category, { n: subset.length, score: mean(subset.map((r: any) => r.scores[arm])) }];
    })),
    f1Categories1to4: mean(completed.filter((r: any) => r.category !== 5).map((r: any) => r.scores[arm])),
    category5AbstentionRate: mean(completed.filter((r: any) => r.category === 5).map((r: any) => r.scores[arm])),
  };
}
writeFileSync(resolve(dir, "scores-preview.json"), JSON.stringify({ summary, rows }, null, 2), "utf8");
const names: Record<string, string> = { dynamic: "Dynamic RAG", raw: "Ordinary RAG Top 6", raw3: "Ordinary RAG Top 3", mem0: "Mem0 OSS" };
const pct = (x: number | null) => x == null ? "—" : `${(x * 100).toFixed(1)}%`;
const lines = ["# Luna LoCoMo pilot", "", `Status: ${summary.status}; sample ${summary.sample}, ${summary.turns} utterances, ${summary.questions} questions; model ${summary.model}.`,
  `Estimated spend: $${Number(report.usage.estimatedUsd).toFixed(4)} / $${report.usage.budgetUsd} cap.`,
  "", "Scores are a local preview using upstream normalization/category rules but without Porter stemming; they are not official LoCoMo scores. This tiny prefix sample is not a benchmark result.", "",
  "| Arm | Completed | Categories 1–4 token F1 preview | Category 5 abstention |", "|---|---:|---:|---:|"];
for (const arm of arms) lines.push(`| ${names[arm]} | ${summary.arms[arm].completed}/${rows.length} | ${pct(summary.arms[arm].f1Categories1to4)} | ${pct(summary.arms[arm].category5AbstentionRate)} |`);
lines.push("", "## Category breakdown", "", "| Category | Dynamic | Ordinary Top 6 | Ordinary Top 3 | Mem0 |", "|---|---:|---:|---:|---:|");
for (const category of [1, 2, 3, 4, 5]) lines.push(`| ${category} (${summary.arms.dynamic.categories[category].n} questions) | ${pct(summary.arms.dynamic.categories[category].score)} | ${pct(summary.arms.raw.categories[category].score)} | ${pct(summary.arms.raw3.categories[category].score)} | ${pct(summary.arms.mem0.categories[category].score)} |`);
lines.push("", "## Chat usage by phase", "", "| Phase | Calls | Input tokens | Output tokens | Estimated USD |", "|---|---:|---:|---:|---:|");
for (const [phase, usage] of Object.entries(summary.chatUsageByPhase) as [string, any][]) lines.push(`| ${phase} | ${usage.calls} | ${usage.inputTokens} | ${usage.outputTokens} | $${usage.estimatedUsd.toFixed(4)} |`);
lines.push("", `Ordinary indexing produced ${report.manifest.ordinaryRag.chunkCount} chunk(s); in this sample Top 3 and Top 6 therefore both retrieve the same only chunk. The sample covers categories 2, 4, and 5 only. These results do not evaluate long-term compression or retrieval at scale.`, "");
for (const row of rows) lines.push("", `## Q${row.index} · category ${row.category}`, "", row.question, `Gold: ${row.gold}`,
  ...arms.map(arm => `${names[arm]} (${pct(row.scores[arm])}): ${row.predictions[arm]}`));
writeFileSync(resolve(dir, "results-preview.md"), lines.join("\n"), "utf8");
console.log(JSON.stringify(summary, null, 2));
console.log(`REPORT=${resolve(dir, "results-preview.md")}`);

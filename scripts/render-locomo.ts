import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Row = { index: number; category: number; score: number; question: string; gold: string | number; answer: string; provenanceRecall: number | null };
type Metric = { phase: string; kind: string; status?: number; ms: number; promptTokens?: number; completionTokens?: number };
type Arm = { categories: Record<string, { count: number; mean: number }>; completed: number; errorsOrMissing: number;
  f1Categories1to4: number; meanAcrossFiveCategories: number; provenanceRecallCategories1to4: number; rows: Row[] };
const dir = resolve(process.argv[2] || "artifacts/locomo-pilot-conv26-v2");
const report = JSON.parse(readFileSync(resolve(dir, "report.json"), "utf8"));
const scores = JSON.parse(readFileSync(resolve(dir, "scores.json"), "utf8"));
assert.equal(report.status, "completed");
const arms = scores.arms as Record<"dynamic" | "raw", Arm>;
const percent = (value: number | null | undefined) => value == null ? "—" : `${(100 * value).toFixed(1)}%`;
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const categoryNames = ["多跳", "时间", "开放域", "单跳", "对抗 / 弃答"];
const requests = report.requests as Metric[];
const usage = (phase?: string) => {
  const subset = requests.filter(row => row.kind === "chat" && (!phase || row.phase === phase));
  return { requests: subset.length, promptTokens: subset.reduce((sum, row) => sum + (row.promptTokens ?? 0), 0),
    completionTokens: subset.reduce((sum, row) => sum + (row.completionTokens ?? 0), 0), usageReported: subset.filter(row => row.promptTokens !== undefined).length };
};
const inputStates = Object.entries(report.ingestion.reduce((counts: Record<string, number>, row: { action: string }) => {
  counts[row.action] = (counts[row.action] || 0) + 1; return counts;
}, {}));
const indexedSources = new Set<string>(report.memories.flatMap((memory: { sourceIds: string[] }) => memory.sourceIds));
const unindexed = report.ingestion.filter((row: { recordId: string }) => !indexedSources.has(row.recordId));
const failureKinds: [string, string][] = [["提取失败", "摘要尚未建立索引"], ["单条摘要向量失败", "该事实摘要尚未建立索引"],
  ["批量整理调用 / 结构校验失败", "批量合并未完成"], ["决定缺失或重复", "合并决定缺失或重复"], ["多条事实争用同一旧记忆", "多条事实选择同一旧记忆"],
  ["必需阶段摘要缺失", "需要阶段摘要但模型未返回"]];
const paired = arms.dynamic.rows.filter(row => row.category !== 5).map(row => row.score - (arms.raw.rows.find(other => other.index === row.index)?.score ?? NaN));
const categoryCounts = [1, 2, 3, 4, 5].map(category => report.results.filter((row: { qa: { category: number } }) => row.qa.category === category).length);
const firstFourCount = categoryCounts.slice(0, 4).reduce((sum, n) => sum + n, 0);
const lines = ["# Recall × LoCoMo 试测报告", "",
  `本次仅测 **${report.manifest.sample}** 一段完整对话：${report.manifest.sessionCount} 次会话、${report.manifest.turnCount} 条发言，共 ${report.results.length} 题，各类题数依次为 ${categoryCounts.join(" / ")}。不是全部 10 段 / 1986 题的正式成绩。`, "",
  ...(report.extension ? [`本轮复用原数据库快照及已完成的 ${report.extension.inheritedQuestionIndices.length} 题答案，新增 ${report.extension.additionalQuestionIndices.length} 题；没有重新构建记忆。原先的小样本报告独立保留。`, ""] : []),
  `模型：${report.manifest.chatModel}；向量：${report.manifest.embeddingModel}；本次评测关闭思考模式：${report.manifest.disableThinking}。`, "",
  "## 两组成绩", "",
  "前四类使用官方词干 token F1，第五类使用官方弃答短语规则。F1 不是答对题数的比例。", "",
  "| 类别 | 题数 | 动态记忆 RAG | 原文向量 RAG |", "| --- | ---: | ---: | ---: |",
  ...categoryNames.map((name, i) => `| ${name} | ${arms.dynamic.categories[String(i + 1)].count} | ${percent(arms.dynamic.categories[String(i + 1)].mean)} | ${percent(arms.raw.categories[String(i + 1)].mean)} |`),
  `| 前四类按题数加权平均 F1 | ${firstFourCount} | ${percent(arms.dynamic.f1Categories1to4)} | ${percent(arms.raw.f1Categories1to4)} |`,
  `| 五类按题数混合平均（非正确率） | ${report.results.length} | ${percent(arms.dynamic.meanAcrossFiveCategories)} | ${percent(arms.raw.meanAcrossFiveCategories)} |`, "",
  `两组完成 ${arms.dynamic.completed} / ${arms.raw.completed} 题；服务错误或缺失 ${arms.dynamic.errorsOrMissing} / ${arms.raw.errorsOrMissing} 题。`, "",
  `前四类逐题评分对照：动态更高 ${paired.filter(value => value > 1e-9).length} 题，持平 ${paired.filter(value => Math.abs(value) <= 1e-9).length} 题，动态更低 ${paired.filter(value => value < -1e-9).length} 题。`, "",
  `前四类来源覆盖率：动态 ${percent(arms.dynamic.provenanceRecallCategories1to4)}，原文 ${percent(arms.raw.provenanceRecallCategories1to4)}。这是来源 ID 的覆盖，不证明摘要保留了该来源中的答案；也不计上下文间接提供的来源。`, "",
  "## 写入与耗时", "",
  `写入状态：${inputStates.map(([name, count]) => `${name} ${count}`).join("；")}。`, "",
  `其中没有直接关联任何已保存摘要的原始发言有 ${unindexed.length} 条（包括冷热历史，不把上下文间接携带视为直接建索引）。partial 不等于整条记忆丢失。`, "",
  "| 写入提示类型（同一条可能包含多个原因） | 条数 |", "| --- | ---: |",
  ...failureKinds.map(([name, fragment]) => `| ${name} | ${report.ingestion.filter((row: { message?: string }) => row.message?.includes(fragment)).length} |`), "",
  `动态记忆：${report.stats.dynamic.hot} 条热区、${report.stats.dynamic.cold} 条冷区、${report.stats.dynamic.records} 条原文；热区关联 ${report.stats.uniqueActiveStages} 个不同阶段摘要。原文对照：${report.stats.raw.hot} 条索引。`, "",
  `累计写入耗时 ${(report.ingestion.reduce((sum: number, row: { ms: number }) => sum + row.ms, 0) / 60000).toFixed(1)} 分钟，平均每条 ${(mean(report.ingestion.map((row: { ms: number }) => row.ms)) / 1000).toFixed(2)} 秒。`, "",
  "| 查询指标 | 动态记忆 | 原文向量 |", "| --- | ---: | ---: |",
  ...(["retrievalMs", "answerMs"] as const).map(key => `| 平均${key === "retrievalMs" ? "检索（含共享查询向量耗时）" : "回答"} | ${(mean(report.results.map((row: Record<string, Record<string, number>>) => row.dynamic[key])) / 1000).toFixed(2)} 秒 | ${(mean(report.results.map((row: Record<string, Record<string, number>>) => row.raw[key])) / 1000).toFixed(2)} 秒 |`), "",
  "## 服务返回的聊天 token 用量", "",
  "| 阶段 | 请求数 | 输入 token | 输出 token | 返回 usage 的请求 |", "| --- | ---: | ---: | ---: | ---: |",
  ...[["动态写入", "dynamic-ingest"], ["动态回答", "evaluate-dynamic"], ["原文回答", "evaluate-raw"], ["正式试测合计", ""]].map(([name, phase]) => {
    const value = usage(phase || undefined); return `| ${name} | ${value.requests} | ${value.promptTokens} | ${value.completionTokens} | ${value.usageReported} |`;
  }), "",
  `向量请求 ${requests.filter(row => row.kind === "embedding").length} 次，使用本地 Ollama。上述 token 不是账单金额；失败请求或缺失 usage 的用量未知，不包含被单独保留的适配预检。`, "",
  "## 方法与限制", "",
  "- 两组采用相同聊天模型、英文简短回答提示词、检索策略和证据预算；原文组不提取、合并或压缩。", "- 原始发言按人物和原日期依次导入；只使用已有图片描述，没有直接识别图片。", "- 标准答案、类别和参考证据不传给模型；测试答案不写回。查询不附带近期对话。", "- 选题在本轮新增回答前固定，只测一个对话、每题一次，不能据此推断全量结果或产品排名。扩展轮次保留先前答案，应分别查看新增题和合并结果。", "- 英文回答采用评测专用提示词，中文生产页面提示词不在本次测量范围内。", "- 官方词匹配分数可能惩罚正确的改写，也可能给不完整的答案部分分；应结合下面的逐题原文复核。", "",
  "数据与评分来源：[LoCoMo 官方仓库](https://github.com/snap-research/locomo)。固定数据 SHA256、核心代码哈希、全部证据和请求指标见同目录 `report.json`；逐题官方评分见 `scores.json`。", "",
  "## 全部逐题结果", ""];
for (const row of arms.dynamic.rows) {
  const baseline = arms.raw.rows.find(other => other.index === row.index);
  lines.push(`### 题 ${row.index} · ${categoryNames[row.category - 1]}`, "", row.question, "",
    `参考答案：${String(row.gold)}`, "", `动态记忆：${row.answer}`, "", `原文 RAG：${baseline?.answer ?? "服务错误或缺失"}`, "",
    `评分：动态 ${percent(row.score)} / 原文 ${percent(baseline?.score)}。来源覆盖：动态 ${percent(row.provenanceRecall)} / 原文 ${percent(baseline?.provenanceRecall)}。`, "");
}
writeFileSync(resolve(dir, "results.md"), lines.join("\n"));
console.log(`REPORT=${resolve(dir, "results.md")}`);

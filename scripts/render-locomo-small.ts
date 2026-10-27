import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(process.argv[2] || "artifacts/locomo-plain-rag-max0902-conv48-s2");
const r = JSON.parse(readFileSync(resolve(dir, "report.json"), "utf8"));
const topK = r.manifest.ordinaryRag.topK || 6;
const scores = JSON.parse(readFileSync(resolve(dir, "scores.json"), "utf8"));
type Scored = { index: number; category: number; score: number; question: string; gold: string | number; answer: string };
const dyn = scores.arms.dynamic.rows as Scored[], raw = scores.arms.raw.rows as Scored[];
const pairs = dyn.flatMap(d => { const b = raw.find(b => b.index === d.index); return b ? [{ d, b }] : []; });
const firstFour = pairs.filter(p => p.d.category !== 5);
const pct = (v: number | undefined | null) => v == null ? "—" : `${(100 * v).toFixed(1)}%`;
const avg = (a: number[]) => a.length ? a.reduce((s, n) => s + n, 0) / a.length : undefined;
const metrics = ["preflight", "dynamic-ingest", "evaluate-dynamic", "evaluate-raw", ...(topK === 3 ? ["evaluate-raw-top3"] : [])].map(phase => {
  const rs = r.requests.filter((x: { phase: string; kind: string }) => x.kind === "chat" && x.phase === phase);
  return { phase, calls: rs.length, input: rs.reduce((s: number, x: { promptTokens?: number }) => s + (x.promptTokens || 0), 0),
    output: rs.reduce((s: number, x: { completionTokens?: number }) => s + (x.completionTokens || 0), 0),
    charged: rs.reduce((s: number, x: { chargedTokens: number }) => s + x.chargedTokens, 0) };
});
const names = ["多跳", "时间", "开放域", "单事实", "对抗/弃答（独立规则分）"];
const categories = [1, 2, 3, 4, 5].map(category => {
  const rows = pairs.filter(p => p.d.category === category);
  return { category, n: rows.length, dynamic: avg(rows.map(p => p.d.score)), ordinary: avg(rows.map(p => p.b.score)) };
});
const totalTokens = r.requests.reduce((s: number, x: { chargedTokens: number }) => s + x.chargedTokens, 0);
const summary = { status: r.status, model: r.manifest.chatModel, sample: r.manifest.sample, sessions: r.manifest.sessionCount,
  turns: r.manifest.turnCount, pairs: pairs.length, plannedQuestions: r.results.length, categories,
  f1: { dynamic: avg(firstFour.map(p => p.d.score)), ordinary: avg(firstFour.map(p => p.b.score)), questions: firstFour.length },
  pairedFirstFour: { higher: firstFour.filter(p => p.d.score > p.b.score + 1e-9).length,
    same: firstFour.filter(p => Math.abs(p.d.score - p.b.score) <= 1e-9).length,
    lower: firstFour.filter(p => p.d.score < p.b.score - 1e-9).length },
  tokenMetrics: metrics, totalTokens, budgetTokens: r.manifest.budgetTokens,
  partialWrites: r.ingestion.filter((x: { action: string }) => x.action === "partial").length,
  mergeCount: r.ingestion.reduce((s: number, x: { merged?: number }) => s + (x.merged || 0), 0),
  sourceCoverageCaveat: "Gold source-ID coverage is not semantic accuracy; chunk coverage can include clipped text, and dynamic raw history can carry indirect evidence.",
};
writeFileSync(resolve(dir, "summary.json"), JSON.stringify(summary, null, 2));
const lines = ["# 动态 RAG 与普通 RAG：LoCoMo 小测", "",
  `状态：${r.status}。模型 **${r.manifest.chatModel}**，同一模型用于动态建库与两组回答；本地 Embedding 为 ${r.manifest.embeddingModel}。`, "",
  `固定范围：${r.manifest.sample} 前 ${r.manifest.sessionCount} 次完整会话、${r.manifest.turnCount} 条发言，已完成 **${pairs.length}/${r.results.length} 道成对题目**。不是全量 LoCoMo 成绩。`, "",
  "| 指标 | 动态 RAG | 普通 RAG |", "|---|---:|---:|",
  `| 前四类加权 F1（${firstFour.length}题） | ${pct(summary.f1.dynamic)} | ${pct(summary.f1.ordinary)} |`,
  ...categories.map(c => `| ${names[c.category - 1]}（${c.n}题） | ${pct(c.dynamic)} | ${pct(c.ordinary)} |`), "",
  `前四类逐题：动态更高 ${summary.pairedFirstFour.higher} 题，持平 ${summary.pairedFirstFour.same} 题，更低 ${summary.pairedFirstFour.lower} 题。F1 为官方类别评分，不是人工正确率；第五类单独报告，不混入前四类F1。`, "",
  "## 两组定义", "",
  `- 普通 RAG：原文按完整发言顺序分块，目标 ${r.manifest.ordinaryRag.chunkTargetChars} 字符，同一会话内重叠一条发言，共 ${r.manifest.ordinaryRag.chunkCount} 块；本地向量索引、单轮余弦 Top-${topK}，无相似度截断，不提取/合并/摘要、不二跳、不额外附带历史。`,
  "- 动态 RAG：使用项目实际记忆提取、候选合并、冷热区、阶段压缩与二跳检索；检索的原文可带前六条上下文。", "- 两组回答使用相同提示词、temperature=0、关闭thinking、256输出token上限，以及相同的最终证据字符/token预算。答案不回写。标准答案、题型及参考证据ID不发送给模型。", "",
  ...(r.manifest.ordinaryRag.chunkCount <= topK ? ["**小样本限制：普通索引只有6块，Top-6会检索所有块；实际是否完整进入提示词还受证据预算约束。普通组因此接近短历史全文对照，本轮不能用于评价大库检索表现。**", ""] : []),
  ...(topK === 3 ? ["本报告普通组为预先声明的Top-3敏感性测试。动态答案与建库继承父报告、不重新生成；token合计包含父报告Top-6回答和本轮Top-3回答，不能把父报告与本报告总计再相加。", ""] : []),
  "选题只依据前两次会话的参考证据完整性和类别，未按模型表现选题；包含全部符合条件的前四类题及5道均匀抽取的对抗题。此前调参使用conv-26，本轮使用conv-48。", "",
  "## 写入及 token", "",
  `动态写入 ${r.ingestion.length}/${r.manifest.turnCount} 条，partial ${summary.partialWrites} 条，合并/覆盖 ${summary.mergeCount} 次；统计：${JSON.stringify(r.stats || {})}。`, "",
  "| 阶段 | 聊天调用 | 输入token | 输出token | 预算计数 |", "|---|---:|---:|---:|---:|",
  ...metrics.map(m => `| ${m.phase} | ${m.calls} | ${m.input} | ${m.output} | ${m.charged} |`), "",
  `合计 **${totalTokens.toLocaleString("en-US")} token / ${r.manifest.budgetTokens.toLocaleString("en-US")} 上限**。本地向量不消耗百炼聊天额度。免费额度是否抵扣以账户账单为准；没有用Flash单价计算Max费用。无usage/中断请求保守记账，不作零消耗。`, "",
  "## 解释边界", "",
  "样本只有50条历史，无法充分检验长期压缩收益；不同分块、Top-K或模型会改变结果。普通RAG为可复现的基础向量检索，没有BM25、reranker或查询改写。两组使用同一证据预算，但实际上下文长度不同，不能把差异完全归因于某一条合并规则。每题仅运行一次，小类别仅2题，不能作显著性或产品排名结论，也不直接与旧版Flash分数比较。", "",
  "全部实际证据、模型输出、usage与代码哈希保存在 report.json 和 responses/；官方评分函数未改写，见 scores.json。", "",
  "## 全部逐题结果", ""];
for (const row of r.results) {
  const d = dyn.find(x => x.index === row.index), b = raw.find(x => x.index === row.index);
  lines.push(`### 题 ${row.index} · ${names[row.qa.category - 1]}`, "", row.qa.question, "",
    `参考答案：${String(row.qa.answer ?? "No information available")}`, "",
    `动态 RAG：${row.dynamic?.answer ?? row.dynamic?.error ?? "未完成"}`, "",
    `普通 RAG：${row.raw?.answer ?? row.raw?.error ?? "未完成"}`, "",
    `官方评分：动态 ${pct(d?.score)} / 普通 ${pct(b?.score)}。`, "",
    `证据条数：动态 ${row.dynamic?.evidence?.context?.length ?? "—"} / 普通 ${row.raw?.evidence?.context?.length ?? "—"}；证据估算token：动态 ${row.dynamic?.evidence?.trace?.usage?.estimatedTokens ?? "—"} / 普通 ${row.raw?.evidence?.trace?.usage?.estimatedTokens ?? "—"}。`, "");
}
writeFileSync(resolve(dir, "results.md"), lines.join("\n"));
console.log(JSON.stringify(summary, null, 2));
console.log(`REPORT=${resolve(dir, "results.md")}`);

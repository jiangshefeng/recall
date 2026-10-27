import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixtures, queries } from "./extended-rag-data";
import { remember, answerQuestion } from "../src/lib/rag";
import { embed, modelConfig, publicConfig } from "../src/lib/providers";
import { getStore } from "../src/lib/store";
import { retrieveFrom } from "../src/lib/retrieval";
import { estimateTokens } from "../src/lib/evidence-budget";

async function main() {
  assert.equal(modelConfig().mode, "live");
  assert.equal(publicConfig().ready, true);
  const dir = resolve("artifacts", "extended-rag", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  process.env.RAG_DB_PATH = resolve(dir, "memory.sqlite");
  const store = getStore(), config = modelConfig();
  const ids = new Map<string, string>();
  const ingestion: object[] = [], cases: any[] = [];
  const report = { embeddingModel: config.embeddingModel, chatModel: config.llmModel,
    note: "Synthetic user facts and acknowledgement answers; real LLM summaries, merge decisions and selected query answers. Keyword checks are not a correctness proof. Token limits use estimates. Scope filtering is not authentication.",
    ingestion, cases, stats: {} };
  const save = () => writeFileSync(resolve(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Report directory: ${dir}`);
  try {
    for (const [id, scope, statement] of fixtures) {
      const started = Date.now();
      const answer = `已记录：${statement}` + (id === "long-record" ? "背景说明：这是用于测试长原文截断的虚构内容。".repeat(1200) : "");
      const result = await remember(scope, statement, answer, []);
      ids.set(id, result.recordId);
      ingestion.push({ id, scope, ...result, milliseconds: Date.now() - started });
      save();
      console.log(`Ingest ${ingestion.length}/${fixtures.length} ${id}: ${result.action}`);
    }
    report.stats = Object.fromEntries([...new Set(fixtures.map(x => x[1]))].map(scope => [scope, store.stats(scope, config.space)]));
    for (const q of queries) {
      const vector = await embed(q.question);
      const e = retrieveFrom(store, q.scope, config.space, vector, "expand", 0.35);
      const json = JSON.stringify(e.context);
      assert.ok(json.length <= e.trace.policy.maxContextChars);
      assert.ok(estimateTokens(json) <= e.trace.policy.maxEstimatedTokens);
      assert.ok(e.records.length <= e.trace.policy.maxRecords);
      assert.equal(new Set(e.context.map(x => x.id)).size, e.context.length);
      assert.ok(e.records.every(x => x.scope === q.scope));
      const missing = q.required.filter(id => !e.context.some(x => x.id === ids.get(id)));
      const sweep = [0.35, 0.5, 0.65, 0.75].map(threshold => {
        const s = retrieveFrom(store, q.scope, config.space, vector, "expand", threshold);
        return { threshold, records: s.context.length, missing: q.required.filter(id => !s.context.some(x => x.id === ids.get(id))) };
      });
      const answer = q.answer ? await answerQuestion(q.question, [], e) : undefined;
      const keywordPass = answer === undefined ? undefined : (q.checks ?? []).every(pattern => new RegExp(pattern, "i").test(answer));
      const citations = answer ? [...answer.matchAll(/\[(\d+)\]/g)].map(x => Number(x[1])) : [];
      const citationValid = citations.every(n => e.context.some(x => x.citation === n));
      cases.push({ ...q, missing, keywordPass, citationValid, citations, answer,
        first: e.first.map(x => ({ summary: x.summary, score: x.score })),
        second: e.second.map(x => ({ summary: x.summary, score: x.score })),
        context: e.context, trace: e.trace, sweep });
      save();
      console.log(`Query ${cases.length}/${queries.length} ${q.id}: missing=${missing.join(",") || "none"} keywords=${keywordPass ?? "n/a"}`);
    }
    const known = cases.filter(x => x.required.length), answered = cases.filter(x => x.answer !== undefined);
    const lines = ["# 动态 RAG 扩展实测", "", `数据：${fixtures.length} 条合成问答，${queries.length} 个查询；真实 Ollama Embedding + 千问摘要、合并和 ${answered.length} 次回答。`, "",
      `完整召回所需原文：${known.filter(x => !x.missing.length).length}/${known.length}。回答关键词检查：${answered.filter(x => x.keywordPass).length}/${answered.length}。`,
      "全部查询通过上下文字符/估算 token/条数上限、原文去重和 scope 隔离断言。关键词命中不等于完整正确性，scope 过滤不等于生产鉴权。",
      "测试使用独立 SQLite，不修改日常记忆及生产检索参数。", "", "## 写入统计", "", "```json", JSON.stringify(report.stats, null, 2), "```", "", "## 检索结果", "",
      "| 查询 | 缺失原文 | 首轮/二轮 | 上下文字符 | 回答关键词 |", "|---|---|---|---|---|"];
    for (const c of cases) lines.push(`| ${c.id} | ${c.missing.join(", ") || "无"} | ${c.first.length}/${c.second.length} | ${c.trace.usage.chars} | ${c.keywordPass ?? "未生成"} |`);
    lines.push("", "## 阈值对比", "", "| 阈值 | 完整召回查询 | 无已知答案但返回证据 |", "|---|---|---|");
    for (const t of [0.35, 0.5, 0.65, 0.75]) lines.push(`| ${t} | ${known.filter(c => !c.sweep.find((s: any) => s.threshold === t).missing.length).length}/${known.length} | ${cases.filter(c => !c.required.length && c.sweep.find((s: any) => s.threshold === t).records > 0).length}/4 |`);
    lines.push("", "## 实际回答（需人工判断）", "");
    for (const c of answered) lines.push(`### ${c.id}`, "", c.question, "", c.answer, "");
    writeFileSync(resolve(dir, "report.md"), lines.join("\n"));
    console.log(JSON.stringify({ dir, stats: report.stats, recall: `${known.filter(x => !x.missing.length).length}/${known.length}`, keywords: `${answered.filter(x => x.keywordPass).length}/${answered.length}` }));
  } finally { store.close(); }
}
main().catch(e => { console.error(e instanceof Error ? e.message : "Extended test failed"); process.exitCode = 1; });

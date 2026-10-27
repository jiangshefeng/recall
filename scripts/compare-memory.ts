import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { answerQuestion, remember, retrieve } from "../src/lib/rag";
import { modelConfig, publicConfig } from "../src/lib/providers";
import { getStore } from "../src/lib/store";
import { estimateTokens } from "../src/lib/evidence-budget";
import type { Evidence, Turn } from "../src/lib/types";
import { cases, transcript } from "./compare-memory-data";

type Result = { answer?: string; error?: string; answerMs: number; retrievalMs: number; evidence?: Evidence };
async function main() {
  const config = modelConfig();
  assert.equal(config.mode, "live"); assert.ok(publicConfig().ready);
  const dir = resolve("artifacts", `memory-comparison-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.RAG_DB_PATH = resolve(dir, "memory.sqlite");
  const store = getStore(), scope = "comparison";
  const history: Turn[] = [];
  const ids: Record<string, string> = {};
  const ingestion: object[] = [];
  const results: object[] = [];
  const report = { createdAt: new Date().toISOString(), chatModel: config.llmModel, embeddingModel: config.embeddingModel,
    searchThreshold: Number(process.env.RAG_SEARCH_THRESHOLD ?? .45), mergeThreshold: Number(process.env.RAG_MERGE_THRESHOLD ?? .6),
    methodology: "Fixed synthetic transcripts with authored assistant replies; real extraction, embeddings, merge decisions, retrieval and answers. Two runs per question. Identical answering prompt and last six messages; only historicalEvidence differs. Answers are not written back, preventing cross-test contamination. Arm order alternates. No temperature/seed override. Timing includes provider variance; tokens are evidence estimates, not billing. Manual grading required; service errors are not semantic failures.",
    transcript, cases, ids, ingestion, history, results, stats: {}, memories: [] as object[] };
  const save = () => writeFileSync(resolve(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(`REPORT_DIR=${dir}`);
  save();
  try {
    for (const row of transcript) {
      const started = Date.now();
      const memory = await remember(scope, row.question, row.answer, history.slice(-6));
      ids[row.id] = memory.recordId;
      ingestion.push({ id: row.id, ...memory, ms: Date.now() - started });
      history.push({ role: "user", content: row.question }, { role: "assistant", content: row.answer });
      save(); console.log(`INGEST ${row.id}: ${memory.action}`);
    }
    const other = await remember("other-user", "青禾项目负责人是许衡。", "已记录负责人。", []);
    ingestion.push({ id: "other-user-owner", ...other });
    report.stats = store.stats(scope, config.space);
    report.memories = store.memories(scope, config.space).map(({ vector: _vector, ...m }) => m);
    save();
    for (let repeat = 1; repeat <= 2; repeat++) {
      for (const [index, c] of cases.entries()) {
        const started = Date.now();
        let evidence: Evidence;
        try { evidence = await retrieve(scope, c.question, "expand"); }
        catch (e) { results.push({ id: c.id, repeat, retrievalError: String(e) }); save(); continue; }
        const retrievalMs = Date.now() - started;
        assert.ok(evidence.records.every(r => r.scope === scope));
        assert.ok(JSON.stringify(evidence.context).length <= evidence.trace.policy.maxContextChars);
        const empty: Evidence = { ...evidence, first: [], second: [], context: [], records: [], stages: [], suggestions: [] };
        const pair: Record<string, Result> = {};
        const order = (index + repeat) % 2 ? ["baseline", "rag"] : ["rag", "baseline"];
        for (const arm of order) {
          const t = Date.now();
          try { pair[arm] = { answer: await answerQuestion(c.question, history.slice(-6), arm === "rag" ? evidence : empty),
            answerMs: Date.now() - t, retrievalMs: arm === "rag" ? retrievalMs : 0 }; }
          catch (e) { pair[arm] = { error: String(e), answerMs: Date.now() - t, retrievalMs: arm === "rag" ? retrievalMs : 0 }; }
        }
        results.push({ id: c.id, repeat, ...pair, evidence,
          expectedSourceIds: c.required.map(key => ids[key]),
          directlyRecalled: c.required.filter(key => evidence.context.some(e => e.id === ids[key])),
          evidenceEstimatedTokens: estimateTokens(JSON.stringify(evidence.context)),
        });
        save(); console.log(`CASE ${repeat}/${c.id}: evidence=${evidence.context.length} baseline=${pair.baseline.error ? "error" : "ok"} rag=${pair.rag.error ? "error" : "ok"}`);
      }
    }
    const lines = ["# 动态记忆 A/B 原始结果", "", "评分前保留的原始结果。每题两轮；标准见每题预期；合成历史和固定助手答复用于控制变量。", "",
      `模型：${config.llmModel} / ${config.embeddingModel}；检索阈值 ${report.searchThreshold}，整理阈值 ${report.mergeThreshold}。`, "",
      "A：相同提示词＋最近 6 条消息。B：在 A 基础上加入当前动态记忆检索。测试回答不回写；每轮交替请求顺序。", "",
      "这不是与全部历史上下文、其他 RAG 产品或人工正确证据的对比，也不是真实用户长期统计。", ""];
    for (const entry of results as ({ id: string; repeat: number; baseline: Result; rag: Result; evidence: Evidence })[]) {
      const c = cases.find(c => c.id === entry.id)!;
      lines.push(`## ${c.id} · 第 ${entry.repeat} 轮`, "", c.question, "", `预期：${c.expected}`, "");
      if (!entry.baseline) { lines.push("检索请求失败，详见 JSON。", ""); continue; }
      lines.push("### A：近期聊天", "", entry.baseline.answer ?? entry.baseline.error ?? "", "", "### B：动态记忆", "", entry.rag.answer ?? entry.rag.error ?? "", "",
        `检索 ${entry.rag.retrievalMs}ms；A 回答 ${entry.baseline.answerMs}ms，B 回答 ${entry.rag.answerMs}ms；${entry.evidence.context.length} 条证据。`, "",
        "命中摘要：", "", ...[...entry.evidence.first, ...entry.evidence.second].map(m => `- ${m.score.toFixed(3)} · ${m.summary}`), "");
    }
    writeFileSync(resolve(dir, "answers.md"), lines.join("\n"));
    console.log(`COMPLETE ${results.length} paired cases. ${dir}`);
  } finally { store.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { embed, modelConfig, publicConfig } from "../src/lib/providers";
import { MemoryStore } from "../src/lib/store";
import { retrieveFrom } from "../src/lib/retrieval";
import { answerQuestion } from "../src/lib/rag";
import { estimateTokens } from "../src/lib/evidence-budget";
import type { Evidence } from "../src/lib/types";

async function main() {
  const config = modelConfig();
  assert.equal(config.mode, "live", "Run with node --env-file=.env.local --import tsx scripts/verify-retrieval-live.ts");
  assert.equal(publicConfig().ready, true, "Model configuration is incomplete");
  const question = "测试项目 RAGCHECK 的订单缓存多久过期？";
  const summaries = [
    "测试项目 RAGCHECK 的订单缓存多久过期？用户明确说明有效期为 5 分钟。",
    "测试项目 RAGCHECK 的订单缓存过期时间是 5 分钟，也就是 300 秒。",
    "测试项目 RAGCHECK 的订单缓存到期后自动失效，TTL 固定为 5 分钟。",
    "测试项目 RAGCHECK 使用 Redis 保存订单缓存，5 分钟后过期。",
    "测试项目 RAGCHECK 的订单缓存配置：到期时长 300 秒。",
    "测试项目 RAGCHECK 当前订单缓存为 5 分钟，旧值已停用。",
    "今天北京天气晴朗，适合出门散步。",
  ];
  const vectors = await Promise.all(summaries.map(embed));
  const query = await embed(question);
  const store = new MemoryStore(":memory:");
  const add = (scope: string, index: number, status: "hot" | "cold" = "hot", long = false) => {
    const id = `${scope}-${index}`;
    store.saveRecord({ id, scope, question: summaries[index], answer: long ? "5 分钟。" + "这是一段用于验证上下文长度上限的背景资料。".repeat(1000) : "根据用户提供的测试设定，订单缓存为 5 分钟。",
      context: "安装验证样例，不属于真实项目。", createdAt: "2026-10-26T00:00:00Z" });
    store.saveMemory({ id, scope, summary: summaries[index], vector: vectors[index], space: config.space,
      status, sourceIds: [id], parentIds: [], reason: "live retrieval verification", createdAt: "2026-10-26T00:00:00Z" });
  };
  const checkBudget = (e: Evidence) => {
    assert.ok(e.records.length <= e.trace.policy.maxRecords);
    assert.ok(JSON.stringify(e.context).length <= e.trace.policy.maxContextChars);
    assert.ok(estimateTokens(JSON.stringify(e.context)) <= e.trace.policy.maxEstimatedTokens);
    assert.equal(new Set(e.context.map(x => x.id)).size, e.context.length);
  };
  const report = (e: Evidence) => ({ first: e.first.length, second: e.second.length, reason: e.trace.reason,
    scores: e.first.map(x => Number(x.score.toFixed(3))), usage: e.trace.usage });
  try {
    for (let i = 0; i < 6; i++) add("rich", i);
    add("rich", 6, "cold");
    const rich = retrieveFrom(store, "rich", config.space, query, "expand", 0.35);
    assert.equal(rich.first.length, 6);
    assert.equal(rich.trace.reason, "enough-first-results");
    checkBudget(rich);

    add("sparse", 0); add("sparse", 1); add("sparse", 2); add("sparse", 3, "cold"); add("sparse", 6, "cold");
    const sparse = retrieveFrom(store, "sparse", config.space, query, "expand", 0.35, { firstLimit: 2 });
    assert.equal(sparse.first.length, 2);
    assert.equal(sparse.trace.reason, "few-first-results");
    assert.ok(sparse.second.some(x => x.id === "sparse-2"));
    assert.ok(!sparse.second.some(x => x.id === "sparse-6"));
    assert.ok([...sparse.first, ...sparse.second].every(x => x.status === "hot"));
    assert.ok(!sparse.records.some(x => x.id === "sparse-3"));
    checkBudget(sparse);

    add("budget", 0, "hot", true); add("budget", 2, "cold");
    const budget = retrieveFrom(store, "budget", config.space, query, "expand", 0.35, { maxContextChars: 800 });
    assert.equal(budget.trace.reason, "budget-exhausted");
    assert.equal(budget.context[0].truncated, true);
    assert.ok(store.records("budget")[0].answer.length > 800);
    checkBudget(budget);

    const answer = await answerQuestion(question, [], sparse);
    assert.match(answer, /5\s*分钟|五分钟|300\s*秒/);
    assert.match(answer, /\[\d+\]/);
    const result = { status: "passed", embeddingModel: config.embeddingModel, chatModel: config.llmModel,
      rich: report(rich), sparse: report(sparse), budget: report(budget), answer, checkedAt: new Date().toISOString() };
    mkdirSync("artifacts", { recursive: true });
    writeFileSync("artifacts/retrieval-live-check.json", JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { store.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Verification failed"); process.exitCode = 1; });

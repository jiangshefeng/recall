import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { remember, retrieve, answerQuestion } from "../src/lib/rag";
import { getStore } from "../src/lib/store";
import { embed, modelConfig } from "../src/lib/providers";

async function main() {
  const dir = resolve("artifacts", `stage-live-${Date.now()}`); mkdirSync(dir, { recursive: true });
  process.env.RAG_DB_PATH = resolve(dir, "test.sqlite");
  process.env.RAG_STAGE_SOURCE_THRESHOLD = "10"; process.env.RAG_STAGE_CHAR_THRESHOLD = "12000";
  const config = modelConfig(); assert.equal(config.mode, "live");
  const store = getStore(), scope = "stage-live";
  const sourceIds = Array.from({ length: 10 }, (_, i) => `stage-source-${i}`);
  for (const [i, id] of sourceIds.entries()) store.saveRecord({ id, scope,
    question: `截至2026年10月${i + 1}日，测试项目云杉的订单缓存有效期是5分钟。`, answer: "已记录用户设定。", context: "[]", createdAt: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z` });
  const summary = "测试项目云杉的订单缓存有效期是5分钟。";
  store.saveMemory({ id: "stage-initial", scope, space: config.space, sourceIds, parentIds: [],
    summary, vector: await embed(summary), status: "hot", reason: "合成测试来源", createdAt: "2026-10-10T00:00:00Z" });
  const actualFetch = globalThis.fetch;
  let mergeCalls = 0;
  const mergePayloads: any[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("chat/completions") && typeof init?.body === "string") {
      const body = JSON.parse(init.body);
      if (body.messages[0].content.includes("批量合并任务")) {
        mergeCalls++;
        mergePayloads.push(JSON.parse(body.messages[1].content));
      }
    }
    return actualFetch(input, init);
  };
  try {
    const result = await remember(scope, "从2026年10月27日起，测试项目云杉的订单缓存有效期从5分钟改为8分钟。", "已记录变更。", []);
    const hot = store.memories(scope, config.space, "hot");
    assert.equal(mergeCalls, 1); assert.equal(result.merged, 1);
    assert.equal(hot[0].stage?.sourceIds.length, 11);
    assert.equal(store.records(scope).length, 11);
    console.log("First compression: 11 originals -> one stage");
    const next = await remember(scope, "测试项目云杉的订单缓存现在从8分钟改成9分钟。", "已记录变更。", []);
    assert.equal(next.merged, 1); assert.equal(mergeCalls, 2);
    assert.equal(mergePayloads[1].originals.length, 1);
    assert.ok(!JSON.stringify(mergePayloads[1]).includes(sourceIds[0]));
    assert.ok(mergePayloads[1].memories.some((m: any) => m.stage?.content));
    assert.equal(store.memories(scope, config.space, "hot")[0].stage?.id, hot[0].stage?.id);
    process.env.RAG_STAGE_SOURCE_THRESHOLD = "1";
    const recompressed = await remember(scope, "测试项目云杉的订单缓存再次更新，从9分钟改成10分钟。", "已记录变更。", []);
    assert.equal(recompressed.merged, 1); assert.equal(mergeCalls, 3);
    assert.equal(mergePayloads[2].originals.length, 2);
    assert.ok(!JSON.stringify(mergePayloads[2]).includes(sourceIds[0]));
    const final = store.memories(scope, config.space, "hot")[0];
    assert.equal(final.stage?.sourceIds.length, 13);
    assert.notEqual(final.stage?.id, hot[0].stage?.id);
    const evidence = await retrieve(scope, "测试项目云杉订单缓存现在多久过期？", "expand");
    const answer = await answerQuestion("测试项目云杉订单缓存现在多久过期？", [], evidence);
    const payloadStats = mergePayloads.map(p => ({ chars: JSON.stringify(p).length, originals: p.originals.length,
      stages: p.memories.filter((m: any) => m.stage).length }));
    writeFileSync(resolve(dir, "report.json"), JSON.stringify({ result, next, recompressed, mergeCalls, payloadStats, final, evidence, answer }, null, 2));
    console.log(JSON.stringify({ dir, mergeCalls, payloadStats, archivedSources: final.sourceIds.length, evidenceEntries: evidence.context.length, answer }));
    assert.equal(evidence.context[0].kind, "stage");
    assert.match(answer, /10\s*分钟|十分钟/);
  } finally { globalThis.fetch = actualFetch; store.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });

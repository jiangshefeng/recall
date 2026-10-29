import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerQuestion, remember, retrieve } from "../src/lib/rag";
import { getStore } from "../src/lib/store";
import { modelConfig } from "../src/lib/providers";

test("live adapter flow: merge with provenance, answer with evidence, and retain originals on malformed LLM output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rag-live-test-"));
  const previousEnv = { ...process.env };
  let broken: "none" | "merge" | "summary" = "none";
  let calls = 0;
  const embeddingInputs: string[] = [];
  const embeddingBatches: string[][] = [];
  let failEmbeddingText: string | undefined;
  let chosenId: string | undefined;
  let comparedIds: string[] = [];
  let mergeCalls = 0;
  let batchSize = 0;
  let batchReusesNewFacts = false;
  let answerHadEvidence = false;
  let actualPromptEvidence: unknown;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer local-test") { res.writeHead(401); res.end("{}"); return; }
    calls++;
    if (req.url === "/v1/embeddings") {
      const inputs: string[] = Array.isArray(payload.input) ? payload.input : [payload.input];
      embeddingInputs.push(...inputs); embeddingBatches.push(inputs);
      if (inputs.includes(failEmbeddingText!)) { res.writeHead(500); res.end("{}"); return; }
      res.end(JSON.stringify({ data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0] })).reverse() })); return;
    }
    const system = payload.messages[0].content as string;
    let content: string;
    if (system.includes("提炼当前问答")) {
      const record = JSON.parse(payload.messages.at(-1).content);
      content = broken === "summary" ? "not-json" : JSON.stringify({ facts: record.question === "split"
        ? ["用户学习 React。", "用户计划下月寻找实习。"] : record.question.startsWith("empty") ? [] : ["用户项目默认缓存 30 分钟；助手建议未验证。"],
        ...(record.question === "empty" ? { qaSummary: "用户询问编辑器推荐，助手建议 VS Code。" } : {}) });
    } else if (system.includes("判断两条记忆关系")) {
      const input = JSON.parse(payload.messages.at(-1).content);
      mergeCalls++;
      batchSize = input.jobs.length;
      const incomingIds = new Set(input.jobs.map((j: { incomingId: string }) => j.incomingId));
      batchReusesNewFacts = input.jobs.some((j: { candidateIds: string[] }) => j.candidateIds.some(id => incomingIds.has(id)));
      comparedIds = input.jobs[0].candidateIds;
      content = broken === "merge" ? JSON.stringify({ relation: "delete-everything" }) : JSON.stringify({ decisions: input.jobs.map((job: { incomingId: string; candidateIds: string[] }, i: number) => ({
        incomingId: job.incomingId, candidateId: chosenId ?? job.candidateIds[i % job.candidateIds.length], relation: "duplicate",
        summary: input.memories.find((m: { id: string }) => m.id === job.incomingId)?.kind === "qa"
          ? input.memories.find((m: { id: string }) => m.id === job.incomingId).summary : "用户项目默认缓存 30 分钟。", reason: "同一属性重复",
      })) });
    } else {
      const input = JSON.parse(payload.messages.at(-1).content);
      answerHadEvidence = input.historicalEvidence.length === 1 && input.historicalEvidence[0].kind === "summary";
      actualPromptEvidence = input.historicalEvidence;
      content = "根据历史记录，默认 30 分钟，订单 5 分钟 [1][2]。";
    }
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/v1`;
    Object.assign(process.env, { RAG_MODE: "live", LLM_BASE_URL: base, EMBEDDING_BASE_URL: base,
      LLM_API_KEY: "local-test", EMBEDDING_API_KEY: "local-test", LLM_MODEL: "mock-chat",
      EMBEDDING_MODEL: "mock-embedding", RAG_DB_PATH: join(dir, "rag.sqlite") });
    assert.equal((await remember("live-test", "默认缓存多久？", "30 分钟", [])).action, "added");
    assert.equal((await remember("live-test", "订单缓存呢？", "5 分钟", [])).action, "merged");
    assert.deepEqual(getStore().stats("live-test", modelConfig().space), { hot: 1, cold: 2, records: 2 });
    const evidence = await retrieve("live-test", "缓存多久过期？", "sources");
    assert.equal(evidence.records.length, 0);
    assert.equal(evidence.first[0].sourceIds.length, 2);
    assert.match(await answerQuestion("缓存多久过期？", [], evidence), /30 分钟/);
    assert.equal(answerHadEvidence, true);
    assert.deepEqual(actualPromptEvidence, evidence.context);
    broken = "merge";
    const mergeFailed = await remember("live-test", "其他缓存？", "10 分钟", []);
    assert.equal(mergeFailed.action, "partial");
    assert.match(mergeFailed.message, /保存独立摘要/);
    broken = "summary";
    const summaryFailed = await remember("live-test", "索引失败也要保存", "原文", []);
    assert.equal(summaryFailed.action, "partial");
    assert.deepEqual(getStore().stats("live-test", modelConfig().space), { hot: 2, cold: 2, records: 4 });
    assert.ok(calls >= 10);
    broken = "none";
    const beforeSplitVectors = embeddingBatches.length;
    const split = await remember("split-test", "split", "收到", []);
    assert.equal(split.action, "added");
    assert.equal(embeddingBatches.length - beforeSplitVectors, 1);
    assert.equal(embeddingBatches.at(-1)!.length, 2);
    assert.deepEqual(getStore().stats("split-test", modelConfig().space), { hot: 2, cold: 0, records: 1 });
    assert.ok(getStore().memories("split-test").every(m => m.sourceIds[0] === split.recordId));
    const splitEvidence = await retrieve("split-test", "学习", "sources");
    assert.equal(splitEvidence.context.length, 2);
    assert.equal(new Set(splitEvidence.context.map(entry => entry.id)).size, 2);
    assert.ok(splitEvidence.context.every(entry => entry.kind === "summary"));
    assert.equal(splitEvidence.records.length, 0);
    await remember("qa-test", "split", "ack", []);
    const empty = await remember("qa-test", "empty", "收到", []);
    assert.equal(empty.facts, 0);
    assert.equal(empty.summaries, 1); assert.equal(empty.added, 1);
    assert.match(empty.message, /生成 1 条问答摘要/);
    assert.deepEqual(getStore().stats("qa-test", modelConfig().space), { hot: 3, cold: 0, records: 2 });
    const qa = getStore().memories("qa-test").find(m => m.sourceIds.includes(empty.recordId))!;
    assert.equal(qa.kind, "qa");
    assert.equal(qa.summary, "用户询问编辑器推荐，助手建议 VS Code。");
    assert.ok(embeddingInputs.includes(qa.summary));
    assert.ok(embeddingInputs.every(text => !text.includes("问答记录（助手回答未验证）")));
    const repeatedQA = await remember("qa-test", "empty", "收到", []);
    assert.equal(repeatedQA.merged, 1);
    assert.ok(getStore().memories("qa-test").filter(m => m.kind === "qa").every(m => !m.summary.includes("问答记录（助手回答未验证）")));
    assert.equal(getStore().memories("qa-test", undefined, "hot").filter(m => m.kind === "qa").length, 1);
    assert.ok(getStore().memories("qa-test", undefined, "hot").some(m => m.summary === "用户学习 React。"));
    const fallback = await remember("qa-fallback", "empty-fallback", "建议先检查配置", []);
    assert.equal(fallback.added, 1);
    assert.match(getStore().memories("qa-fallback")[0].summary, /用户提问：empty-fallback；助手答复：建议先检查配置/);
    for (const [id, score] of [["distractor", 0.95], ["correct-property", 0.75]] as const) {
      getStore().saveRecord({ id, scope: "candidate-test", question: id, answer: "", context: "[]", createdAt: "2026-01-01T00:00:00Z" });
      getStore().saveMemory({ id, scope: "candidate-test", summary: id, vector: [score, Math.sqrt(1-score*score), 0],
        space: modelConfig().space, status: "hot", sourceIds: [id], parentIds: [], reason: "test", createdAt: "2026-01-01T00:00:00Z" });
    }
    chosenId = "correct-property";
    const selected = await remember("candidate-test", "new preference", "ack", []);
    assert.equal(selected.action, "merged");
    assert.deepEqual(comparedIds, ["distractor", "correct-property"]);
    assert.equal(getStore().memories("candidate-test").find(m => m.id === "distractor")?.status, "hot");
    assert.equal(getStore().memories("candidate-test").find(m => m.id === chosenId)?.status, "cold");
    chosenId = "id-not-in-candidates";
    assert.equal((await remember("candidate-test", "unknown chosen ID", "ack", [])).action, "partial");
    chosenId = undefined;
    const beforeBatch = mergeCalls;
    const beforeMergeVectors = embeddingBatches.length;
    const batch = await remember("split-test", "split", "收到", []);
    assert.equal(batch.merged, 2);
    assert.equal(batchSize, 2);
    assert.equal(batchReusesNewFacts, false);
    assert.equal(mergeCalls - beforeBatch, 1);
    assert.deepEqual(embeddingBatches.slice(beforeMergeVectors).map(inputs => inputs.length), [2, 2]);
    assert.deepEqual(getStore().stats("split-test", modelConfig().space), { hot: 2, cold: 4, records: 2 });
    chosenId = getStore().memories("split-test").find(m => m.status === "hot")!.id;
    const beforeCollision = mergeCalls;
    const collision = await remember("split-test", "split", "收到", []);
    assert.equal(mergeCalls - beforeCollision, 1);
    assert.equal(collision.merged, 1);
    assert.equal(collision.added, 1);
    assert.equal(collision.action, "partial");
    broken = "merge";
    const beforeFailure = mergeCalls;
    const failedBatch = await remember("split-test", "split", "收到", []);
    assert.equal(mergeCalls - beforeFailure, 1);
    assert.equal(failedBatch.added, 2);
    assert.equal(failedBatch.merged, 0);
    assert.equal(failedBatch.action, "partial");
    broken = "none";
    failEmbeddingText = "用户学习 React。";
    const partialVectors = await remember("partial-vectors", "split", "收到", []);
    assert.equal(partialVectors.action, "partial"); assert.equal(partialVectors.added, 1);
    assert.deepEqual(getStore().stats("partial-vectors", modelConfig().space), { hot: 1, cold: 0, records: 1 });
    assert.equal(getStore().memories("partial-vectors")[0].summary, "用户计划下月寻找实习。");
    failEmbeddingText = "用户项目默认缓存 30 分钟。";
    const beforeVectorFailure = getStore().stats("split-test", modelConfig().space);
    const mergeVectorFailure = await remember("split-test", "split", "收到", []);
    assert.equal(mergeVectorFailure.action, "partial");
    assert.equal(mergeVectorFailure.merged, 0); assert.equal(mergeVectorFailure.added, 2);
    assert.deepEqual(getStore().stats("split-test", modelConfig().space), {
      hot: beforeVectorFailure.hot + 2, cold: beforeVectorFailure.cold, records: beforeVectorFailure.records + 1,
    });
    failEmbeddingText = undefined;
    const historical = await remember("historical-date", "时间测试", "已记录", [], { recordedAt: "2023-05-08T13:56:00Z" });
    assert.equal(getStore().records("historical-date", [historical.recordId])[0].createdAt, "2023-05-08T13:56:00.000Z");
    assert.ok(getStore().memories("historical-date").every(m => m.createdAt === "2023-05-08T13:56:00.000Z"));
    await assert.rejects(remember("historical-invalid", "时间测试", "已记录", [], { recordedAt: "invalid" }), RangeError);
    assert.equal(getStore().records("historical-invalid").length, 0);
  } finally {
    const globalStore = globalThis as unknown as { ragStore?: { close(): void } };
    globalStore.ragStore?.close(); delete globalStore.ragStore;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    rmSync(dir, { recursive: true, force: true });
  }
});

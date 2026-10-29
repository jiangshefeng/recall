import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { remember, retrieve } from "../src/lib/rag";
import { getStore, MemoryStore } from "../src/lib/store";
import { modelConfig } from "../src/lib/providers";
import { compressionPlan } from "../src/lib/compression";
import { retrieveFrom } from "../src/lib/retrieval";
import { estimateTokens } from "../src/lib/evidence-budget";
import type { Memory, RecordEntry } from "../src/lib/types";

test("stage compression uses prior stage plus deltas for judgment and recompression, preserving archives on failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rag-stage-")), env = { ...process.env };
  let summaries = 0, merges = 0, omitStage = false;
  const mergeInputs: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); res.setHeader("Content-Type", "application/json");
    if (req.url?.endsWith("embeddings")) { res.end(JSON.stringify({ data: [{ embedding: [1, 0] }] })); return; }
    let content: object;
    if (body.messages[0].content.includes("提炼当前问答")) { summaries++; content = { facts: ["用户当前希望按需提供例子。"] }; }
    else {
      merges++;
      const input = JSON.parse(body.messages[1].content); mergeInputs.push(input);
      content = { decisions: input.jobs.map((job: any) => ({ incomingId: job.incomingId, candidateId: job.candidateIds[0],
        relation: "update", summary: "用户当前希望按需提供例子。", reason: "用户明确更新偏好",
        stageSummary: !omitStage && job.compression[0].required ? "用户早期希望附带例子，后来更新为默认不举例，仅主动要求时提供。消息时间标明各次更新，临时要求不覆盖长期偏好。" : null })) };
    }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/v1`;
    Object.assign(process.env, { RAG_MODE: "live", LLM_BASE_URL: base, EMBEDDING_BASE_URL: base,
      LLM_API_KEY: "test", EMBEDDING_API_KEY: "test", LLM_MODEL: "test", EMBEDDING_MODEL: "test",
      RAG_DB_PATH: join(dir, "memory.sqlite"), RAG_STAGE_SOURCE_THRESHOLD: "5", RAG_STAGE_CHAR_THRESHOLD: "12000" });
    const store = getStore(), space = modelConfig().space;
    const seed = (scope: string, n: number, answer = "确认") => {
      const sourceIds = Array.from({ length: n }, (_, i) => `${scope}-r${i}`);
      for (const [i, id] of sourceIds.entries()) store.saveRecord({ id, scope, question: `偏好记录${i}`, answer, context: "完整历史上下文", createdAt: "2026-01-01T00:00:00Z" });
      const m: Memory = { id: `${scope}-memory`, scope, space, sourceIds, parentIds: [], summary: "用户希望举例", vector: [1, 0], status: "hot", reason: "test", createdAt: "2026-01-01T00:00:00Z" };
      store.saveMemory(m); return m;
    };
    const old = seed("count", 4);
    const original = store.records("count");
    const first = await remember("count", "以后不用例子，我要的时候会说", "收到", []);
    assert.equal(first.merged, 1); assert.equal(summaries, 1); assert.equal(merges, 1);
    let hot = store.memories("count", space, "hot")[0];
    assert.equal(hot.stage?.sourceIds.length, 5);
    const firstStageId = hot.stage!.id;
    assert.equal(mergeInputs[0].originals.length, 5);
    assert.equal(store.records("count").length, 5);
    assert.deepEqual(store.records("count", old.sourceIds), original);
    const evidence = await retrieve("count", "举例偏好", "expand");
    assert.equal(evidence.context.length, 1);
    assert.equal(evidence.context[0].kind, "summary");
    assert.equal(evidence.context[0].content, hot.summary);
    assert.equal(evidence.records.length, 0);
    assert.equal(evidence.trace.usage.records, 1);
    assert.equal(store.stage("different", firstStageId), undefined);
    assert.equal(store.stage("count", firstStageId)?.sourceIds.length, 5);
    const next = await remember("count", "仍然按需给例子", "收到", []);
    assert.equal(next.merged, 1); assert.equal(merges, 2);
    hot = store.memories("count", space, "hot")[0];
    assert.equal(hot.sourceIds.length, 6); assert.equal(hot.stage?.id, firstStageId);
    assert.equal(mergeInputs[1].originals.length, 1);
    assert.ok(mergeInputs[1].memories.some((m: any) => m.stage?.id === firstStageId));
    assert.ok(!JSON.stringify(mergeInputs[1]).includes(old.sourceIds[0]));
    const delta = await retrieve("count", "举例偏好", "expand");
    assert.equal(delta.context.length, 1);
    assert.equal(delta.context[0].id, hot.id);
    assert.equal(delta.context[0].kind, "summary");
    assert.deepEqual(delta.records, []);
    process.env.RAG_STAGE_SOURCE_THRESHOLD = "1";
    const third = await remember("count", "现在改为始终举例", "收到", []);
    assert.equal(third.merged, 1); assert.equal(merges, 3);
    hot = store.memories("count", space, "hot")[0];
    assert.equal(hot.sourceIds.length, 7); assert.equal(hot.stage?.sourceIds.length, 7);
    assert.notEqual(hot.stage?.id, firstStageId);
    assert.equal(mergeInputs[2].originals.length, 2);
    assert.ok(mergeInputs[2].memories.some((m: any) => m.stage?.id === firstStageId));
    assert.ok(!JSON.stringify(mergeInputs[2]).includes(old.sourceIds[0]));
    assert.deepEqual(store.records("count", old.sourceIds), original);
    process.env.RAG_STAGE_SOURCE_THRESHOLD = "5";
    seed("failure", 4); omitStage = true;
    const failed = await remember("failure", "更新偏好", "收到", []);
    assert.equal(failed.action, "partial"); assert.equal(failed.merged, 0); assert.equal(merges, 4);
    assert.deepEqual(store.stats("failure", space), { hot: 2, cold: 0, records: 5 });
    omitStage = false;
    process.env.RAG_STAGE_CHAR_THRESHOLD = "500";
    seed("long", 1, "原始长文".repeat(300));
    const long = await remember("long", "长文偏好更新", "收到", []);
    assert.equal(long.merged, 1); assert.equal(merges, 5);
    assert.equal(store.memories("long", space, "hot")[0].stage?.sourceIds.length, 2);
    assert.ok(mergeInputs[4].originals.some((r: any) => r.answer.length > 1000));
    // Thousands of archived IDs and texts do not inflate normal merge payloads.
    process.env.RAG_STAGE_CHAR_THRESHOLD = "12000";
    const big = seed("big", 1000);
    const bigStage = { id: "large-stage", content: "用户默认按需提供例子，时间和例外按历史摘要保留。", sourceIds: big.sourceIds, createdAt: big.createdAt };
    store.saveMemory({ ...big, id: "big-compressed", stage: bigStage });
    // Retire the deliberately seeded uncompressed copy to model a completed merge.
    const rawDb = new DatabaseSync(join(dir, "memory.sqlite"));
    rawDb.prepare("UPDATE memories SET status='cold' WHERE id=?").run(big.id); rawDb.close();
    const bigResult = await remember("big", "现在只按需提供例子", "收到", []);
    assert.equal(bigResult.merged, 1); assert.equal(merges, 6);
    assert.equal(mergeInputs[5].originals.length, 1);
    assert.ok(JSON.stringify(mergeInputs[5]).length < 4000);
    assert.equal(store.memories("big", space, "hot")[0].sourceIds.length, 1001);
    assert.ok(!JSON.stringify(mergeInputs[5]).includes(big.sourceIds[500]));
    const beforeLimit = merges;
    process.env.RAG_MERGE_INPUT_MAX_CHARS = "100";
    const limited = await remember("big", "再次更新", "收到", []);
    assert.equal(limited.action, "partial");
    assert.equal(limited.added, 1); assert.equal(limited.merged, 0);
    assert.equal(merges, beforeLimit);
    delete process.env.RAG_MERGE_INPUT_MAX_CHARS;
    // Stages remain archived; queries send hot summaries without stage or raw text.
    store.saveMemory({ ...hot, id: "alias", status: "hot" });
    const deduped = await retrieve("count", "举例偏好", "expand");
    assert.ok(deduped.context.every(e => e.kind === "summary"));
    assert.equal(deduped.records.length, 0);
    assert.deepEqual(store.memories("count", space, "hot").find(m => m.id === hot.id)?.stage, hot.stage);
    const bounded = retrieveFrom(store, "count", space, [1, 0], "expand", 0.5, { maxRecords: 1, maxContextChars: 2000 });
    assert.equal(bounded.context.length, 1);
    assert.ok(JSON.stringify(bounded.context).length <= 2000);
    assert.ok(estimateTokens(JSON.stringify(bounded.context)) <= bounded.trace.policy.maxEstimatedTokens);
    const reopened = new MemoryStore(join(dir, "memory.sqlite"));
    assert.deepEqual(reopened.memories("count", space, "hot")[0].stage, hot.stage);
    reopened.close();
  } finally {
    const g = globalThis as unknown as { ragStore?: MemoryStore }; g.ragStore?.close(); delete g.ragStore;
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compression starts at five uncovered sources; covered history does not count again", () => {
  const env = { ...process.env };
  delete process.env.RAG_STAGE_SOURCE_THRESHOLD;
  delete process.env.RAG_STAGE_CHAR_THRESHOLD;
  try {
    const m: Memory = { id: "m", scope: "a", space: "a", sourceIds: [], parentIds: [], summary: "fact", vector: [1], status: "hot", reason: "", createdAt: "date" };
    const ids = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const records: RecordEntry[] = ids.map(id => ({ id, scope: "a", question: "fact", answer: "ok", context: "", createdAt: "date" }));
    const n = { ...m, sourceIds: [ids[4]] };
    assert.equal(compressionPlan({ ...m, sourceIds: ids.slice(0, 3) }, { ...n, sourceIds: [ids[3]] }, records).required, false);
    assert.equal(compressionPlan({ ...m, sourceIds: ids.slice(0, 4) }, n, records).required, true);
    assert.equal(compressionPlan({ ...m, sourceIds: ids.slice(0, 5) }, { ...n, sourceIds: [ids[5]] }, records).required, true);
    const staged = { ...m, sourceIds: ids.slice(0, 9), stage: { id: "stage", content: "archive", sourceIds: ids.slice(0, 5), createdAt: "date" } };
    assert.equal(compressionPlan(staged, { ...n, sourceIds: [ids[8]] }, records).required, false);
    assert.equal(compressionPlan(staged, { ...n, sourceIds: [ids[9]] }, records).required, true);
    process.env.RAG_STAGE_CHAR_THRESHOLD = "500";
    const long = [{ ...records[0], question: "x".repeat(600) }];
    assert.equal(compressionPlan({ ...m, sourceIds: [ids[0]] }, { ...m, sourceIds: [] }, long).required, true);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env);
  }
});

test("legacy databases gain stage tables without changing original records", () => {
  const dir = mkdtempSync(join(tmpdir(), "rag-stage-legacy-")), path = join(dir, "legacy.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE records (id TEXT PRIMARY KEY, scope TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, context TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE memories (id TEXT PRIMARY KEY, scope TEXT NOT NULL, summary TEXT NOT NULL, vector TEXT NOT NULL, space TEXT NOT NULL, status TEXT NOT NULL, source_ids TEXT NOT NULL, parent_ids TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO records VALUES ('old', 'a', 'original question', 'original answer', 'full context', '2026-01-01');`);
  old.close();
  const store = new MemoryStore(path);
  try {
    const original = store.records("a")[0];
    const stage = { id: "stage", content: "单一事实历史整理。", sourceIds: ["old"], createdAt: "2026-01-02" };
    store.saveMemory({ id: "m", scope: "a", space: "test", summary: "单一事实", vector: [1], status: "hot", sourceIds: ["old"], parentIds: [], reason: "migration check", createdAt: stage.createdAt, stage });
    assert.deepEqual(store.records("a")[0], original);
    assert.deepEqual(store.stage("a", stage.id), stage);
    assert.deepEqual(store.memories("a")[0].stage, stage);
    assert.equal(store.stage("b", stage.id), undefined);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

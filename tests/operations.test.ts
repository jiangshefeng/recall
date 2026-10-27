import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { remember } from "../src/lib/rag";
import { getStore } from "../src/lib/store";
import { modelConfig } from "../src/lib/providers";
import { compactContexts } from "../src/lib/compact-context";
import { EvidenceBudget } from "../src/lib/evidence-budget";
import { normalizePolicy } from "../src/lib/retrieval";
import type { Memory, RecordEntry, Turn } from "../src/lib/types";

const turns: Turn[] = [{ role: "user", content: "重复的历史消息".repeat(80) }, { role: "assistant", content: "确认" }];
const record = (id: string, context = JSON.stringify(turns)): RecordEntry => ({
  id, scope: "s", question: "问题", answer: "回答", context, createdAt: "2026-01-01" });

test("request context references round-trip roles, order and repeated occurrences without changing raw records", () => {
  const records = [record("a"), record("b", JSON.stringify([...turns, turns[0]])), record("legacy", "旧文本")];
  const before = structuredClone(records);
  const compact = compactContexts(records);
  assert.equal(Object.keys(compact.contexts).length, 2);
  compact.originals.slice(0, 2).forEach((r, i) => {
    assert.ok("contextIds" in r);
    assert.deepEqual(r.contextIds!.map(id => compact.contexts[id]), JSON.parse(records[i].context));
  });
  assert.ok(JSON.stringify(compact).length < JSON.stringify(records).length);
  assert.deepEqual(records, before);
});

test("answer evidence deduplicates shared history but never refers to clipped messages", () => {
  const budget = new EvidenceBudget(normalizePolicy({ maxRecordChars: 5000 }));
  assert.equal(budget.add(record("a")), true);
  assert.equal(budget.add(record("b")), true);
  assert.ok(budget.context[1].content.includes('"contextRef":{"citation":1,"message":1}'));
  assert.ok(!budget.context[1].content.includes(turns[0].content));
  assert.deepEqual(budget.records[1], record("b"));
  const clipped = new EvidenceBudget(normalizePolicy({ maxRecordChars: 120 }));
  clipped.add(record("a")); clipped.add(record("b"));
  assert.equal(clipped.context[0].truncated, true);
  assert.ok(!clipped.context[1].content.includes("contextRef"));
});

test("one batch applies merge/replace/delete/add, rejects spoofed targets and deletion quotes, and audits operations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rag-operations-")), previous = { ...process.env };
  let action = "merge", invalidQuote = false, invalidTarget = false, mergeCalls = 0;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); res.setHeader("Content-Type", "application/json");
    if (req.url?.endsWith("embeddings")) { res.end(JSON.stringify({ data: [{ embedding: [1, 0] }] })); return; }
    let output: object;
    if (body.messages[0].content.includes("提炼当前问答")) output = { facts: ["用户的例子偏好及本轮变更。"] };
    else {
      mergeCalls++;
      const input = JSON.parse(body.messages[1].content);
      output = { decisions: input.jobs.map((j: { incomingId: string; candidateIds: string[] }) => ({
        incomingId: j.incomingId, action, candidateId: action === "add" ? null : invalidTarget ? "foreign-target" : j.candidateIds[0],
        relation: ({ merge: "complement", replace: "update", delete: "retract", add: "unrelated" } as Record<string, string>)[action],
        summary: "用户当前要求默认不举例。", reason: "本轮明确要求",
        deletionQuote: action === "delete" ? invalidQuote ? "没有说过的撤回" : "忘记我的例子偏好" : null, stageSummary: null,
      })) };
    }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
  });
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    Object.assign(process.env, { RAG_MODE: "live", RAG_DB_PATH: join(dir, "test.sqlite"),
      LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`, EMBEDDING_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      LLM_API_KEY: "test", EMBEDDING_API_KEY: "test", LLM_MODEL: "test", EMBEDDING_MODEL: "test" });
    const store = getStore(), space = modelConfig().space;
    for (const operation of ["merge", "replace", "delete", "add", "bad-quote", "bad-target"]) {
      action = operation.startsWith("bad-") ? "delete" : operation;
      invalidQuote = operation === "bad-quote"; invalidTarget = operation === "bad-target";
      const old: Memory = { id: `${operation}-old`, scope: operation, space, summary: "用户默认需要例子。", vector: [1, 0],
        status: "hot", sourceIds: [`${operation}-raw`], parentIds: [], reason: "seed", createdAt: "2026-01-01" };
      store.saveRecord({ ...record(old.sourceIds[0]), scope: operation }); store.saveMemory(old);
      const result = await remember(operation, "忘记我的例子偏好", "收到", turns);
      const hot = store.memories(operation, space, "hot");
      if (operation.startsWith("bad-")) {
        assert.equal(result.action, "partial"); assert.equal(hot.length, 2);
        assert.ok(hot.some(m => m.id === old.id));
      } else if (operation === "delete") {
        assert.equal(result.deleted, 1); assert.equal(hot.length, 0);
        assert.equal(store.records(operation).length, 2);
        assert.ok(store.memories(operation, space, "cold").some(m => m.parentIds.includes(old.id)));
        const incoming = { ...old, id: "stale-delete", sourceIds: [result.recordId] };
        assert.equal(store.retire(old.id, incoming, "stale"), false);
        assert.equal(store.retire("foreign-target", incoming, "wrong scope"), false);
      } else if (operation === "add") { assert.equal(result.added, 1); assert.equal(hot.length, 2); }
      else {
        assert.equal(result.merged, 1); assert.equal(result.replaced, operation === "replace" ? 1 : 0);
        assert.equal(hot.length, 1); assert.equal(hot[0].sourceIds.length, 2);
      }
    }
    assert.equal(mergeCalls, 6);
    const db = new DatabaseSync(join(dir, "test.sqlite"));
    const operations = db.prepare("SELECT action FROM memory_operations ORDER BY id").all(); db.close();
    assert.deepEqual(operations.map(r => r.action), ["merge", "replace", "delete"]);
    store.close(); delete (globalThis as { ragStore?: unknown }).ragStore;
  } finally {
    server.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous); rmSync(dir, { recursive: true, force: true });
  }
});

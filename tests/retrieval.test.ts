import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/lib/store";
import { retrieveFrom, normalizePolicy } from "../src/lib/retrieval";
import { estimateTokens } from "../src/lib/evidence-budget";
import type { Memory, RecordEntry, RetrievalPolicy } from "../src/lib/types";

const query = [1, 0];
test("low-score top three are isolated display candidates, never prompt evidence", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  for (let i = 0; i < 5; i++) add(store, `weak-${i}`, 0.45 - i * 0.05);
  add(store, "other-scope", 0.99, { scope: "private" });
  add(store, "other-model", 0.99, { space: "model-b" });
  add(store, "cold", 0.49, { status: "cold" });
  const result = retrieve(store);
  assert.deepEqual(result.suggestions?.map(x => x.id), ["weak-0", "weak-1", "weak-2"]);
  assert.equal(result.context.length, 0);
  assert.equal(result.records.length, 0);
  assert.equal(result.first.length, 0);
  assert.equal(result.second.length, 0);
  add(store, "relevant", 0.8);
  assert.deepEqual(retrieve(store).suggestions, []);
});
function vector(score: number) { return [score, Math.sqrt(1 - score * score)]; }
function original(id: string, answer = "订单缓存是五分钟，仅适用于测试环境。", scope = "a"): RecordEntry {
  return { id, scope, question: "订单缓存设置是什么？", answer, context: "用户提供的测试设定", createdAt: "2026-10-26T00:00:00Z" };
}
function add(store: MemoryStore, id: string, score: number, options: Partial<Memory> = {}, answer?: string) {
  const sourceIds = options.sourceIds || [id];
  const scope = options.scope || "a";
  for (const sourceId of sourceIds) if (!store.records(scope, [sourceId]).length) store.saveRecord(original(sourceId, answer, scope));
  store.saveMemory({ id, scope, summary: id, vector: vector(score), status: "hot", space: "model-a",
    sourceIds, parentIds: [], createdAt: "2026-10-26T00:00:00Z", reason: "test", ...options });
}
function retrieve(store: MemoryStore, options: Partial<RetrievalPolicy> = {}, strategy: "expand" | "sources" = "expand") {
  return retrieveFrom(store, "a", "model-a", query, strategy, 0.5, options);
}

test("default first round keeps at most three memories from twenty candidates", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  for (let i = 0; i < 25; i++) add(store, `hot-${i}`, 0.99 - i * 0.01);
  const result = retrieve(store);
  assert.equal(result.trace.firstCandidates, 20);
  assert.equal(result.first.length, 3);
  assert.equal(result.trace.expanded, false);
  assert.equal(result.trace.reason, "enough-first-results");
  assert.equal(result.second.length, 0);
});

test("default weak matches expand to at most three more memories", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  for (let i = 0; i < 12; i++) add(store, `weak-hit-${i}`, 0.7 - i * 0.01);
  const result = retrieve(store);
  assert.equal(result.first.length, 3);
  assert.equal(result.second.length, 3);
  assert.equal(result.trace.reason, "few-strong-results");
  assert.equal(result.records.length, 6);
});

test("one large event reads four recent candidates, sends only its newest two, and preserves all sources", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  const ids = Array.from({ length: 9 }, (_, i) => `event-${i + 1}`);
  for (const [i, id] of ids.entries()) store.saveRecord({ ...original(id), createdAt: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z` });
  store.saveRecord({ ...original("private-newest", "private", "private"), createdAt: "2026-11-01T00:00:00Z" });
  store.saveMemory({ id: "large-event", scope: "a", space: "model-a", summary: "一个长期事件", vector: vector(0.95),
    status: "hot", sourceIds: [...ids, "private-newest"], parentIds: [], reason: "test", createdAt: "2026-10-09T00:00:00Z" });
  const recent = store.recentRecords.bind(store);
  const loaded: string[][] = [];
  store.recentRecords = (scope, sourceIds, limit) => {
    const result = recent(scope, sourceIds, limit); loaded.push(result.map(r => r.id)); return result;
  };
  const result = retrieve(store, {}, "sources");
  assert.deepEqual(loaded, [["event-9", "event-8", "event-7", "event-6"]]);
  assert.deepEqual(result.records.map(r => r.id), ["event-9", "event-8"]);
  assert.deepEqual(result.first[0].includedSourceIds, ["event-9", "event-8"]);
  assert.equal(store.records("a").length, 9);
  assert.equal(store.memories("a")[0].sourceIds.length, 10);
  assert.ok(result.records.every(r => r.scope === "a"));
  const four = retrieve(store, { sourceLimitPerMemory: 4 }, "sources");
  assert.deepEqual(four.records.map(r => r.id), ["event-9", "event-8", "event-7", "event-6"]);
});

test("covered originals stay archived while the latest two deltas and the stage remain available", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  const ids = Array.from({ length: 9 }, (_, i) => `stage-event-${i + 1}`);
  for (const [i, id] of ids.entries()) store.saveRecord({ ...original(id), createdAt: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z` });
  add(store, "staged-event", 0.95, { sourceIds: ids, stage: { id: "stage", content: "前五条历史记录的阶段摘要", sourceIds: ids.slice(0, 5), createdAt: "2026-10-05T00:00:00Z" } });
  const result = retrieve(store, {}, "sources");
  assert.deepEqual(result.records.map(r => r.id), ["stage-event-9", "stage-event-8"]);
  assert.equal(result.stages?.length, 1);
  assert.equal(result.context.length, 3);
  assert.equal(store.records("a").length, 9);
  assert.equal(store.memories("a")[0].sourceIds.length, 9);
});

test("shared newest sources are not replaced with older history just to fill duplicate hits", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  const ids = ["r1", "r2", "r3", "r4"];
  for (const [i, id] of ids.entries()) store.saveRecord({ ...original(id), createdAt: `2026-10-0${i + 1}T00:00:00Z` });
  add(store, "event-a", 0.95, { sourceIds: ids });
  add(store, "event-b", 0.9, { sourceIds: ids });
  const result = retrieve(store, {}, "sources");
  assert.deepEqual(result.records.map(r => r.id), ["r4", "r3"]);
  assert.equal(result.first.length, 1);
});

test("two first-round hits trigger expansion; score is exactly 75% original plus 25% neighbor", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  add(store, "seed-a", 0.9); add(store, "seed-b", 0.85);
  add(store, "related-hot", 0.8);
  add(store, "old-preference", 0.99, { status: "cold" });
  const result = retrieve(store, { firstLimit: 2 });
  assert.equal(result.first.length, 2);
  assert.equal(result.trace.reason, "few-first-results");
  assert.equal(result.trace.expanded, true);
  assert.equal(result.second.length, 1);
  assert.equal(result.second[0].id, "related-hot");
  assert.ok([...result.first, ...result.second].every(x => x.status === "hot"));
  assert.ok(!result.records.some(x => x.id === "old-preference"));
  const hit = result.second[0];
  assert.equal(hit.score, hit.originalScore! * 0.75 + hit.neighborScore! * 0.25);
  assert.equal(result.records.length, 3);
});

test("enough records with few high-relevance hits still triggers a second round", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  add(store, "a", 0.65); add(store, "b", 0.64); add(store, "c", 0.63);
  add(store, "neighbor", 0.6);
  const result = retrieve(store, { firstLimit: 3 });
  assert.equal(result.trace.reason, "few-strong-results");
  assert.equal(result.trace.strongFirstResults, 0);
  assert.equal(result.second.length, 1);
});

test("a close neighbor below the original-query threshold is excluded before the branch cap", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  add(store, "seed", 0.8, { vector: [0.8, 0.6, 0] });
  add(store, "off-topic", 0.49, { vector: [0.49, Math.sqrt(1 - 0.49 ** 2), 0] });
  add(store, "on-topic", 0.6, { vector: [0.6, 0.2, Math.sqrt(0.6)] });
  const result = retrieveFrom(store, "a", "model-a", [1, 0, 0], "expand", 0.5, { firstLimit: 1, neighborsPerSeed: 1 });
  assert.deepEqual(result.second.map(x => x.id), ["on-topic"]);
  assert.ok(Math.abs(result.second[0].score - 0.6) < 1e-10);
});

test("multiple summaries sharing one original do not consume duplicate slots or tokens", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  add(store, "seed-a", 0.9); add(store, "seed-b", 0.85);
  add(store, "alias-a", 0.8, { sourceIds: ["shared"] });
  add(store, "alias-b", 0.79, { sourceIds: ["shared"] });
  const result = retrieve(store, { firstLimit: 2 });
  assert.equal(result.second.length, 1);
  assert.equal(result.records.length, 3);
  assert.equal(new Set(result.context.map(x => x.id)).size, result.context.length);
  assert.equal(result.trace.usage.chars, JSON.stringify(result.context).length);
  assert.equal(result.trace.usage.estimatedTokens, estimateTokens(JSON.stringify(result.context)));
});

test("merged summary with many originals obeys the total record limit and prevents further expansion", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  add(store, "merged", 0.95, { sourceIds: Array.from({ length: 10 }, (_, i) => `source-${i}`) });
  add(store, "cold", 0.9, { status: "cold" });
  const result = retrieve(store, { maxRecords: 3, sourceLimitPerMemory: 4 });
  assert.equal(result.records.length, 3);
  assert.equal(result.first.length, 1);
  assert.equal(result.first[0].includedSourceIds!.length, 3);
  assert.equal(result.trace.reason, "budget-exhausted");
  assert.equal(result.trace.expanded, false);
  assert.equal(store.records("a").length, 11);
});

test("character budget is applied to serialized evidence, and clipping never overwrites originals", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  const full = '长文本包含引号"以及换行\n'.repeat(200);
  add(store, "long", 0.95, {}, full);
  add(store, "cold", 0.9, { status: "cold" });
  const result = retrieve(store, { maxContextChars: 400 });
  assert.ok(result.context.length > 0);
  assert.ok(JSON.stringify(result.context).length <= 400);
  assert.equal(result.context[0].truncated, true);
  assert.equal(result.trace.reason, "budget-exhausted");
  assert.equal(result.trace.expanded, false);
  assert.equal(store.records("a", ["long"])[0].answer, full);
});

test("estimated token budget is independent from character budget", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  add(store, "chinese", 0.95, {}, "缓存配置仅用于测试环境。".repeat(300));
  const result = retrieve(store, { maxEstimatedTokens: 240, maxContextChars: 18_000 });
  assert.equal(result.context.length, 1);
  assert.ok(estimateTokens(JSON.stringify(result.context)) <= 240);
  assert.ok(result.trace.usage.chars < 18_000);
  assert.equal(result.context[0].truncated, true);
  assert.equal(result.trace.reason, "budget-exhausted");
});

test("per-record cap preserves Unicode and exact prompt-to-citation mapping", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  add(store, "unicode", 0.95, {}, "𠮷😀".repeat(300));
  add(store, "short", 0.9);
  const result = retrieve(store, { maxRecordChars: 129 }, "sources");
  assert.equal(result.records.length, 2);
  for (const [i, snippet] of result.context.entries()) {
    assert.ok(snippet.content.length <= 129);
    assert.ok(!/[\uD800-\uDBFF]$/.test(snippet.content));
    assert.equal(snippet.citation, i + 1);
    assert.equal(snippet.id, result.records[i].id);
  }
  assert.equal(result.trace.reason, "sources-only");
  assert.equal(result.second.length, 0);
});

test("no qualifying first-round results means no expansion and no forced filling", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  add(store, "low", 0.1); add(store, "cold-only", 0.99, { status: "cold" });
  const result = retrieve(store);
  assert.equal(result.first.length, 0);
  assert.equal(result.second.length, 0);
  assert.equal(result.trace.reason, "no-first-results");
  assert.equal(result.context.length, 0);
});

test("first/second rounds share the final record budget", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  add(store, "seed-a", 0.9); add(store, "seed-b", 0.85);
  for (let i = 0; i < 8; i++) add(store, `hot-neighbor-${i}`, 0.8 - i * 0.01);
  const result = retrieve(store, { firstLimit: 2, maxRecords: 4 });
  assert.equal(result.first.length, 2);
  assert.equal(result.second.length, 2);
  assert.equal(result.records.length, 4);
});

test("bad numeric settings fall back or clamp rather than disabling limits", () => {
  const policy = normalizePolicy({ firstCandidates: NaN, firstLimit: 1_000_000, maxRecords: -1,
    maxEstimatedTokens: Infinity, strongScore: 8, sourceCandidatesPerMemory: 999, sourceLimitPerMemory: 999 });
  assert.equal(policy.firstCandidates, 20);
  assert.equal(policy.firstLimit, 20);
  assert.equal(policy.maxRecords, 1);
  assert.equal(policy.maxEstimatedTokens, 6000);
  assert.equal(policy.strongScore, 1);
  assert.equal(policy.sourceCandidatesPerMemory, 4);
  assert.equal(policy.sourceLimitPerMemory, 4);
  assert.equal(normalizePolicy({ sourceCandidatesPerMemory: 1, sourceLimitPerMemory: 4 }).sourceLimitPerMemory, 1);
});

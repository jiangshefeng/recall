import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cosine, ranked } from "../src/lib/similarity";
import { MemoryStore } from "../src/lib/store";
import { retrieveFrom } from "../src/lib/rag";
import type { Memory } from "../src/lib/types";

function memory(id: string, vector: number[], overrides: Partial<Memory> = {}): Memory {
  return { id, scope: "a", summary: id, vector, space: "test", status: "hot", sourceIds: [id], parentIds: [], reason: "test", createdAt: new Date().toISOString(), ...overrides };
}
test("cosine and ranking reject incompatible vectors and exclude unrelated results", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1], [1, 0]), 0);
  assert.equal(cosine([0, 0], [1, 0]), 0);
  assert.deepEqual(ranked([memory("yes", [1, 0]), memory("no", [0, 1])], [1, 0], 3, 0.5).map(x => x.id), ["yes"]);
});
test("merge retains both cold parents and all originals; concurrent stale merge is rejected", () => {
  const store = new MemoryStore(":memory:");
  try {
    for (const id of ["one", "two"]) store.saveRecord({ id, scope: "a", question: id, answer: "answer", context: "", createdAt: "2026-01-01" });
    const first = memory("one", [1, 0]), second = memory("two", [1, 0]);
    store.saveMemory(first);
    const merged = memory("merged", [1, 0], { sourceIds: ["one", "two"], parentIds: ["one", "two"] });
    assert.equal(store.merge(first.id, second, merged), true);
    assert.equal(store.merge(first.id, memory("three", [1, 0]), memory("other", [1, 0])), false);
    const result = store.memories("a");
    assert.equal(result.filter(m => m.status === "cold").length, 2);
    assert.equal(result.filter(m => m.status === "hot").length, 1);
    assert.equal(store.records("a", merged.sourceIds).length, 2);
    assert.equal(store.records("other", merged.sourceIds).length, 0);
  } finally { store.close(); }
});
test("retrieval isolates scopes/models, removes duplicate second-hop hits and preserves provenance", () => {
  const store = new MemoryStore(":memory:");
  try {
    for (const [id, vector, overrides] of [
      ["a1", [1, 0], {}], ["a2", [1, 0.1], {}], ["a3", [1, 0.2], {}], ["a4", [1, 0.3], {}],
      ["cold", [1, 0.15], { status: "cold" }], ["irrelevant", [0, 1], {}],
      ["secret", [1, 0], { scope: "b" }], ["other-model", [1, 0], { space: "other" }],
    ] as [string, number[], Partial<Memory>][]) {
      const m = memory(id, vector, overrides);
      store.saveMemory(m);
      store.saveRecord({ id, scope: m.scope, question: id, answer: "answer", context: "", createdAt: "2026-01-01" });
    }
    const expanded = retrieveFrom(store, "a", "test", [1, 0], "expand", 0.5, { firstLimit: 3, minFirstResults: 4 });
    assert.deepEqual(expanded.first.map(x => x.id), ["a1", "a2", "a3"]);
    assert.deepEqual(expanded.second.map(x => x.id), ["a4"]);
    assert.equal(expanded.records.length, 4);
    const direct = retrieveFrom(store, "a", "test", [1, 0], "sources", 0.5);
    assert.equal(direct.second.length, 0);
    assert.equal(direct.records.length, 4);
  } finally { store.close(); }
});

test("repair merges two persisted memories atomically without duplicating originals", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  const old = memory("old", [1, 0]), current = memory("current", [1, 0]);
  for (const m of [old, current]) {
    store.saveMemory(m);
    store.saveRecord({ id: m.id, scope: "a", question: m.id, answer: "", context: "", createdAt: m.createdAt });
  }
  assert.equal(store.merge(old.id, { ...current, scope: "other" }, memory("wrong", [1, 0]), true), false);
  assert.equal(store.stats("a", "test").hot, 2);
  const merged = memory("merged-stored", [1, 0], { sourceIds: [old.id, current.id], parentIds: [old.id, current.id] });
  assert.equal(store.merge(old.id, current, merged, true), true);
  assert.deepEqual(store.stats("a", "test"), { hot: 1, cold: 2, records: 2 });
  assert.equal(store.merge(old.id, current, { ...merged, id: "stale" }, true), false);
});

test("successive merges flatten all source IDs and retrieval never reads cold summaries", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  for (const id of ["one", "two", "three"]) store.saveRecord({ id, scope: "a", question: id, answer: "original", context: "[]", createdAt: "2026-01-01" });
  const one = memory("one", [1, 0]);
  store.saveMemory(one);
  const firstMerge = memory("merged-12", [1, 0], { sourceIds: ["one", "two"], parentIds: ["one", "two"] });
  assert.ok(store.merge(one.id, memory("two", [1, 0]), firstMerge));
  const final = memory("merged-123", [1, 0], { sourceIds: ["one", "two", "three"], parentIds: [firstMerge.id, "three"] });
  assert.ok(store.merge(firstMerge.id, memory("three", [1, 0]), final));
  assert.deepEqual(store.stats("a", "test"), { hot: 1, cold: 4, records: 3 });
  const readMemories = store.memories.bind(store);
  let reads = 0;
  store.memories = (scope, space, status) => {
    reads++;
    assert.equal(status, "hot");
    return readMemories(scope, space, status);
  };
  const result = retrieveFrom(store, "a", "test", [1, 0], "expand", 0.5);
  assert.equal(reads, 1);
  assert.deepEqual(result.first.map(m => m.id), [final.id]);
  assert.equal(result.second.length, 0);
  assert.deepEqual(result.records.map(r => r.id).sort(), ["one", "three", "two"]);
  assert.equal(result.context.length, 3);
});
test("SQLite records and vectors survive reopening the database", () => {
  const dir = mkdtempSync(join(tmpdir(), "rag-test-"));
  const path = join(dir, "memory.sqlite");
  let store: MemoryStore | undefined;
  try {
    store = new MemoryStore(path);
    store.saveMemory(memory("durable", [0.3, 0.8]));
    store.saveRecord({ id: "durable", scope: "a", question: "question", answer: "answer", context: "context", createdAt: "2026-01-01" });
    store.close(); store = new MemoryStore(path);
    assert.deepEqual(store.memories("a")[0].vector, [0.3, 0.8]);
    assert.equal(store.records("a")[0].context, "context");
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

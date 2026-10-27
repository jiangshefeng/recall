import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStore, MemoryStore } from "../src/lib/store";

test("a globally cached legacy store gains new methods and audit tables without closing or losing records", () => {
  const dir = mkdtempSync(join(tmpdir(), "rag-cache-upgrade-")), path = join(dir, "test.sqlite");
  const cache = globalThis as { ragStore?: MemoryStore; ragStoreSchemaVersion?: number };
  const old = new MemoryStore(path);
  const record = { id: "r", scope: "a", question: "原始问题", answer: "原始回答", context: "[]", createdAt: "2026-01-01" };
  old.saveRecord(record);
  const memory = { id: "m", scope: "a", summary: "事实", vector: [1], space: "test", status: "hot" as const,
    sourceIds: ["r"], parentIds: [], reason: "seed", createdAt: record.createdAt };
  old.saveMemory(memory);
  const db = new DatabaseSync(path); db.exec("DROP TABLE memory_operations; DROP TABLE memory_kinds");
  cache.ragStore = old; delete cache.ragStoreSchemaVersion;
  // Emulate an object retained from an older module with no new prototype methods.
  Object.setPrototypeOf(old, {});
  try {
    const updated = getStore();
    assert.equal(updated, old);
    assert.deepEqual(updated.records("a"), [record]);
    assert.equal(updated.memories("a")[0].kind, "fact");
    updated.saveMemory({ ...memory, id: "qa", kind: "qa", summary: "用户询问排序方法，助手介绍二分查找。" });
    assert.equal(updated.memories("a").find(m => m.id === "qa")?.kind, "qa");
    const reopened = new MemoryStore(path);
    assert.equal(reopened.memories("a").find(m => m.id === "qa")?.kind, "qa");
    reopened.close();
    assert.equal(updated.retire("m", { ...memory, id: "retraction" }, "撤回"), true);
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_operations").get()!.count, 1);
    assert.deepEqual(updated.records("a"), [record]);
    assert.equal(getStore(), updated);
  } finally {
    cache.ragStore?.close(); delete cache.ragStore; delete cache.ragStoreSchemaVersion;
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/lib/store";
import { retrieveFrom, normalizePolicy } from "../src/lib/retrieval";
import { estimateTokens } from "../src/lib/evidence-budget";
import type { Memory, RecordEntry, RetrievalPolicy } from "../src/lib/types";

const query = [1, 0];
function vector(score: number) { return [score, Math.sqrt(1 - score * score)]; }
function original(id: string, scope = "a"): RecordEntry {
  return { id, scope, question: `original question ${id}`, answer: `original answer ${id}`, context: "private context", createdAt: "2026-10-26T00:00:00Z" };
}
function add(store: MemoryStore, id: string, score: number, options: Partial<Memory> = {}) {
  const sourceIds = options.sourceIds || [id];
  const scope = options.scope || "a";
  for (const sourceId of sourceIds) if (!store.records(scope, [sourceId]).length) store.saveRecord(original(sourceId, scope));
  store.saveMemory({ id, scope, summary: `summary ${id}`, vector: vector(score), status: "hot", space: "model-a",
    sourceIds, parentIds: [], createdAt: "2026-10-26T00:00:00Z", reason: "test", ...options });
}
function retrieve(store: MemoryStore, options: Partial<RetrievalPolicy> = {}, strategy: "expand" | "sources" = "expand") {
  return retrieveFrom(store, "a", "model-a", query, strategy, 0.45, options);
}

test("first round retrieves up to five thresholded summaries and never reads source records", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  for (let i = 0; i < 40; i++) add(store, `hot-${i}`, 0.99 - i * 0.01, { sourceIds: [`source-${i}`, `source-extra-${i}`] });
  add(store, "below-threshold", 0.449);
  add(store, "cold", 0.99, { status: "cold" });
  let sourceReads = 0;
  store.recentRecords = () => { sourceReads++; throw Error("Original text must not be read"); };
  store.records = () => { sourceReads++; throw Error("Original text must not be read"); };

  const result = retrieve(store);
  assert.equal(result.first.length, 5);
  assert.equal(result.second.length, 0);
  assert.equal(result.context.length, 5);
  assert.equal(result.records.length, 0);
  assert.equal(result.stages?.length || 0, 0);
  assert.equal(sourceReads, 0);
  assert.ok(result.context.every(entry => entry.kind === "summary"));
  assert.ok(result.context.every(entry => result.first.some(hit => hit.id === entry.id && hit.summary === entry.content)));
  assert.equal(result.trace.reason, "no-linked-results");
});

test("the 0.45 boundary is inclusive; below-threshold suggestions stay out of evidence", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  add(store, "at-threshold", 0.45);
  add(store, "below", 0.449);
  const result = retrieve(store);
  assert.deepEqual(result.first.map(hit => hit.id), ["at-threshold"]);
  assert.equal(result.context[0].content, "summary at-threshold");
  assert.deepEqual(result.suggestions, []);
});

test("zero threshold matches do not expand and expose only the three closest suggestions", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  add(store, "weak-a", 0.3); add(store, "weak-b", 0.2); add(store, "weak-c", 0.1); add(store, "weak-d", 0.05);
  const result = retrieve(store);
  assert.equal(result.first.length, 0);
  assert.equal(result.second.length, 0);
  assert.equal(result.context.length, 0);
  assert.deepEqual(result.suggestions?.map(hit => hit.id), ["weak-a", "weak-b", "weak-c"]);
  assert.equal(result.trace.reason, "no-first-results");
});

test("expansion uses shared source IDs rather than seed-vector similarity or the query threshold", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  add(store, "seed", 0.9, { sourceIds: ["shared"] });
  add(store, "related-below-query-threshold", 0.4, { sourceIds: ["shared"] });
  add(store, "unlinked-high-seed-similarity", 0.4);
  add(store, "related-weak-score", 0.1, { sourceIds: ["shared"] });
  const result = retrieve(store);
  assert.equal(result.first.length, 1);
  assert.equal(result.trace.reason, "source-linked-results");
  assert.equal(result.trace.expanded, true);
  assert.deepEqual(result.second.map(hit => hit.id), ["related-below-query-threshold", "related-weak-score"]);
  assert.ok(result.second[0].originalScore! < 0.45);
  assert.equal(result.second[0].score, result.second[0].originalScore);
  assert.equal(result.second[0].via, "seed");
  assert.equal(result.records.length, 0);
});

test("five seeds expand once; duplicate sources, cold versions and newly linked sources cannot add repeated or recursive evidence", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  for (let i = 0; i < 5; i++) add(store, `seed-${i}`, 0.99 - i * 0.05, { sourceIds: ["shared", "shared"] });
  add(store, "related", 0.4, { sourceIds: ["shared", "new-source"] });
  add(store, "recursive", 0.3, { sourceIds: ["new-source"] });
  add(store, "cold-related", 0.4, { sourceIds: ["shared"], status: "cold" });
  store.saveMemory({ ...store.memories("a")[0], id: "other-scope", scope: "b", vector: vector(0.4) });
  add(store, "other-space", 0.4, { sourceIds: ["shared"], space: "other" });
  const result = retrieve(store);
  assert.equal(result.first.length, 5);
  assert.equal(result.trace.expanded, true);
  assert.deepEqual(result.second.map(hit => hit.id), ["related"]);
  assert.equal(new Set(result.context.map(e => e.id)).size, result.context.length);
});

test("first and second round share an absolute fifteen-summary cap", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  add(store, "seed", 0.9, { sourceIds: ["shared"] });
  for (let i = 0; i < 40; i++) add(store, `neighbor-${i}`, 0.4, { sourceIds: ["shared"] });
  const result = retrieve(store, { maxRecords: 100, secondLimit: 100 });
  assert.equal(result.first.length, 1);
  assert.equal(result.second.length, 14);
  assert.equal(result.context.length, 15);
  assert.equal(result.trace.policy.maxRecords, 15);
  assert.equal(normalizePolicy({ maxRecords: 100 }).maxRecords, 15);
});

test("summary context obeys character, token, truncation, and citation limits without modifying originals", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close());
  const longSummary = "Concrete summary with preserved names, dates, items, and values. ".repeat(30);
  add(store, "long-summary", 0.95, { summary: longSummary });
  const result = retrieve(store, { maxRecordChars: 129 });
  assert.equal(result.records.length, 0);
  assert.equal(result.context.length, 1);
  assert.equal(result.context[0].truncated, true);
  assert.ok(result.context[0].content.length <= 129);
  assert.equal(result.context[0].id, result.first[0].id);
  assert.equal(result.context[0].citation, 1);
  assert.ok(!/[\uD800-\uDBFF]$/.test(result.context[0].content));
  assert.equal(store.memories("a")[0].summary, longSummary);
  assert.equal(store.records("a", ["long-summary"])[0].answer, "original answer long-summary");
  assert.ok(JSON.stringify(result.context).length <= result.trace.policy.maxContextChars);
  assert.ok(estimateTokens(JSON.stringify(result.context)) <= result.trace.policy.maxEstimatedTokens);
});

test("bad numeric settings fall back or clamp to the new policy", () => {
  const policy = normalizePolicy({ firstCandidates: NaN, firstLimit: 1_000_000, maxRecords: 100,
    maxEstimatedTokens: Infinity, sourceCandidatesPerMemory: 999, sourceLimitPerMemory: 999 });
  assert.equal(policy.firstCandidates, 100);
  assert.equal(policy.firstLimit, 15);
  assert.equal(policy.maxRecords, 15);
  assert.equal(policy.maxEstimatedTokens, 6000);
  assert.equal(policy.sourceCandidatesPerMemory, 4);
  assert.equal(policy.sourceLimitPerMemory, 4);
  assert.equal(normalizePolicy({ sourceCandidatesPerMemory: 1, sourceLimitPerMemory: 4 }).sourceLimitPerMemory, 1);
});

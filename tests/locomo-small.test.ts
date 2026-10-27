import test from "node:test";
import assert from "node:assert/strict";
import { makeSmallPlan, plainChunks, reserveTokens, remainingAllows, chargeUsage, type Sample, type SourceTurn } from "../scripts/locomo-small-support";

test("small LoCoMo plan excludes questions with missing/future evidence, preserving whole sessions", () => {
  const sample: Sample = { sample_id: "synthetic", conversation: {
    session_1_date_time: "1:00 pm on 1 January, 2024", session_1: [{ speaker: "A", dia_id: "D1:1", text: "public synthetic fact" }],
    session_2_date_time: "1:00 pm on 2 January, 2024", session_2: [{ speaker: "A", dia_id: "D2:1", text: "future" }],
  }, qa: [
    { question: "known", category: 4, evidence: ["D1:1"] }, { question: "future", category: 1, evidence: ["D1:1", "D2:1"] },
    { question: "missing", category: 3, evidence: [] }, { question: "unknown", category: 5, evidence: [] },
  ] };
  const plan = makeSmallPlan(sample, 1);
  assert.deepEqual(plan.selected.map(q => q.index), [0, 3]); assert.equal(plan.turns.length, 1);
  assert.equal(plan.turns[0].date, "2024-01-01T13:00:00.000Z"); assert.deepEqual(plan.turns[0].history, []);
});

test("plain RAG chunks cover every turn and overlap without leaking another session or looping on long text", () => {
  const turns: SourceTurn[] = Array.from({ length: 9 }, (_, i) => ({ id: `D${i}`, session: i < 6 ? "s1" : "s2",
    sourceDate: "synthetic", date: "2024-01-01", content: `speaker ${i}: ` + "x".repeat(i === 8 ? 600 : 70), history: [] }));
  const chunks = plainChunks(turns, 250);
  assert.deepEqual([...new Set(chunks.flatMap(c => c.sourceIds))].sort(), turns.map(t => t.id).sort());
  assert.ok(chunks.every(c => new Set(c.sourceIds.map(id => turns.find(t => t.id === id)!.session)).size === 1));
  assert.ok(chunks[0].sourceIds.some(id => chunks[1].sourceIds.includes(id)));
  assert.ok(chunks.at(-1)!.content.includes("x".repeat(600)));
});

test("token guard counts both input and output, preserves unknown charges, and reserves before a request", () => {
  const reserve = reserveTokens({ max_tokens: 100, messages: [{ content: "中文 synthetic" }] });
  assert.ok(reserve > 2148);
  const item = { chargedTokens: reserve, reserveTokens: reserve, phase: "test", status: "pending" };
  assert.equal(remainingAllows([item], 1, reserve), false);
  assert.equal(chargeUsage(item, {}), false); assert.equal(item.chargedTokens, reserve);
  assert.equal(chargeUsage(item, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 17 }), true);
  assert.equal(item.chargedTokens, 17); assert.equal(remainingAllows([item], 3, 20), true);
});

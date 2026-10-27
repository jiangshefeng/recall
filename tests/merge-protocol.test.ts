import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mergeEnvelope, mergeSchema, validateMergeDecisions } from "../src/lib/merge-protocol";
import { parseStructured, StructuredOutputError } from "../src/lib/structured-output";
import { structured } from "../src/lib/providers";
import { remember } from "../src/lib/rag";
import { getStore } from "../src/lib/store";

const jobs = ["a", "b"].map(id => ({ incoming: { id }, candidates: [{ id: `old-${id}` }] }));
const decision = (incomingId: string) => ({ incomingId, candidateId: `old-${incomingId}`, relation: "duplicate",
  summary: "synthetic public fact", reason: "same attribute" });

test("one invalid decision no longer discards its valid sibling; legacy actions still work", () => {
  const items = [decision("a"), { ...decision("b"), summary: "x".repeat(701) }];
  assert.equal(z.object({ decisions: z.array(mergeSchema.extend({ incomingId: z.string() })) }).safeParse({ decisions: items }).success, false);
  const result = validateMergeDecisions(items, jobs, "stop");
  assert.deepEqual(result.decisions.map(d => d.incomingId), ["a"]);
  assert.deepEqual(result.diagnostics, [{ stage: "decision", code: "too_big", path: "decisions.1.summary", incomingId: "b", finishReason: "stop" }]);
});

test("duplicate ID including malformed sibling invalidates that job; unknown and missing IDs cannot mutate", () => {
  const duplicate = validateMergeDecisions([decision("a"), { incomingId: "a" }, decision("b")], jobs);
  assert.deepEqual(duplicate.decisions.map(d => d.incomingId), ["b"]);
  assert.ok(duplicate.diagnostics.some(d => d.code === "duplicate_incoming" && d.incomingId === "a"));
  const unknown = validateMergeDecisions([decision("unknown"), decision("b")], jobs);
  assert.deepEqual(unknown.decisions.map(d => d.incomingId), ["b"]);
  assert.ok(unknown.diagnostics.some(d => d.code === "unknown_incoming" && !d.incomingId));
  assert.ok(unknown.diagnostics.some(d => d.code === "missing_incoming" && d.incomingId === "a"));
  assert.equal(validateMergeDecisions([{ ...decision("a"), candidateId: "spoofed" }], jobs).decisions.length, 0);
});

test("JSON, envelope and field errors carry safe paths without private output", () => {
  for (const [text, stage, path] of [["PRIVATE non-json", "json", "$"], ["{}", "schema", "decisions"]]) {
    assert.throws(() => parseStructured(text, mergeEnvelope, "length"), error => {
      assert.ok(error instanceof StructuredOutputError);
      assert.equal(error.diagnostics[0].stage, stage); assert.equal(error.diagnostics[0].path, path);
      assert.equal(error.diagnostics[0].finishReason, "length"); assert.ok(!error.message.includes("PRIVATE")); return true;
    });
  }
  const missing = validateMergeDecisions([{ incomingId: "a", private: "SECRET" }, decision("b")], jobs);
  assert.ok(missing.diagnostics.some(d => d.path === "decisions.0.candidateId" && d.code === "invalid_type"));
  assert.ok(!JSON.stringify(missing.diagnostics).includes("SECRET"));
});

test("provider preserves length finish reason and never retries invalid structured output", async () => {
  const env = { ...process.env }, fetch = globalThis.fetch;
  let calls = 0;
  try {
    Object.assign(process.env, { LLM_API_KEY: "synthetic-key", LLM_MODEL: "mock" });
    globalThis.fetch = async () => { calls++; return Response.json({ choices: [{ message: { content: '{"decisions":[' }, finish_reason: "length" }] }); };
    await assert.rejects(structured("synthetic", {}, mergeEnvelope), error => {
      assert.ok(error instanceof StructuredOutputError); assert.equal(error.diagnostics[0].finishReason, "length"); return true;
    });
    assert.equal(calls, 1);
  } finally { process.env = env; globalThis.fetch = fetch; }
});

test("actual writes retain valid merge and independently save malformed sibling with one LLM batch", async () => {
  const env = { ...process.env }, fetch = globalThis.fetch, warn = console.warn;
  let mergeCalls = 0, invalid = false;
  const logs: string[] = [];
  try {
    Object.assign(process.env, { RAG_MODE: "live", RAG_DB_PATH: ":memory:", LLM_API_KEY: "synthetic-key", LLM_MODEL: "mock",
      LLM_BASE_URL: "http://mock/v1", EMBEDDING_BASE_URL: "http://mock/v1", EMBEDDING_MODEL: "mock" });
    console.warn = (...values) => { logs.push(values.join(" ")); };
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(input).endsWith("embeddings")) {
        const texts = Array.isArray(body.input) ? body.input : [body.input];
        return Response.json({ data: texts.map((_: string, index: number) => ({ index, embedding: [1, 0] })) });
      }
      const data = JSON.parse(body.messages[1].content);
      let content: unknown;
      if (!data.jobs) content = { facts: ["synthetic A", "synthetic B"] };
      else {
        mergeCalls++;
        content = { decisions: data.jobs.map((job: { incomingId: string; candidateIds: string[] }, i: number) => ({
          ...decision(job.incomingId), candidateId: job.candidateIds[i], summary: invalid && i === 1 ? "PRIVATE".repeat(101) : "synthetic merged A",
        })) };
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] });
    };
    await remember("protocol-test", "initial", "ack", []); invalid = true;
    const result = await remember("protocol-test", "new", "ack", []);
    assert.equal(result.action, "partial"); assert.equal(result.merged, 1); assert.equal(result.added, 1);
    assert.equal(mergeCalls, 1);
    assert.equal(getStore().stats("protocol-test", getStore().memories("protocol-test")[0].space).records, 2);
    assert.ok(result.diagnostics.some(d => d.path === "decisions.1.summary"));
    assert.ok(!logs.join().includes("PRIVATE")); assert.ok(!logs.join().includes("synthetic-key"));
    assert.equal(getStore().memories("protocol-test", undefined, "hot").length, 3);
  } finally { process.env = env; globalThis.fetch = fetch; console.warn = warn; }
});

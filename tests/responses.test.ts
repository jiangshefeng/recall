import test from "node:test";
import assert from "node:assert/strict";
import { readResponses } from "../src/lib/responses";
import { complete } from "../src/lib/providers";

const terminal = (status = "completed", text = "你好") => ({ status,
  incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
  output: [{ type: "reasoning", summary: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
});
const stream = (events: unknown[]) => new Response(events.map(data => `data: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

test("Responses requires completion and excludes reasoning from answer text", async () => {
  const deltas: string[] = [], reasons: string[] = [];
  const answer = await readResponses(stream([{ type: "response.reasoning_summary_text.delta", delta: "private reasoning" },
    { type: "response.output_text.delta", delta: "你" }, { type: "response.output_text.delta", delta: "好" },
    { type: "response.completed", response: terminal() }]), t => deltas.push(t), m => reasons.push(m.finishReason!));
  assert.equal(answer, "你好"); assert.deepEqual(deltas, ["你", "好"]); assert.deepEqual(reasons, ["stop"]);
  await assert.rejects(readResponses(stream([{ type: "response.output_text.delta", delta: "partial" }])), /未正常结束/);
  await assert.rejects(readResponses(stream([{ type: "response.failed", response: { status: "failed" } }])), /生成错误/);
});

test("Responses maps truncation metadata for structured output but refuses incomplete streamed answers", async () => {
  let reason: string | undefined;
  const events = [{ type: "response.incomplete", response: terminal("incomplete", "{\"partial\":") }];
  assert.equal(await readResponses(stream(events), undefined, m => { reason = m.finishReason; }), "{\"partial\":");
  assert.equal(reason, "length");
  await assert.rejects(readResponses(stream(events), () => {}), /未完成/);
});

test("Responses provider sends its own protocol and preserves existing chat default", async () => {
  const previous = { ...process.env }, realFetch = globalThis.fetch;
  try {
    Object.assign(process.env, { LLM_API_STYLE: "responses", LLM_BASE_URL: "https://example.invalid/v1", LLM_API_KEY: "synthetic", LLM_MODEL: "synthetic", LLM_REASONING_EFFORT: "low" });
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://example.invalid/v1/responses");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.instructions, "system"); assert.equal(body.stream, true); assert.equal(body.store, false);
      assert.equal(body.max_output_tokens, 123); assert.equal(body.max_tokens, undefined); assert.equal(body.temperature, undefined);
      assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_text", text: "question" }] }]);
      return stream([{ type: "response.completed", response: terminal("completed", "answer") }]);
    };
    assert.equal(await complete("system", [{ role: "user", content: "question" }], 123), "answer");
    delete process.env.LLM_API_STYLE;
    globalThis.fetch = async (input) => {
      assert.equal(String(input), "https://example.invalid/v1/chat/completions");
      return new Response(JSON.stringify({ choices: [{ message: { content: "chat" } }] }));
    };
    assert.equal(await complete("system", [{ role: "user", content: "question" }]), "chat");
  } finally {
    globalThis.fetch = realFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

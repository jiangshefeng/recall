import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSSE } from "../src/lib/sse";
import { complete } from "../src/lib/providers";
import { POST } from "../src/app/api/chat/route";
import { getStore } from "../src/lib/store";

test("SSE handles split UTF-8, CRLF, comments, multiline data and a trailing event", async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\nevent: delta\r\ndata: 你好\r\ndata: 世界\r\n\r\ndata: [DONE]');
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close();
  } });
  const events = []; for await (const event of readSSE(body)) events.push(event);
  assert.deepEqual(events, [{ event: "delta", data: "你好\n世界" }, { event: "message", data: "[DONE]" }]);
});

test("live answers stream before completion; memory waits for the full answer and rejects interrupted output", async () => {
  const previous = { ...process.env }, dir = mkdtempSync(join(tmpdir(), "rag-stream-"));
  let release = () => {}, held = true, truncated = false, upstreamComplete = false, extracted = 0;
  let gate = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url?.endsWith("embeddings")) {
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ embedding: [1, 0] }] })); return;
    }
    if (!body.stream) {
      assert.equal(upstreamComplete, true, "memory extraction must wait for the completed answer");
      extracted++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ facts: [] }) } }] })); return;
    }
    upstreamComplete = false;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "你" } }] })}\r\n\r\n`);
    if (held) await gate;
    if (truncated) { res.end(); return; }
    upstreamComplete = true;
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "好" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/v1`;
    Object.assign(process.env, { RAG_MODE: "live", LLM_BASE_URL: base, EMBEDDING_BASE_URL: base,
      LLM_API_KEY: "test", EMBEDDING_API_KEY: "test", LLM_MODEL: "test", EMBEDDING_MODEL: "test", RAG_DB_PATH: join(dir, "test.sqlite") });
    const deltas: string[] = [];
    let firstDelta = () => {}, completed = false;
    const first = new Promise<void>(resolve => { firstDelta = resolve; });
    const answer = complete("test", [{ role: "user", content: "你好" }], 100, text => { deltas.push(text); firstDelta(); })
      .then(text => { completed = true; return text; });
    await first; assert.deepEqual(deltas, ["你"]); assert.equal(completed, false); release();
    assert.equal(await answer, "你好"); assert.deepEqual(deltas, ["你", "好"]);

    // The application response must expose the first delta while the model is still waiting.
    gate = new Promise<void>(resolve => { release = resolve; });
    const request = () => new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "stream", question: "你好", stream: true }) });
    const response = await POST(request());
    assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    const events: any[] = [];
    for await (const event of readSSE(response.body!)) {
      const data = JSON.parse(event.data); events.push(data);
      if (data.type === "delta" && data.text === "你") {
        assert.equal(extracted, 0); assert.equal(upstreamComplete, false); release();
      }
    }
    assert.deepEqual(events.filter(e => e.type === "delta").map(e => e.text), ["你", "好"]);
    assert.equal(events.at(-1).type, "done"); assert.equal(extracted, 1);
    assert.equal(getStore().records("stream")[0].answer, "你好");

    held = false; truncated = true;
    const broken = await POST(request()); const failed: any[] = [];
    for await (const event of readSSE(broken.body!)) failed.push(JSON.parse(event.data));
    assert.equal(failed.at(-1).type, "error"); assert.equal(failed.at(-1).answerComplete, false);
    assert.equal(extracted, 1); assert.equal(getStore().records("stream").length, 1);
  } finally {
    release(); server.close();
    const globalStore = globalThis as { ragStore?: ReturnType<typeof getStore> };
    globalStore.ragStore?.close(); delete globalStore.ragStore;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous); rmSync(dir, { recursive: true, force: true });
  }
});

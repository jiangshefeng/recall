import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { embed, embedMany, embedManySettled } from "../src/lib/providers";

test("batch vectors preserve input mapping; failed batches fall back with bounded concurrency and partial success", async () => {
  const previous = { ...process.env };
  let mode = "ordered", batchCalls = 0, active = 0, peak = 0;
  const inputs: unknown[] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const { input } = JSON.parse(raw); inputs.push(input);
    res.setHeader("Content-Type", "application/json");
    const texts: string[] = Array.isArray(input) ? input : [input];
    if (Array.isArray(input)) batchCalls++;
    if (mode === "fallback" && Array.isArray(input)) { res.writeHead(400); res.end("{}"); return; }
    if (mode === "fallback") {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 30)); active--;
      if (input === "bad") { res.writeHead(500); res.end("{}"); return; }
    }
    let data = texts.map((text, index) => ({ index, embedding: [Number(text) || 1, 1] }));
    if (mode === "duplicate-index") data.forEach(entry => entry.index = 0);
    if (mode === "count") data = data.slice(0, 1);
    if (mode === "zero") data[0].embedding = [0, 0];
    if (mode === "dimensions") data[0].embedding = [1];
    if (mode === "missing-index") delete (data[0] as { index?: number }).index;
    res.end(JSON.stringify({ data: data.reverse() }));
  });
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    Object.assign(process.env, { RAG_MODE: "live", EMBEDDING_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      EMBEDDING_API_KEY: "test", EMBEDDING_MODEL: "test" });
    assert.deepEqual(await embedMany([]), []); assert.equal(inputs.length, 0);
    assert.deepEqual(await embed("3"), [3, 1]); assert.equal(inputs[0], "3");
    assert.deepEqual(await embedMany(["2", "5"]), [[2, 1], [5, 1]]); assert.equal(batchCalls, 1);
    for (mode of ["duplicate-index", "count", "zero", "dimensions", "missing-index"])
      await assert.rejects(embedMany(["2", "5"]), /Embedding/);
    mode = "fallback";
    const before = inputs.length;
    const results = await embedManySettled(["2", "bad", "5", "7", "9"]);
    assert.equal(inputs.length - before, 6, "one batch attempt and five individual requests");
    assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
    assert.deepEqual(results[2], { status: "fulfilled", value: [5, 1] });
    assert.ok(peak > 1 && peak <= 3, `observed concurrency: ${peak}`);
    const beforeSingle = inputs.length;
    assert.equal((await embedManySettled(["bad"]))[0].status, "rejected");
    assert.equal(inputs.length - beforeSingle, 1, "a failed single input is not retried");
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

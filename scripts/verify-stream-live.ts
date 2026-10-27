import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { POST } from "../src/app/api/chat/route";
import { readSSE } from "../src/lib/sse";
import { getStore } from "../src/lib/store";
import { modelConfig } from "../src/lib/providers";

async function main() {
  assert.equal(modelConfig().mode, "live");
  const dir = join(process.cwd(), "artifacts", `stream-live-${Date.now()}`);
  mkdirSync(dir, { recursive: true }); process.env.RAG_DB_PATH = join(dir, "test.sqlite");
  const started = Date.now();
  const events: { type: string; elapsedMs: number }[] = [];
  let answer = "", finalAnswer = "", done = false, deltaCount = 0;
  let memory: { facts?: number; summaries?: number; added?: number } | undefined;
  try {
    const response = await POST(new Request("http://localhost/api/chat", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        scope: "verify-stream", question: "只用一句中文打个招呼。", stream: true,
      }) }));
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    for await (const event of readSSE(response.body!)) {
      const data = JSON.parse(event.data); events.push({ type: data.type, elapsedMs: Date.now() - started });
      if (data.type === "delta") { answer += data.text; deltaCount++; }
      if (data.type === "answer") finalAnswer = data.answer;
      if (data.type === "error") throw new Error(data.message);
      if (data.type === "done") { done = true; memory = data.memory; }
    }
    assert.ok(done); assert.ok(deltaCount > 1); assert.equal(answer, finalAnswer);
    const records = getStore().records("verify-stream");
    assert.equal(records.length, 1); assert.equal(records[0].answer, answer);
    assert.equal(memory?.facts, 0); assert.equal(memory?.summaries, 1); assert.equal(memory?.added, 1);
    const hot = getStore().memories("verify-stream", modelConfig().space, "hot");
    assert.equal(hot.length, 1); assert.equal(hot[0].kind, "qa");
    assert.ok(!hot[0].summary.includes("问答记录（助手回答未验证）"));
    assert.deepEqual(hot[0].sourceIds, [records[0].id]);
    const report = { answer, memory, summary: hot[0].summary, deltaCount, events, searchThreshold: process.env.RAG_SEARCH_THRESHOLD,
      mergeThreshold: process.env.RAG_MERGE_THRESHOLD, isolatedDatabase: process.env.RAG_DB_PATH };
    writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, deltaCount, firstDeltaMs: events.find(e => e.type === "delta")?.elapsedMs,
      answerCompleteMs: events.find(e => e.type === "answer")?.elapsedMs, doneMs: events.at(-1)?.elapsedMs,
      searchThreshold: report.searchThreshold, mergeThreshold: report.mergeThreshold }));
  } finally { getStore().close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

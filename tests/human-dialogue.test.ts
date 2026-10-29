import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { remember } from "../src/lib/rag";
import { getStore, MemoryStore } from "../src/lib/store";
import { summaryGroundingPrompt } from "../src/lib/summary-grounding";

test("human dialogue accepts both speakers, suppresses empty-fact placeholders and preserves ordinary chat", async () => {
  const before = { ...process.env }, fetch = globalThis.fetch;
  const parent = resolve("artifacts/test-tmp"); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "human-dialogue-"));
  const prompts: string[] = [];
  let embeddingCalls = 0;
  let verifiedMerge = false;
  try {
    Object.assign(process.env, { RAG_MODE: "live", LLM_API_STYLE: "chat_completions", LLM_API_KEY: "synthetic",
      LLM_MODEL: "mock", EMBEDDING_MODEL: "mock", LLM_BASE_URL: "http://local.invalid/v1",
      EMBEDDING_BASE_URL: "http://local.invalid/v1", RAG_DB_PATH: join(dir, "memory.sqlite") });
    globalThis.fetch = async (url, init) => {
      const input = JSON.parse(String(init?.body));
      if (String(url).endsWith("/embeddings")) {
        embeddingCalls++;
        const values = Array.isArray(input.input) ? input.input : [input.input];
        return Response.json({ data: values.map((_: string, index: number) => ({ index, embedding: [1, 0] })) });
      }
      const prompt = input.messages[0].content as string; prompts.push(prompt);
      assert.ok(prompt.includes(summaryGroundingPrompt), "Extraction and merge must both carry the same attribution and qualifier constraints");
      const record = JSON.parse(input.messages.at(-1).content);
      if (record.jobs) {
        assert.match(prompt, /originals.sourceType="human-dialogue"/);
        assert.equal(record.originals.length, 2);
        assert.ok(record.originals.every((r: { sourceType?: string }) => r.sourceType === "human-dialogue"));
        assert.ok(record.originals.some((r: { answer: string }) => r.answer === "B: I live in Paris."));
        verifiedMerge = true;
        return Response.json({ choices: [{ message: { content: JSON.stringify({ decisions: record.jobs.map((j: { incomingId: string; candidateIds: string[] }) => ({
          incomingId: j.incomingId, candidateId: j.candidateIds[0], action: "merge", relation: "duplicate", summary: "B lives in Paris.", reason: "Same human statement",
        })) }) }, finish_reason: "stop" }] });
      }
      const content = ["A: Where do you live?", "A: You still live there?"].includes(record.question) ? {
        facts: ["B lives in Paris."],
      } : { facts: [], qaSummary: "A asked a question; no assistant answer was provided." };
      return Response.json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] });
    };
    const result = await remember("historical", "A: Where do you live?", "B: I live in Paris.", [],
      { recordedAt: "2024-01-01", sourceType: "human-dialogue" });
    assert.equal(result.action, "added");
    assert.match(prompts[0], /两个字段中的明确陈述都可提取为事实/);
    assert.ok(!prompts[0].includes("Always also return qaSummary"));
    const store = getStore();
    assert.equal(store.memories("historical")[0].summary, "B lives in Paris.");
    assert.equal(store.records("historical")[0].answer, "B: I live in Paris.");
    const originalId = store.records("historical")[0].id;
    const reopened = new MemoryStore(join(dir, "memory.sqlite"));
    try {
      assert.equal(reopened.records("historical", [originalId])[0].sourceType, "human-dialogue");
      assert.equal(reopened.recentRecords("historical", [originalId], 1)[0].sourceType, "human-dialogue");
    } finally { reopened.close(); }
    const merged = await remember("historical", "A: You still live there?", "B: Yes, Paris.", [], { sourceType: "human-dialogue" });
    assert.equal(merged.action, "merged"); assert.equal(verifiedMerge, true);
    const beforeSkip = embeddingCalls;
    const skipped = await remember("empty", "A: Anything else?", "", [], { sourceType: "human-dialogue" });
    assert.equal(skipped.action, "skipped");
    assert.equal(store.records("empty").length, 1);
    assert.equal(store.memories("empty").length, 0);
    assert.equal(embeddingCalls, beforeSkip, "Skipped fragments do not request vectors or merges");
    await remember("ordinary", "Any advice?", "An AI suggestion.", []);
    assert.match(prompts.at(-1)!, /answer 与 context 只用于消解指代/);
    assert.match(prompts.at(-1)!, /Always also return qaSummary/);
    assert.equal(store.memories("ordinary")[0].kind, "qa");
    assert.equal(store.records("ordinary")[0].sourceType, undefined);
  } finally {
    globalThis.fetch = fetch; process.env = before; getStore().close();
    assert.equal(dirname(resolve(dir)), parent);
    rmSync(dir, { recursive: true, force: true });
  }
});

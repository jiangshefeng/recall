import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decideMemoryMerge, retrieve, answerQuestion } from "../src/lib/rag";
import { getStore } from "../src/lib/store";
import { embed, modelConfig } from "../src/lib/providers";

async function main() {
  const store = getStore(), scope = "default", space = modelConfig().space;
  const memories = store.memories(scope, space);
  const previous = memories.find(m => m.id === "d0f77415-bca2-4a5d-897d-cdb4f811db94");
  const incoming = memories.find(m => m.status === "hot" && m.parentIds.includes("752fadb8-7864-4cb2-b631-ec82bd0135b9"))
    ?? memories.find(m => m.id === "752fadb8-7864-4cb2-b631-ec82bd0135b9");
  assert.ok(previous?.status === "hot" && incoming?.status === "hot", "Expected the two original hot preferences; stop rather than repeat repair");
  const decision = await decideMemoryMerge(store, incoming, [previous]);
  console.log(JSON.stringify(decision));
  assert.equal(decision.relation, "update");
  assert.equal(decision.candidateId, previous.id);
  const merged = { ...incoming, id: randomUUID(), summary: decision.summary, vector: await embed(decision.summary),
    sourceIds: [...new Set([...previous.sourceIds, ...incoming.sourceIds])], parentIds: [previous.id, incoming.id],
    reason: decision.reason, createdAt: new Date().toISOString() };
  const dir = resolve("artifacts", `preference-repair-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const backup = resolve(dir, "before-repair.sqlite");
  const db = new DatabaseSync(resolve(process.env.RAG_DB_PATH || "data/rag.sqlite"));
  db.prepare("VACUUM INTO ?").run(backup); db.close();
  const before = store.stats(scope, space);
  assert.ok(store.merge(previous.id, incoming, merged, true));
  const after = store.stats(scope, space);
  assert.equal(after.records, before.records);
  assert.equal(after.hot, before.hot - 1);
  assert.equal(after.cold, before.cold + 2);
  const evidence = await retrieve(scope, "我现在希望你主动给例子吗？", "expand");
  const answer = await answerQuestion("我现在希望你主动给例子吗？", [], evidence);
  writeFileSync(resolve(dir, "report.json"), JSON.stringify({ before, after, backup, decision, answer, evidence }, null, 2));
  console.log(JSON.stringify({ dir, before, after, summary: merged.summary, answer }));
  store.close();
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });

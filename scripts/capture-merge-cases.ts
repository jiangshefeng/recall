// Offline: freeze identical jobs and the pre-change request for a paired protocol check.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decideMemoryMerges } from "../src/lib/rag";
import { MemoryStore } from "../src/lib/store";
import { ranked } from "../src/lib/similarity";
import type { Memory, RecordEntry } from "../src/lib/types";

async function main() {
  if (existsSync(resolve("artifacts/merge-protocol-ab/cases.json")))
    throw new Error("Frozen cases already exist; refusing to overwrite the original protocol baseline");
  const base = resolve("artifacts/locomo-conv26-all199");
  const report = JSON.parse(readFileSync(resolve(base, "report.json"), "utf8"));
  const db = new DatabaseSync(resolve(base, "dynamic.sqlite"), { readOnly: true });
  const vectors = new Map(db.prepare("SELECT id,vector FROM memories").all().map(row => [String(row.id), JSON.parse(String(row.vector))]));
  const records: RecordEntry[] = db.prepare("SELECT * FROM records").all().map(row => ({ id: String(row.id), scope: String(row.scope),
    question: String(row.question), answer: String(row.answer), context: String(row.context), createdAt: String(row.created_at) })); db.close();
  const memories: Memory[] = report.memories.map((m: Memory) => ({ ...m, vector: vectors.get(m.id) }));
  const store = new MemoryStore(":memory:"); records.forEach(record => store.saveRecord(record));
  const cases: object[] = [], originalFetch = globalThis.fetch;
  let captured: unknown;
  globalThis.fetch = async (_input, init) => {
    captured = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { content: '{"decisions":[]}' }, finish_reason: "stop" }] });
  };
  try {
    for (const row of report.ingestion.filter((row: { message?: string }) => row.message?.includes("批量合并未完成"))) {
      const inputs = memories.filter(m => m.sourceIds.length === 1 && m.sourceIds[0] === row.recordId && !m.parentIds.length);
      const pool = memories.filter(m => m.status === "hot" && !m.sourceIds.includes(row.recordId));
      const jobs = inputs.map(incoming => ({ incoming, candidates: ranked(incoming.kind === "qa" ? pool.filter(m => m.kind === "qa") : pool,
        incoming.vector, 3, 0.6) })).filter(job => job.candidates.length);
      if (!jobs.length) continue;
      captured = undefined; await decideMemoryMerges(store, jobs); assert.ok(captured);
      cases.push({ id: row.id, jobs, beforeRequest: captured });
    }
    writeFileSync(resolve("artifacts/merge-protocol-ab/cases.json"), JSON.stringify({
      note: "Paired diagnostic cases drawn from previously format-failed turns, with candidates reconstructed from the final fixed snapshot. These are not exact replays of the original historical requests or a LoCoMo QA score.",
      records, cases,
    }, null, 2));
    console.log(`CAPTURED=${cases.length}; cloudRequests=0`);
  } finally { globalThis.fetch = originalFetch; store.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

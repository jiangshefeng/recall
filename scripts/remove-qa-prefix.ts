import assert from "node:assert/strict";
import { backup, DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { embed, modelConfig } from "../src/lib/providers";

// Explicit maintenance command: preserve a consistent SQLite backup before updating vectors.
async function main() {
  const config = modelConfig();
  const path = process.env.RAG_DB_PATH || join(process.cwd(), "data", "rag.sqlite");
  const db = new DatabaseSync(path);
  const prefix = "问答记录（助手回答未验证）：";
  try {
    const rows = db.prepare("SELECT id, summary, space FROM memories WHERE substr(summary, 1, ?) = ?")
      .all(prefix.length, prefix) as { id: string; summary: string; space: string }[];
    const current = rows.filter(row => row.space === config.space);
    if (!current.length) { console.log(JSON.stringify({ updated: 0, skippedOtherSpaces: rows.length })); return; }
    const dir = join(process.cwd(), "artifacts", `remove-qa-prefix-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    await backup(db, join(dir, "before.sqlite"));
    const changes = [];
    for (const row of current) {
      const summary = row.summary.slice(prefix.length).trim();
      assert.ok(summary, "Cannot reindex an empty summary");
      changes.push({ ...row, nextSummary: summary, vector: await embed(summary) });
    }
    db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE IF NOT EXISTS memory_kinds (memory_id TEXT PRIMARY KEY, kind TEXT NOT NULL)");
      for (const change of changes) {
        const result = db.prepare("UPDATE memories SET summary=?, vector=? WHERE id=? AND summary=? AND space=?")
          .run(change.nextSummary, JSON.stringify(change.vector), change.id, change.summary, change.space);
        assert.equal(result.changes, 1, "Memory changed during reindex; rolled back");
        db.prepare("INSERT INTO memory_kinds VALUES (?, 'qa') ON CONFLICT(memory_id) DO UPDATE SET kind='qa'").run(change.id);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    const report = { updated: changes.length, skippedOtherSpaces: rows.length - current.length, backup: join(dir, "before.sqlite") };
    writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

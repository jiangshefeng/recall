// Import this synthetic test batch into the visible default workspace, once.
const { DatabaseSync } = require('node:sqlite');
const { resolve } = require('node:path');
const { mkdirSync } = require('node:fs');
const assert = require('node:assert/strict');
const source = new DatabaseSync(resolve('artifacts/extended-rag/2026-10-26T06-38-55-410Z/memory.sqlite'), { readOnly: true });
const target = new DatabaseSync(resolve(process.env.RAG_DB_PATH || 'data/rag.sqlite'));
const prefix = 'extended-20261026:';
const records = source.prepare('SELECT * FROM records').all();
const memories = source.prepare('SELECT * FROM memories').all();
assert.equal(records.length, 32);
assert.equal(memories.length, 33);
mkdirSync('data/backups', { recursive: true });
const backup = resolve('data/backups', `before-fixture-import-${Date.now()}.sqlite`);
target.exec('PRAGMA busy_timeout=5000');
target.prepare('VACUUM INTO ?').run(backup);
let addedRecords = 0, addedMemories = 0;
try {
  target.exec('BEGIN IMMEDIATE');
  for (const r of records) {
    addedRecords += Number(target.prepare('INSERT OR IGNORE INTO records (id, scope, question, answer, context, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      prefix + r.id, 'default', r.question, r.answer,
      JSON.stringify({ syntheticTestData: true, originalScope: r.scope, originalContext: r.context }), r.created_at).changes);
  }
  for (const m of memories) {
    addedMemories += Number(target.prepare('INSERT OR IGNORE INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      prefix + m.id, 'default', m.summary, m.vector, m.space, m.status,
      JSON.stringify(JSON.parse(m.source_ids).map(id => prefix + id)),
      JSON.stringify(JSON.parse(m.parent_ids).map(id => prefix + id)),
      '[Synthetic test import] ' + m.reason, m.created_at).changes);
  }
  for (const m of memories) {
    for (const id of JSON.parse(m.source_ids)) assert.ok(target.prepare('SELECT id FROM records WHERE id=? AND scope=?').get(prefix + id, 'default'));
    for (const id of JSON.parse(m.parent_ids)) assert.ok(target.prepare('SELECT id FROM memories WHERE id=? AND scope=?').get(prefix + id, 'default'));
  }
  target.exec('COMMIT');
  console.log(JSON.stringify({ addedRecords, addedMemories, backup }));
} catch (e) {
  target.exec('ROLLBACK');
  throw e;
} finally { source.close(); target.close(); }

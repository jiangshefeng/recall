import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Memory, RecordEntry, StageSummary } from "./types";

export class MemoryStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.ensureSchema();
  }
  ensureSchema() {
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, question TEXT NOT NULL,
        answer TEXT NOT NULL, context TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, summary TEXT NOT NULL,
        vector TEXT NOT NULL, space TEXT NOT NULL, status TEXT NOT NULL,
        source_ids TEXT NOT NULL, source_order TEXT, parent_ids TEXT NOT NULL, reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_scope ON memories(scope, space, status);
      CREATE INDEX IF NOT EXISTS record_scope ON records(scope);
      CREATE TABLE IF NOT EXISTS record_sources (record_id TEXT PRIMARY KEY, source_type TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stages (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, content TEXT NOT NULL,
        source_ids TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_stages (memory_id TEXT PRIMARY KEY, stage_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_kinds (memory_id TEXT PRIMARY KEY, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_operations (
        id INTEGER PRIMARY KEY, scope TEXT NOT NULL, action TEXT NOT NULL,
        target_id TEXT NOT NULL, incoming_id TEXT NOT NULL, result_id TEXT,
        record_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    const memoryColumns = this.db.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
    if (!memoryColumns.some(column => column.name === "source_order"))
      this.db.exec("ALTER TABLE memories ADD COLUMN source_order TEXT");
  }
  close() { this.db.close(); }
  saveRecord(r: RecordEntry) {
    if (r.sourceType) this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?)")
        .run(r.id, r.scope, r.question, r.answer, r.context, r.createdAt);
      if (r.sourceType) {
        this.db.prepare("INSERT INTO record_sources VALUES (?, ?)").run(r.id, r.sourceType);
        this.db.exec("COMMIT");
      }
    } catch (error) { if (r.sourceType) this.db.exec("ROLLBACK"); throw error; }
  }
  private insert(m: Memory) {
    this.db.prepare(`INSERT INTO memories
      (id,scope,summary,vector,space,status,source_ids,source_order,parent_ids,reason,created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(m.id, m.scope, m.summary, JSON.stringify(m.vector), m.space, m.status,
        JSON.stringify(m.sourceIds), m.sourceOrder ? JSON.stringify(m.sourceOrder) : null,
        JSON.stringify(m.parentIds), m.reason, m.createdAt);
    this.db.prepare("INSERT INTO memory_kinds VALUES (?, ?)").run(m.id, m.kind ?? "fact");
    if (m.stage) {
      this.db.prepare("INSERT OR IGNORE INTO stages VALUES (?, ?, ?, ?, ?)")
        .run(m.stage.id, m.scope, m.stage.content, JSON.stringify(m.stage.sourceIds), m.stage.createdAt);
      this.db.prepare("INSERT INTO memory_stages VALUES (?, ?)").run(m.id, m.stage.id);
    }
  }
  saveMemory(m: Memory) {
    this.db.exec("BEGIN IMMEDIATE");
    try { this.insert(m); this.db.exec("COMMIT"); }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  // A transaction and hot-state check avoid silently overwriting a concurrent merge.
  merge(oldId: string, incoming: Memory, merged: Memory, incomingStored = false, action = "merge"): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db.prepare("SELECT status FROM memories WHERE id=? AND scope=? AND space=?")
        .get(oldId, incoming.scope, incoming.space) as { status: string } | undefined;
      if (!old || old.status !== "hot") { this.db.exec("ROLLBACK"); return false; }
      if (incomingStored) {
        const existing = this.db.prepare("SELECT status FROM memories WHERE id=? AND scope=? AND space=?")
          .get(incoming.id, incoming.scope, incoming.space) as { status: string } | undefined;
        if (incoming.id === oldId || !existing || existing.status !== "hot") { this.db.exec("ROLLBACK"); return false; }
      }
      this.db.prepare("UPDATE memories SET status='cold' WHERE id=?").run(oldId);
      if (incomingStored) this.db.prepare("UPDATE memories SET status='cold' WHERE id=?").run(incoming.id);
      else this.insert({ ...incoming, status: "cold" });
      this.insert(merged);
      this.logOperation(action, oldId, incoming, merged.id, merged.reason);
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private logOperation(action: string, targetId: string, incoming: Memory, resultId: string | null, reason: string) {
    this.db.prepare(`INSERT INTO memory_operations
      (scope,action,target_id,incoming_id,result_id,record_id,reason,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(incoming.scope, action, targetId, incoming.id, resultId, incoming.sourceIds[0] ?? "", reason, new Date().toISOString());
  }
  retire(targetId: string, incoming: Memory, reason: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("UPDATE memories SET status='cold' WHERE id=? AND scope=? AND space=? AND status='hot'")
        .run(targetId, incoming.scope, incoming.space);
      if (!result.changes) { this.db.exec("ROLLBACK"); return false; }
      this.insert({ ...incoming, status: "cold", parentIds: [targetId], reason: `delete: ${reason}` });
      this.logOperation("delete", targetId, incoming, null, reason);
      this.db.exec("COMMIT"); return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  memories(scope: string, space?: string, status?: Memory["status"]): Memory[] {
    const conditions = ["m.scope=?"], values = [scope];
    if (space !== undefined) { conditions.push("m.space=?"); values.push(space); }
    if (status !== undefined) { conditions.push("m.status=?"); values.push(status); }
    const rows = this.db.prepare(`SELECT m.*, k.kind, s.id AS stage_id, s.content AS stage_content,
      s.source_ids AS stage_sources, s.created_at AS stage_date FROM memories m
      LEFT JOIN memory_stages ms ON ms.memory_id=m.id LEFT JOIN stages s ON s.id=ms.stage_id AND s.scope=m.scope
      LEFT JOIN memory_kinds k ON k.memory_id=m.id
      WHERE ${conditions.join(" AND ")} ORDER BY m.created_at DESC`).all(...values);
    return rows.map(row => ({
      id: String(row.id), scope: String(row.scope), summary: String(row.summary),
      kind: row.kind === "qa" || (!row.kind && String(row.summary).startsWith("问答记录（助手回答未验证）：")) ? "qa" : "fact",
      vector: JSON.parse(String(row.vector)), space: String(row.space),
      status: row.status as "hot" | "cold", sourceIds: JSON.parse(String(row.source_ids)),
      ...(row.source_order ? { sourceOrder: JSON.parse(String(row.source_order)) } : {}),
      parentIds: JSON.parse(String(row.parent_ids)), reason: String(row.reason), createdAt: String(row.created_at),
      ...(row.stage_id ? { stage: { id: String(row.stage_id), content: String(row.stage_content),
        sourceIds: JSON.parse(String(row.stage_sources)), createdAt: String(row.stage_date) } } : {}),
    }));
  }
  stage(scope: string, id: string): StageSummary | undefined {
    const row = this.db.prepare("SELECT * FROM stages WHERE scope=? AND id=?").get(scope, id);
    return row ? { id: String(row.id), content: String(row.content), sourceIds: JSON.parse(String(row.source_ids)), createdAt: String(row.created_at) } : undefined;
  }
  records(scope: string, ids?: string[]): RecordEntry[] {
    if (ids?.length === 0) return [];
    const rows = ids
      ? this.db.prepare(`SELECT r.*, s.source_type FROM records r LEFT JOIN record_sources s ON s.record_id=r.id WHERE r.scope=? AND r.id IN (${ids.map(() => "?").join(",")})`).all(scope, ...ids)
      : this.db.prepare("SELECT r.*, s.source_type FROM records r LEFT JOIN record_sources s ON s.record_id=r.id WHERE r.scope=? ORDER BY r.created_at DESC").all(scope);
    const mapped = rows.map(row => ({
      id: String(row.id), scope: String(row.scope), question: String(row.question),
      answer: String(row.answer), context: String(row.context), createdAt: String(row.created_at),
      ...(row.source_type === "human-dialogue" ? { sourceType: "human-dialogue" as const } : {}),
    }));
    return ids ? mapped.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)) : mapped;
  }
  recentRecords(scope: string, ids: string[], limit: number, preserveOrder = false): RecordEntry[] {
    if (!ids.length) return [];
    if (preserveOrder) return this.records(scope, ids.slice(0, limit));
    // Bound database reads before loading full text; JSON avoids one SQL variable per source ID.
    const rows = this.db.prepare(`SELECT r.*, s.source_type FROM records r LEFT JOIN record_sources s ON s.record_id=r.id
      WHERE r.scope=? AND r.id IN (SELECT value FROM json_each(?))
      ORDER BY r.created_at DESC, r.id ASC LIMIT ?`).all(scope, JSON.stringify(ids), limit);
    return rows.map(row => ({ id: String(row.id), scope: String(row.scope), question: String(row.question),
      answer: String(row.answer), context: String(row.context), createdAt: String(row.created_at),
      ...(row.source_type === "human-dialogue" ? { sourceType: "human-dialogue" as const } : {}) }));
  }
  stats(scope: string, space: string) {
    const all = this.memories(scope, space);
    return { hot: all.filter(x => x.status === "hot").length,
      cold: all.filter(x => x.status === "cold").length, records: this.records(scope).length };
  }
}

const STORE_SCHEMA_VERSION = 6;
const globalStore = globalThis as unknown as { ragStore?: MemoryStore; ragStoreSchemaVersion?: number };
export function getStore() {
  if (!globalStore.ragStore) {
    globalStore.ragStore = new MemoryStore(process.env.RAG_DB_PATH || join(process.cwd(), "data", "rag.sqlite"));
    globalStore.ragStoreSchemaVersion = STORE_SCHEMA_VERSION;
  } else if (globalStore.ragStoreSchemaVersion !== STORE_SCHEMA_VERSION) {
    // Dev HMR preserves globalThis. Upgrade methods and additive tables without
    // closing the connection that an in-flight model request may still be using.
    Object.setPrototypeOf(globalStore.ragStore, MemoryStore.prototype);
    globalStore.ragStore.ensureSchema();
    globalStore.ragStoreSchemaVersion = STORE_SCHEMA_VERSION;
  }
  return globalStore.ragStore;
}

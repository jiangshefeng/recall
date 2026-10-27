import assert from "node:assert/strict";
import type { Turn } from "../src/lib/types";

export type Dialog = { speaker: string; dia_id: string; text: string; blip_caption?: string };
export type Question = { question: string; answer?: string | number; category: number; evidence: string[]; adversarial_answer?: string };
export type Sample = { sample_id: string; conversation: Record<string, unknown>; qa: Question[] };
export type SourceTurn = { id: string; session: string; sourceDate: string; date: string; content: string; history: Turn[] };

export function makeSmallPlan(sample: Sample, sessionCount = 2) {
  const sessions = Object.keys(sample.conversation).filter(k => /^session_\d+$/.test(k))
    .sort((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1])).slice(0, sessionCount);
  assert.equal(sessions.length, sessionCount);
  const turns: SourceTurn[] = [], history: Turn[] = [];
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  for (const session of sessions) {
    const sourceDate = String(sample.conversation[`${session}_date_time`]);
    const m = /^(\d{1,2}):(\d{2})\s*(am|pm) on (\d{1,2}) (\w+), (\d{4})$/i.exec(sourceDate);
    assert.ok(m, "Unsupported session date");
    const month = months.indexOf(m[5].toLowerCase()); assert.ok(month >= 0);
    const date = new Date(Date.UTC(Number(m[6]), month, Number(m[4]), Number(m[1]) % 12 + (m[3].toLowerCase() === "pm" ? 12 : 0), Number(m[2]))).toISOString();
    for (const row of sample.conversation[session] as Dialog[]) {
      const content = `${row.speaker}: ${row.text}` + (row.blip_caption ? `\nImage caption supplied by dataset (not directly inspected): ${row.blip_caption}` : "");
      turns.push({ id: row.dia_id, session, sourceDate, date, content, history: history.slice(-6) });
      history.push({ role: "user", content: `[Session date: ${sourceDate}] ${content}` });
    }
  }
  const ids = new Set(turns.map(t => t.id)); assert.equal(ids.size, turns.length);
  const eligible = sample.qa.map((qa, index) => ({ qa, index })).filter(({ qa }) => qa.category !== 5 && qa.evidence.length > 0 && qa.evidence.every(id => ids.has(id)));
  const unknown = sample.qa.map((qa, index) => ({ qa, index })).filter(({ qa }) => qa.category === 5);
  const count = Math.min(5, unknown.length);
  const selected = [...eligible, ...Array.from({ length: count }, (_, i) => unknown[Math.floor((i + 0.5) * unknown.length / count)])]
    .sort((a, b) => a.index - b.index);
  return { sessions, turns, selected };
}

// Ordinary RAG: consecutive raw turns, bounded character chunks, one-turn overlap.
// Never cross a session boundary. Preserve every source turn, including long turns.
export function plainChunks(turns: SourceTurn[], targetChars = 1400) {
  const chunks: { id: string; content: string; date: string; sourceIds: string[] }[] = [];
  let offset = 0;
  while (offset < turns.length) {
    let end = offset + 1;
    const text = (last: number) => `[Session date: ${turns[offset].sourceDate}]\n` + turns.slice(offset, last).map(t => t.content).join("\n");
    while (end < turns.length && turns[end].session === turns[offset].session && text(end + 1).length <= targetChars) end++;
    chunks.push({ id: `chunk-${chunks.length + 1}`, content: text(end), date: turns[offset].date, sourceIds: turns.slice(offset, end).map(t => t.id) });
    offset = end - offset > 1 && end < turns.length && turns[end].session === turns[offset].session ? end - 1 : end;
  }
  return chunks;
}

export type TokenAttempt = { chargedTokens: number; reserveTokens: number; phase: string; status: string;
  promptTokens?: number; completionTokens?: number; totalTokens?: number };
export function reserveTokens(payload: { max_tokens?: number; [key: string]: unknown }) {
  return Buffer.byteLength(JSON.stringify(payload), "utf8") + 2048 + (payload.max_tokens ?? 16000);
}
export function remainingAllows(attempts: TokenAttempt[], reserve: number, limit: number) {
  return attempts.reduce((n, a) => n + a.chargedTokens, 0) + reserve <= limit;
}
export function chargeUsage(attempt: TokenAttempt, usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
  if (!Number.isFinite(usage.prompt_tokens) || usage.prompt_tokens! < 0 || !Number.isFinite(usage.completion_tokens) || usage.completion_tokens! < 0) return false;
  attempt.promptTokens = usage.prompt_tokens; attempt.completionTokens = usage.completion_tokens;
  attempt.totalTokens = Math.max(usage.prompt_tokens! + usage.completion_tokens!, Number.isFinite(usage.total_tokens) ? usage.total_tokens! : 0);
  attempt.chargedTokens = attempt.totalTokens; return true;
}

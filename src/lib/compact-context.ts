import type { RecordEntry, Turn } from "./types";

export function contextTurns(context: string): Turn[] | undefined {
  try {
    const turns: unknown = JSON.parse(context);
    if (Array.isArray(turns) && turns.every(t => t &&
      (t.role === "user" || t.role === "assistant") && typeof t.content === "string")) return turns;
  } catch { /* Legacy plain text is preserved. */ }
}

// Share identical messages across records without changing their order or occurrences.
// Stored records remain verbatim; references only exist in this model request.
export function compactContexts(records: RecordEntry[]) {
  const contexts: Record<string, Turn> = {};
  const ids = new Map<string, string>();
  const originals = records.map(record => {
    const turns = contextTurns(record.context);
    if (!turns) return { ...record };
    const contextIds = turns.map((turn: Turn) => {
      const key = JSON.stringify([turn.role, turn.content]);
      let id = ids.get(key);
      if (!id) { id = `c${ids.size + 1}`; ids.set(key, id); contexts[id] = { role: turn.role, content: turn.content }; }
      return id;
    });
    const { context: _context, ...rest } = record;
    return { ...rest, contextIds };
  });
  return { originals, contexts };
}

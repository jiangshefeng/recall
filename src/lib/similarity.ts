export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return 0;
    dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

// Demo only: character bigram hashing, not a semantic embedding model.
export function demoEmbedding(text: string): number[] {
  const vector = Array<number>(512).fill(0);
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const chars = Array.from(normalized);
  for (let i = 0; i < chars.length; i++) {
    const token = chars.slice(i, i + 2).join("");
    let hash = 2166136261;
    for (const c of token) hash = Math.imul(hash ^ c.codePointAt(0)!, 16777619);
    vector[(hash >>> 0) % vector.length] += 1;
  }
  if (!vector.some(Boolean)) vector[0] = 1;
  return vector;
}

export function ranked<T extends { id: string; vector: number[] }>(
  items: T[], query: number[], limit: number, threshold: number, exclude = new Set<string>(),
): (T & { score: number })[] {
  return items.filter(x => !exclude.has(x.id))
    .map(x => ({ ...x, score: cosine(query, x.vector) }))
    .filter(x => x.score >= threshold)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

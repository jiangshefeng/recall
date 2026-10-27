import type { PromptEvidence, RecordEntry, RetrievalPolicy, StageSummary } from "./types";
import { contextTurns } from "./compact-context";

// Heuristic, NOT a model tokenizer: ASCII ~4 chars/token, non-ASCII ~1.5 tokens/code point.
export function estimateTokens(text: string): number {
  let units = 0;
  for (const char of text) units += char.codePointAt(0)! <= 127 ? 0.25 : 1.5;
  return Math.ceil(units);
}

export class EvidenceBudget {
  readonly context: PromptEvidence[] = [];
  readonly records: RecordEntry[] = [];
  readonly stages: StageSummary[] = [];
  private readonly seen = new Set<string>();
  private readonly seenContext = new Map<string, { citation: number; message: number }>();
  constructor(private readonly policy: RetrievalPolicy) {}

  usage() {
    // Count the actual JSON evidence array passed to the LLM, including metadata and escaping.
    const serialized = JSON.stringify(this.context);
    return { records: this.context.length, chars: serialized.length,
      estimatedTokens: estimateTokens(serialized), truncatedRecords: this.context.filter(x => x.truncated).length };
  }

  canAddMore() {
    const used = this.usage();
    return used.records < this.policy.maxRecords &&
      this.policy.maxContextChars - used.chars >= 128 &&
      this.policy.maxEstimatedTokens - used.estimatedTokens >= 32;
  }

  add(record: RecordEntry): boolean {
    const turns = contextTurns(record.context);
    const context = turns ? JSON.stringify(turns.map(t => {
      const ref = this.seenContext.get(JSON.stringify(t));
      return ref ? { contextRef: ref } : t;
    })) : record.context;
    const full = `问题：${record.question}\n回答（未经验证）：${record.answer}\n上下文：${context}`;
    if (!this.addEntry(record.id, record.createdAt, full)) return false;
    const entry = this.context.at(-1)!;
    // Only reference a complete earlier entry; a clipped message must never be a reference target.
    if (!entry.truncated) turns?.forEach((t, i) => {
      const key = JSON.stringify(t);
      if (!this.seenContext.has(key)) this.seenContext.set(key, { citation: entry.citation, message: i + 1 });
    });
    this.records.push(record);
    return true;
  }

  addStage(stage: StageSummary): boolean {
    if (!this.addEntry(stage.id, stage.createdAt, `阶段摘要（非逐字原文；仅代表截至此时间的信息）：${stage.content}`,
      { kind: "stage", sourceCount: stage.sourceIds.length })) return false;
    this.stages.push(stage);
    return true;
  }

  private addEntry(id: string, date: string, full: string, metadata: Partial<PromptEvidence> = {}): boolean {
    if (this.seen.has(id) || this.context.length >= this.policy.maxRecords) return false;
    const maxLength = Math.min(full.length, this.policy.maxRecordChars);
    const make = (length: number): PromptEvidence => {
      // Don't split a Unicode surrogate pair at a truncation boundary.
      const content = full.slice(0, length).replace(/[\uD800-\uDBFF]$/, "");
      return { ...metadata, citation: this.context.length + 1, id, date,
        content, truncated: content.length < full.length };
    };
    const fits = (entry: PromptEvidence) => {
      const serialized = JSON.stringify([...this.context, entry]);
      return serialized.length <= this.policy.maxContextChars && estimateTokens(serialized) <= this.policy.maxEstimatedTokens;
    };
    // Prefer whole records; if necessary fit a marked excerpt without altering the original.
    let low = 0, high = maxLength;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(make(mid))) low = mid; else high = mid - 1;
    }
    const entry = make(low);
    // Don't consume a slot with an almost empty fragment or just citation metadata.
    if (entry.content.length < Math.min(80, maxLength) || !fits(entry)) return false;
    this.context.push(entry);
    this.seen.add(id);
    return true;
  }
}

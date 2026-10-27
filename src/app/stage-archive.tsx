"use client";
import { useState } from "react";
import { MarkdownContent } from "./markdown-content";
import type { RecordEntry, StageSummary } from "@/lib/types";

export function StageArchive({ stage, scope }: { stage: StageSummary; scope: string }) {
  const [records, setRecords] = useState<RecordEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/archive?scope=${encodeURIComponent(scope)}&stageId=${encodeURIComponent(stage.id)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "读取归档失败");
      setRecords(data.records);
    } catch (e) { setError(e instanceof Error ? e.message : "读取归档失败"); }
    finally { setBusy(false); }
  }
  return <details className="source-detail">
    <summary>阶段摘要 · 覆盖 {stage.sourceIds.length} 条原文</summary>
    <MarkdownContent>{stage.content}</MarkdownContent>
    <small>生成于 {new Date(stage.createdAt).toLocaleString("zh-CN")}，后续消息可能更新其中的旧值。</small>
    {!records && <button className="text-button" disabled={busy} onClick={() => void load()}>{busy ? "读取归档中…" : "展开归档原文"}</button>}
    {error && <p role="alert">{error}</p>}
    {records && <div><p>以下为完整归档，仅供查看，未自动追加给模型。</p>{records.map(r => <details key={r.id}><summary>{r.question}</summary><MarkdownContent>{r.answer}</MarkdownContent><p>上下文：{r.context}</p><small>{r.id} · {new Date(r.createdAt).toLocaleString("zh-CN")}</small></details>)}</div>}
  </details>;
}

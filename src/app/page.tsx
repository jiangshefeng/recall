"use client";

import { useEffect, useRef, useState } from "react";
import type { Evidence, Memory, RecordEntry, Turn } from "@/lib/types";
import { RetrievalTrace } from "./retrieval-trace";
import { StageArchive } from "./stage-archive";

type Snapshot = {
  config: { mode: string; llmModel: string; embeddingModel: string; ready: boolean; missing: string[] };
  stats: { hot: number; cold: number; records: number };
  memories: (Omit<Memory, "vector"> & { dimensions: number })[];
  records: RecordEntry[];
};
type Chat = Turn & { evidence?: Evidence; note?: string; elapsedMs?: number };
const suggestions = ["项目 A 的缓存分别多久过期？", "支付重试和 Redis 有什么关系？", "项目 A 使用什么开发环境？"];

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}
function date(value: string) { return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
function short(id: string) { return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id; }

export default function Home() {
  const [tab, setTab] = useState<"chat" | "memory" | "settings">("chat");
  const [scope, setScope] = useState("default");
  const [scopeDraft, setScopeDraft] = useState("default");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [messages, setMessages] = useState<Chat[]>([]);
  const [input, setInput] = useState("");
  const strategy = "expand" as const;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [filter, setFilter] = useState<"hot" | "cold" | "records">("hot");
  const [activeMemory, setActiveMemory] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const stats = snapshot?.stats || { hot: 0, cold: 0, records: 0 };
  const demo = snapshot?.config.mode === "demo";

  async function refresh() { setSnapshot(await api<Snapshot>(`/api/memories?scope=${encodeURIComponent(scope)}`)); }
  useEffect(() => {
    let active = true;
    api<Snapshot>(`/api/memories?scope=${encodeURIComponent(scope)}`).then(data => { if (active) setSnapshot(data); })
      .catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [scope]);
  useEffect(() => { const box = bottom.current; box?.scrollTo({ top: box.scrollHeight, behavior: "smooth" }); }, [messages, busy]);

  async function send(text = input) {
    if (!text.trim() || busy) return;
    const question = text.trim();
    const history = messages.slice(-6).map(({ role, content }) => ({ role, content: content.slice(0, 9000) }));
    setMessages(prev => [...prev, { role: "user", content: question }]);
    setInput(""); setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<{ answer: string; evidence: Evidence; memory: { message: string }; elapsedMs: number }>("/api/chat", { scope, question, strategy, history });
      setMessages(prev => [...prev, { role: "assistant", content: result.answer, evidence: result.evidence, note: result.memory.message, elapsedMs: result.elapsedMs }]);
      setEvidence(result.evidence);
      await refresh().catch(e => setError(`回答已完成，记忆统计刷新失败：${e.message}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求失败");
      setInput(question);
      setMessages(prev => prev.slice(0, -1));
    } finally { setBusy(false); }
  }
  async function seed() {
    setBusy(true); setError("");
    try { await api("/api/seed", { scope }); await refresh(); setNotice("示例已就绪：5 条原始问答、1 次预设合并。点击示例问题开始检索。"); }
    catch (e) { setError(e instanceof Error ? e.message : "载入失败"); }
    finally { setBusy(false); }
  }
  function switchScope() {
    if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(scopeDraft)) { setError("空间名称需为 1–80 个文字、数字、下划线或连字符"); return; }
    setScope(scopeDraft); setMessages([]); setEvidence(null); setSnapshot(null); setError(""); setNotice(""); setActiveMemory(null);
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/"><span className="brand-icon">r<span>·</span></span><div>recall<span>MEMORY LAB</span></div></a>
      <div className="workspace-label">工作空间</div>
      <div className="scope-box"><span className="scope-icon">▧</span><span>{scope}<small>本地持久化空间</small></span><i /></div>
      <nav aria-label="主导航">
        <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}><span>◌</span>记忆对话<span className="nav-arrow">↗</span></button>
        <button className={tab === "memory" ? "active" : ""} onClick={() => setTab("memory")}><span>▤</span>记忆库<span className="nav-count">{stats.hot + stats.cold}</span></button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><span>⚙</span>模型与配置</button>
      </nav>
      <div className="sidebar-note"><span className="tiny-label">HOW IT REMEMBERS</span><p>每次对话，<br />留下可追溯的记忆。</p><div className="mini-flow"><span>问答</span><b>→</b><span>摘要</span><b>→</b><span>关联</span></div></div>
      <div className="storage-status"><i /><div>SQLite 本地存储<small>原文保留 · 记忆可追溯</small></div></div>
    </aside>

    <main className="main-shell">
      <header className="topbar"><div className="breadcrumb">工作空间 <span>/</span> {tab === "chat" ? "记忆对话" : tab === "memory" ? "记忆库" : "模型与配置"}</div><div className={`mode-badge ${demo ? "demo" : ""}`}><i />{snapshot ? demo ? "演示模式" : "真实模型" : "连接中"}</div></header>
      <div className="page-heading"><div><div className="eyebrow">DYNAMIC MEMORY · RAG</div><h1>{tab === "chat" ? "让每次对话，都有所积累。" : tab === "memory" ? "看见记忆如何生长。" : "连接你的模型。"}</h1><p>{tab === "chat" ? "从相关记忆出发，找回细节，再形成新的理解。" : tab === "memory" ? "热区用于发现，冷区保留历史，原始问答始终可追溯。" : "模型在服务端调用，密钥不会发送到浏览器。"}</p></div>{demo && <button className="button secondary" disabled={busy} onClick={seed}>＋ 载入示例</button>}</div>
      <section className="stats-row" aria-label="记忆统计"><div><span className="stat-icon hot">◈</span><div><small>热区记忆</small><strong>{stats.hot}<em>条</em></strong></div><span className="stat-detail">用于首轮召回</span></div><div><span className="stat-icon cold">❄</span><div><small>冷区记忆</small><strong>{stats.cold}<em>条</em></strong></div><span className="stat-detail">保留合并历史</span></div><div><span className="stat-icon raw">▤</span><div><small>原始问答</small><strong>{stats.records}<em>条</em></strong></div><span className="stat-detail">完整保存来源</span></div></section>
      {error && <div className="alert error" role="alert">{error}<button onClick={() => setError("")} aria-label="关闭错误">×</button></div>}
      {notice && <div className="alert notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="关闭提示">×</button></div>}

      {tab === "chat" && <div className="chat-grid">
        <section className="chat-panel panel">
          <div className="panel-heading"><h2><span className="live-dot" />对话实验室</h2><button className="text-button" disabled={busy} onClick={() => { setMessages([]); setEvidence(null); }}>新对话</button></div>
          <div className="messages" aria-live="polite" ref={bottom}>
            {!messages.length && <div className="welcome"><div className="orbit"><span>✳</span><i /><b /></div><h2>从一个问题开始</h2><p>系统会检索相关记忆，补充关联信息，<br />并将本轮问答整理为新的记忆。</p><div className="suggestions">{suggestions.map(q => <button disabled={busy} key={q} onClick={() => void send(q)}>{q}<span>↗</span></button>)}</div><small>{demo ? "演示模式使用字符相似度与规则响应，不代表真实模型效果。" : "回答与摘要由你配置的模型生成。"}</small></div>}
            {messages.map((m, i) => <article className={`message ${m.role}`} key={i}><div className="avatar">{m.role === "user" ? "你" : "r·"}</div><div className="message-body"><div className="message-label">{m.role === "user" ? "你" : "Recall"}{m.elapsedMs !== undefined && <small>{(m.elapsedMs / 1000).toFixed(1)}s</small>}</div><div className="message-content">{m.content}</div>{m.note && <div className="memory-note">◈ {m.note}</div>}{m.evidence && <button className="text-button" onClick={() => setEvidence(m.evidence!)}>查看本次检索 · {m.evidence.records.length} 条原文 ↗</button>}</div></article>)}
            {busy && <div className="working"><span className="spinner" />处理中：检索 → 回答 → 整理记忆…</div>}
          </div>
          <form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}>
            <label className="sr-only" htmlFor="question">输入问题</label><textarea id="question" value={input} maxLength={4000} onChange={e => setInput(e.target.value)} placeholder="问一个问题，或告诉我需要记住的信息…" disabled={busy} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
            <div className="composer-toolbar"><span>关联检索 · 自动追溯原文</span><button className="button primary" type="submit" disabled={busy || !input.trim() || !snapshot?.config.ready}>发送 <span>↑</span></button></div>
          </form><div className="composer-footer">Enter 发送 · Shift + Enter 换行 · 历史回答未经事实验证</div>
        </section>

        <RetrievalTrace evidence={evidence} strategy={strategy} scope={scope} />
      </div>}

      {tab === "memory" && <section className="panel memory-panel"><div className="panel-heading"><div className="tabs">{(["hot", "cold", "records"] as const).map(f => <button className={filter === f ? "selected" : ""} key={f} onClick={() => { setFilter(f); setActiveMemory(null); }}>{f === "hot" ? "热区摘要" : f === "cold" ? "冷区历史" : "原始问答"}<span>{stats[f]}</span></button>)}</div><button className="text-button" onClick={() => void refresh().catch(e => setError(e.message))}>刷新 ↻</button></div><div className="memory-list">
        {filter === "records" ? snapshot?.records.map(r => <details className="record-card" key={r.id}><summary><span>{r.question}</span><small>{date(r.createdAt)}</small></summary><div className="record-answer">{r.answer}</div><div className="record-meta">{r.id} · 原始助手回答未验证</div><details><summary>保存的上下文</summary><pre>{r.context}</pre></details></details>) : snapshot?.memories.filter(m => m.status === filter).map(m => <article className="memory-card" key={m.id}><div className="memory-card-top"><span className={`pill ${m.status}`}>{m.status === "hot" ? "HOT" : "COLD"}</span><small>{date(m.createdAt)}</small></div><p>{m.summary}</p><div className="memory-card-meta"><span>{m.dimensions} 维 · {m.sourceIds.length} 条来源</span><button className="text-button" onClick={() => setActiveMemory(activeMemory === m.id ? null : m.id)}>{activeMemory === m.id ? "收起" : "追溯来源 ↗"}</button></div>{activeMemory === m.id && <div className="provenance"><p><b>整理原因：</b>{m.reason}</p>{m.stage && <StageArchive stage={m.stage} scope={scope} />}{m.parentIds.length > 0 && <p><b>合并前摘要：</b>{m.parentIds.map(short).join("、")}</p>}{snapshot.records.filter(r => m.sourceIds.includes(r.id)).map(r => <details className="source-detail" key={r.id}><summary>{r.question}</summary><p>{r.answer}</p><small>{short(r.id)} · 未验证</small></details>)}</div>}</article>)}
        {stats[filter] === 0 && <div className="library-empty">这里还没有{filter === "hot" ? "热区记忆" : filter === "cold" ? "合并历史" : "原始问答"}。<p>{filter === "cold" ? "发生合并后，合并前的两条摘要会出现在这里。" : "开始一次对话，或载入演示数据。"}</p></div>}
      </div></section>}

      {tab === "settings" && <div className="settings-grid"><section className="panel settings-card"><div className="eyebrow">WORKSPACE</div><h2>独立的记忆空间</h2><p>不同空间的记忆互不参与检索。切换空间会清空当前对话视图，数据库记录仍然保留。</p><label htmlFor="scope">空间名称</label><div className="scope-input"><input id="scope" value={scopeDraft} disabled={busy} onChange={e => setScopeDraft(e.target.value)} /><button className="button primary" disabled={busy || scopeDraft === scope} onClick={switchScope}>切换</button></div><div className="setting-divider" /><h2>当前运行状态</h2><dl><dt>模式</dt><dd>{demo ? "演示 · 无 API 调用" : "真实模型"}</dd><dt>聊天模型</dt><dd>{snapshot?.config.llmModel || "未配置"}</dd><dt>向量模型</dt><dd>{demo ? "字符 bigram 哈希（仅演示）" : snapshot?.config.embeddingModel || "未配置"}</dd><dt>存储</dt><dd>SQLite · data/rag.sqlite</dd></dl>{snapshot && !snapshot.config.ready && <div className="alert error">缺少：{snapshot.config.missing.join("、")}</div>}</section><section className="panel settings-card"><div className="eyebrow">MODEL CONNECTION</div><h2>启用真实动态记忆</h2><p>在项目根目录将 <code>.env.example</code> 复制为 <code>.env.local</code>，填写两个模型的配置，然后重启开发服务。</p><pre>{`RAG_MODE=live\n\nLLM_BASE_URL=https://服务地址/v1\nLLM_API_KEY=你的密钥\nLLM_MODEL=聊天模型名称\n\nEMBEDDING_BASE_URL=https://服务地址/v1\nEMBEDDING_API_KEY=你的密钥\nEMBEDDING_MODEL=向量模型名称`}</pre><p>支持兼容 <code>chat/completions</code> 与 <code>embeddings</code> 的 HTTP 接口。聊天和向量模型可以来自不同服务。</p><div className="config-note">演示与真实模型的向量分别检索。更换向量模型后，旧记忆不会自动重建索引，也不会和新向量混算；原始问答仍保留。</div></section></div>}
      <footer className="page-footer"><span>RECALL / LOCAL MEMORY LAB</span><span>Next.js · TypeScript · SQLite</span></footer>
    </main>
  </div>;
}

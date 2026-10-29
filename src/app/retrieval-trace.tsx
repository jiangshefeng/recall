import type { Evidence, ExpansionReason, Hit, RetrievalMode } from "@/lib/types";
import { StageArchive } from "./stage-archive";

const reasons: Record<ExpansionReason, string> = {
  "sources-only": "当前选择原文追溯，不进行关联扩展",
  "no-first-results": "首轮没有可用证据，没有扩展起点",
  "budget-exhausted": "原文条数或内容预算已用尽，停止扩展",
  "enough-first-results": "首轮命中 4 条或以上，跳过第二轮扩展",
  "below-four-results": "首轮命中少于 4 条，尝试按命中摘要扩展关联记忆",
};

function HitCard({ hit, index }: { hit: Hit; index: number }) {
  return <div className="hit-card">
    <div className="hit-top"><span>#{index + 1} · {hit.status === "hot" ? "热区" : "冷区"}</span><b>{hit.score.toFixed(3)}</b></div>
    <p>{hit.summary}</p>
    <small>{hit.sourceIds.length} 条关联来源（回答仅使用摘要）</small>
    {hit.neighborScore !== undefined && <div className="score-detail">原问题 {hit.originalScore?.toFixed(3)} × 75% ＋ 邻居 {hit.neighborScore.toFixed(3)} × 25%</div>}
  </div>;
}

export function RetrievalTrace({ evidence, strategy, scope = "default", onClose }: { evidence: Evidence | null; strategy: RetrievalMode; scope?: string; onClose?: () => void }) {
  const trace = evidence?.trace;
  const mode = evidence?.strategy || strategy;
  return <aside className="retrieval-panel panel" aria-label="记忆路径">
    <div className="panel-heading"><h2>记忆路径</h2>{onClose && <button className="text-button" onClick={onClose}>关闭面板</button>}</div>
    <div className="trace-intro">从一条记忆，找到回答的依据。</div>
    {trace && <div className="budget-summary" data-testid="budget-usage">
      <strong>历史证据预算</strong>
      <p>{trace.usage.records} / {trace.policy.maxRecords} 条证据 · {trace.usage.chars.toLocaleString()} / {trace.policy.maxContextChars.toLocaleString()} 字符</p>
      <p>估算 {trace.usage.estimatedTokens.toLocaleString()} / {trace.policy.maxEstimatedTokens.toLocaleString()} tokens</p>
      <small>只计算发送的历史证据（含 JSON 元数据），不含当前问题和近期对话。{trace.usage.truncatedRecords > 0 && `${trace.usage.truncatedRecords} 条采用节选，原文仍完整保留。`}</small>
    </div>}
    <div className="steps">
      <div className="step"><span>01</span><div><h3>相关摘要</h3><p>{trace ? `阈值 ${trace.minScore.toFixed(2)} · ${trace.firstCandidates} 条候选 · 最多选 ${trace.policy.firstLimit} 条` : "按摘要相似度和上下文预算筛选"}</p></div><b>{evidence?.first.length ?? "—"}</b></div>
      {evidence?.first.map((hit, i) => <HitCard key={hit.id} hit={hit} index={i} />)}
      {!!evidence?.suggestions?.length && <section data-testid="low-score-suggestions">
        <h3>最接近的记忆（未达阈值）</h3>
        <p>仅供查看，未作为证据发送给模型。</p>
        {evidence.suggestions.map((hit, i) => <HitCard key={hit.id} hit={hit} index={i} />)}
      </section>}
      <div className="step"><span>02</span><div><h3>条件关联扩展</h3><p>{`首轮少于 4 条时扩展 · 每个起点最多 ${trace?.policy.neighborsPerSeed ?? 100} 个候选 · 原问题约束`}</p></div><b>{evidence?.second.length ?? "—"}</b></div>
      {trace && <div className="expansion-status" data-testid="expansion-status"><b>{trace.expanded ? "已触发第二轮" : "未触发第二轮"}</b><p>{reasons[trace.reason]}</p><small>当前为规则判断，不代表模型已确认信息充分。</small></div>}
      {evidence?.second.map((hit, i) => <HitCard key={hit.id} hit={hit} index={i} />)}
      <div className="step"><span>03</span><div><h3>实际发送的证据</h3><p>与模型接收内容一致 · 来源可追溯</p></div><b>{evidence?.context.length ?? "—"}</b></div>
      {evidence?.context.map(entry => {
        const original = evidence.records.find(r => r.id === entry.id);
        return <details className="source-detail" key={entry.id}>
          <summary>[{entry.citation}] {entry.kind === "stage" ? `阶段摘要（${entry.sourceCount ?? 0} 条归档来源）` : entry.kind === "summary" ? `记忆摘要（${entry.sourceCount ?? 0} 条来源）` : original?.question || entry.id}{entry.truncated && "（节选）"}</summary>
          <p data-testid="prompt-excerpt">{entry.content}</p>
          <small>{new Date(entry.date).toLocaleString("zh-CN")} · 历史回答未验证</small>
          {entry.truncated && original && <details><summary>查看完整原始问答</summary><p>问题：{original.question}{"\n"}回答：{original.answer}{"\n"}上下文：{original.context}</p></details>}
          {entry.kind === "stage" && evidence.stages?.filter(s => s.id === entry.id).map(stage => <StageArchive key={stage.id} stage={stage} scope={scope} />)}
        </details>;
      })}
    </div>
    {!evidence && <div className="trace-empty"><p>暂无检索记录</p><small>发送问题后，在这里查看关联与来源。</small></div>}
    {evidence && !evidence.first.length && <div className="trace-empty"><p>没有在相关性和预算限制内选入证据。<br />不会强行补满结果。</p></div>}
    <div className="trace-bottom">相似度不代表事实可信度。token 为文本估算值，字符限制同时生效。</div>
  </aside>;
}

// Paid diagnostic only: frozen public LoCoMo-derived jobs, no database mutations.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { decideMemoryMerges } from "../src/lib/rag";
import { MemoryStore } from "../src/lib/store";
import { modelConfig } from "../src/lib/providers";
import { mergeEnvelope, mergeSchema, mergePrompt, validateMergeDecisions, type MergeDecision } from "../src/lib/merge-protocol";
import { parseStructured, StructuredOutputError, type OutputDiagnostic } from "../src/lib/structured-output";
import type { Memory, RecordEntry } from "../src/lib/types";

type Body = { model: string; messages: { role: string; content: string }[]; max_tokens: number; enable_thinking?: boolean };
type Case = { id: string; jobs: { incoming: Memory; candidates: Memory[] }[]; beforeRequest: Body };
type Arm = { status: string; fullSchema: boolean; retained: number; actionable: number; plannedMerges: number;
  finishReason?: string; diagnostics: OutputDiagnostic[]; semanticErrors: string[];
  inputTokens: number; outputTokens: number; estimatedCost: number; charged: number; responseFile: string };
type Pair = { id: string; expected: number; before: Arm; after: Arm };
const root = resolve("artifacts/merge-protocol-ab"), responseDir = resolve(root, "responses");
const ledgerPath = resolve(root, "results.json");
const budget = 1.6, inputPrice = 0.8 / 1e6, outputPrice = 2.7 / 1e6;
const legacyEnvelope = z.object({ decisions: z.array(mergeSchema.extend({ incomingId: z.string() })).max(20) });
const canonicalEnvelope = z.object({ decisions: z.array(mergeSchema.extend({ incomingId: z.string(),
  action: z.enum(["merge", "replace", "delete", "add"]), deletionQuote: z.string().max(700).nullable(),
  stageSummary: z.string().trim().max(4000).nullable() })).max(20) });
const fixture: { records: RecordEntry[]; cases: Case[]; note: string } = JSON.parse(readFileSync(resolve(root, "cases.json"), "utf8"));
const cfg = modelConfig(), realFetch = globalThis.fetch;
const ledger: { budget: number; model: string; note: string; inputPricePerMillion: number; outputPricePerMillion: number;
  pairs: Pair[]; attempts: { id: string; arm: string; bound: number; charged: number; cost: number }[];
  stopReason: string; updatedAt: string; canonicalBatches: { before: number; after: number } } = existsSync(ledgerPath)
  ? JSON.parse(readFileSync(ledgerPath, "utf8"))
  : { budget, model: cfg.llmModel, note: fixture.note, inputPricePerMillion: 0.8, outputPricePerMillion: 2.7,
    pairs: [], attempts: [], stopReason: "running", updatedAt: "", canonicalBatches: { before: 0, after: 0 } };

const spent = () => ledger.attempts.reduce((s, a) => s + a.charged, 0);
const bound = (body: Body) => (Buffer.byteLength(JSON.stringify(body), "utf8") + 2048) * inputPrice + body.max_tokens * outputPrice;
const percent = (n: number, d: number) => d ? `${(n / d * 100).toFixed(1)}%` : "—";

function persist() {
  ledger.updatedAt = new Date().toISOString();
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
  const pairs = ledger.pairs, total = pairs.reduce((s, p) => s + p.expected, 0);
  const sum = (arm: "before" | "after", field: "retained" | "actionable" | "plannedMerges") => pairs.reduce((s, p) => s + p[arm][field], 0);
  const full = (arm: "before" | "after") => pairs.filter(p => p[arm].fullSchema).length;
  const diag = (arm: "before" | "after") => {
    const counts: Record<string, number> = {};
    for (const p of pairs) for (const d of p[arm].diagnostics) {
      const key = `${d.stage}:${d.path.replace(/\.\d+\./g, ".*. ").replace(/\s/g, "")}:${d.code}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "- 无";
  };
  const actual = ledger.attempts.reduce((s, a) => s + a.cost, 0);
  const lines = ["# 三项修复初版对比（reason 尚未收紧）", "", `模型：${ledger.model}；同一批固定任务分别调用修改前、三项修复初版的提示词，每个版本一次，无重试。`, "",
    `已完成 **${pairs.length} 对批次、${total} 个新记忆任务/版本**，共 ${ledger.attempts.length} 次请求。`, "",
    "| 指标 | 修改前 | 修改后 |", "|---|---:|---:|",
    `| 整批结构及 ID 对应全部合格 | ${full("before")}/${pairs.length}（${percent(full("before"), pairs.length)}） | ${full("after")}/${pairs.length}（${percent(full("after"), pairs.length)}） |`,
    `| 结构合格且保留下来供后续校验的决策 | ${sum("before", "retained")}/${total}（${percent(sum("before", "retained"), total)}） | ${sum("after", "retained")}/${total}（${percent(sum("after", "retained"), total)}） |`,
    `| 再通过操作、目标争用、撤回及阶段字段检查 | ${sum("before", "actionable")}/${total} | ${sum("after", "actionable")}/${total} |`,
    `| 其中可执行合并或覆盖的计划数 | ${sum("before", "plannedMerges")} | ${sum("after", "plannedMerges")} |`, "",
    "新增/保持独立也是合法决策，保留决策数不等于合并成功数。此脚本不实际入库；真实部分入库行为由离线集成测试验证。", "",
    `费用按输入 ¥0.8/百万 token、输出 ¥2.7/百万 token 估算：**¥${actual.toFixed(4)}**；保守预算记账 ¥${spent().toFixed(4)} / ¥${budget}。`,
    "接口返回 usage 时按其 token 数估算；无 usage 或请求中断则以预留上界记账并停止。实际扣费可能受缓存、赠送额度和服务商计费影响，以账单为准。", "",
    `停止原因：${ledger.stopReason}。`, "", "## 主要格式问题（修改前）", "", diag("before"), "", "## 主要格式问题（修改后）", "", diag("after"), "",
    "## 对比范围", "", "样本来自之前发生格式失败的轮次；候选使用当时评测的最终快照重建。两个版本接收相同任务、相同原文与候选，轮流先后调用，均关闭 thinking。它不是原始失败请求的精确重放，也不是随机抽样。不能据此声称整体失败率或 LoCoMo 答题分数提升。", "",
    "修改前按原整体 Zod 校验，一项字段错误使整批决策无法使用；修改后逐项校验，重复 incomingId 的全部相关项无效，未知 ID 不操作，其他有效项继续。整批合格率采用两者相同的兼容结构与 ID 校验标准，不把兜底保存计作成功。", "",
    `全部新字段均按规范输出的批次：修改前 ${ledger.canonicalBatches.before}/${pairs.length}；修改后 ${ledger.canonicalBatches.after}/${pairs.length}。旧输出缺失可选 action/stageSummary/deletionQuote 仍兼容。`, "",
    "## 逐批结果", "", "| 样本 | 任务数 | 修改前保留 | 修改后保留 | 修改前可合并/覆盖 | 修改后可合并/覆盖 |", "|---|---:|---:|---:|---:|---:|",
    ...pairs.map(p => `| ${p.id} | ${p.expected} | ${p.before.retained} | ${p.after.retained} | ${p.before.plannedMerges} | ${p.after.plannedMerges} |`), ""];
  writeFileSync(resolve(root, "comparison.md"), lines.join("\n"));
}

function semantics(decisions: MergeDecision[], row: Case) {
  const used = new Set<string>(), errors: string[] = [];
  let actionable = 0, merges = 0;
  const input = JSON.parse(row.beforeRequest.messages[1].content);
  for (const job of row.jobs) {
    const d = decisions.find(d => d.incomingId === job.incoming.id);
    if (!d) continue;
    const action = d.action ?? (d.relation === "update" ? "replace" : ["duplicate", "complement"].includes(d.relation) ? "merge" : "add");
    const target = job.candidates.find(c => c.id === d.candidateId);
    let error: string | undefined;
    if (d.action && ((action === "merge" && !["duplicate", "complement"].includes(d.relation)) ||
      (action === "replace" && d.relation !== "update") || (action === "delete" && d.relation !== "retract") ||
      (action === "add" && d.candidateId !== null) || (action !== "add" && !target))) error = "action_relation_target";
    if (!error && target && action !== "add") {
      if (used.has(target.id)) error = "target_collision";
      else if (action === "delete") {
        const question = fixture.records.find(r => r.id === job.incoming.sourceIds[0])?.question || "";
        if (!d.deletionQuote?.trim() || !question.includes(d.deletionQuote)) error = "deletion_quote";
      } else {
        if ((target.kind === "qa") !== (job.incoming.kind === "qa")) error = "kind_mismatch";
        else if (!d.summary.trim()) error = "empty_summary";
        else if (input.jobs.find((j: { incomingId: string }) => j.incomingId === d.incomingId)?.compression
          .find((p: { candidateId: string }) => p.candidateId === d.candidateId)?.required && !d.stageSummary?.trim()) error = "missing_stage";
      }
    }
    if (error) { errors.push(`${job.incoming.id}:${error}`); continue; }
    actionable++;
    if (target && action !== "add") used.add(target.id);
    if (target && ["merge", "replace"].includes(action) && d.summary.trim()) merges++;
  }
  return { actionable, merges, errors };
}

async function requestArm(row: Case, arm: "before" | "after", body: Body, index: number): Promise<Arm> {
  const reserve = bound(body);
  if (spent() + reserve > budget) throw Error("budget");
  const attempt = { id: row.id, arm, bound: reserve, charged: reserve, cost: reserve };
  ledger.attempts.push(attempt); persist();
  const responseFile = `responses/${String(index + 1).padStart(3, "0")}-${arm}.json`;
  const result: Arm = { status: "request_error", fullSchema: false, retained: 0, actionable: 0, plannedMerges: 0,
    diagnostics: [], semanticErrors: [], inputTokens: 0, outputTokens: 0, estimatedCost: reserve, charged: reserve, responseFile };
  try {
    const res = await realFetch(`${cfg.llmBase}/chat/completions`, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.llmKey}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    if (!res.ok) { result.status = `http_${res.status}`; writeFileSync(resolve(root, responseFile), JSON.stringify({ status: res.status })); return result; }
    const response = await res.json();
    writeFileSync(resolve(root, responseFile), JSON.stringify(response, null, 2));
    const usage = response.usage;
    if (Number.isFinite(usage?.prompt_tokens) && usage.prompt_tokens >= 0 && Number.isFinite(usage?.completion_tokens) && usage.completion_tokens >= 0) {
      result.inputTokens = usage.prompt_tokens; result.outputTokens = usage.completion_tokens;
      result.estimatedCost = usage.prompt_tokens * inputPrice + usage.completion_tokens * outputPrice;
      result.charged = result.estimatedCost; attempt.charged = result.charged; attempt.cost = result.estimatedCost;
    } else { result.status = "missing_usage"; return result; }
    const choice = response.choices?.[0]; result.finishReason = choice?.finish_reason;
    if (typeof choice?.message?.content !== "string") { result.status = "missing_content"; return result; }
    result.status = "ok";
    let decisions: MergeDecision[] = [];
    try {
      const text = choice.message.content;
      const envelope = parseStructured(text, arm === "before" ? legacyEnvelope : mergeEnvelope, result.finishReason);
      const validation = validateMergeDecisions(envelope.decisions, row.jobs, result.finishReason);
      result.fullSchema = validation.diagnostics.length === 0;
      result.diagnostics = validation.diagnostics;
      decisions = validation.decisions;
      const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim());
      if (canonicalEnvelope.safeParse(parsed).success && result.fullSchema) ledger.canonicalBatches[arm]++;
    } catch (e) {
      if (!(e instanceof StructuredOutputError)) throw e;
      result.diagnostics = e.diagnostics;
    }
    result.retained = decisions.length;
    const semantic = semantics(decisions, row);
    result.actionable = semantic.actionable; result.plannedMerges = semantic.merges; result.semanticErrors = semantic.errors;
    return result;
  } catch {
    writeFileSync(resolve(root, responseFile), JSON.stringify({ status: "request_failed_or_timeout", conservativeCharge: reserve }));
    return result;
  } finally { persist(); }
}

async function main() {
  if (!cfg.llmKey || !cfg.llmModel || cfg.mode !== "live") throw Error("Live LLM configuration required");
  if (ledger.model !== cfg.llmModel) throw Error("Model changed; do not mix ledgers");
  if (ledger.attempts.length !== ledger.pairs.length * 2) throw Error("Incomplete prior pair; inspect existing ledger before spending more");
  mkdirSync(responseDir, { recursive: true });
  const store = new MemoryStore(":memory:"); fixture.records.forEach(r => store.saveRecord(r));
  const limit = Math.min(fixture.cases.length, Number(process.env.MERGE_AB_MAX_PAIRS) || fixture.cases.length);
  const snapshot = readFileSync(resolve(root, "merge-protocol-initial.ts.txt"), "utf8").replace(/\r\n/g, "\n");
  const initialPrompt = snapshot.split("export const mergePrompt = `")[1]?.replace(/`;\s*$/, "");
  if (ledger.pairs.length < limit && mergePrompt !== initialPrompt)
    throw Error("Initial prompt changed; use verify-merge-reason.ts for the final short-reason pass, do not mix versions");
  try {
    for (let index = ledger.pairs.length; index < limit; index++) {
      const row = fixture.cases[index];
      let captured: Body | undefined;
      globalThis.fetch = async (_input, init) => {
        captured = JSON.parse(String(init?.body));
        return Response.json({ choices: [{ message: { content: '{"decisions":[]}' }, finish_reason: "stop" }] });
      };
      try { await decideMemoryMerges(store, row.jobs); } finally { globalThis.fetch = realFetch; }
      if (!captured) throw Error("No after request captured");
      if (captured.messages[1].content !== row.beforeRequest.messages[1].content)
        throw Error("Before/after input differs; refusing a non-paired comparison");
      const beforeBody = { ...row.beforeRequest, enable_thinking: false }, afterBody = { ...captured, enable_thinking: false };
      if (spent() + bound(beforeBody) + bound(afterBody) > budget) { ledger.stopReason = "保守预留不足以完成下一对，已停止"; break; }
      const arms: Partial<Record<"before" | "after", Arm>> = {};
      for (const arm of (index % 2 ? ["after", "before"] : ["before", "after"]) as ("before" | "after")[]) {
        arms[arm] = await requestArm(row, arm, arm === "before" ? beforeBody : afterBody, index);
        if (arms[arm]!.status !== "ok") {
          ledger.stopReason = `${row.id}/${arm}: ${arms[arm]!.status}，保留已完成对比并停止`; persist(); return;
        }
      }
      ledger.pairs.push({ id: row.id, expected: row.jobs.length, before: arms.before!, after: arms.after! });
      ledger.stopReason = "running"; persist();
      console.log(JSON.stringify({ pair: index + 1, id: row.id, jobs: row.jobs.length,
        before: arms.before!.retained, after: arms.after!.retained, spent: +spent().toFixed(4) }));
    }
    if (ledger.stopReason === "running") ledger.stopReason = ledger.pairs.length === fixture.cases.length ? "固定样本全部完成" : "达到本次批次上限，可在同一记账文件上继续";
    persist(); console.log(`REPORT=${resolve(root, "comparison.md")}; COST=${spent().toFixed(4)}`);
  } finally { globalThis.fetch = realFetch; store.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Diagnostic failed"); process.exitCode = 1; });

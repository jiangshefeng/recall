// Second pass: reuse paid baseline responses, test the final short-reason prompt.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { decideMemoryMerges } from "../src/lib/rag";
import { mergePrompt } from "../src/lib/merge-protocol";
import { modelConfig } from "../src/lib/providers";
import { MemoryStore } from "../src/lib/store";
import { StructuredOutputError, type OutputDiagnostic } from "../src/lib/structured-output";
import type { Memory, RecordEntry } from "../src/lib/types";

type Arm = { retained: number; fullSchema: boolean; charged: number; inputTokens?: number; outputTokens?: number };
type BasePair = { id: string; expected: number; before: Arm; after: Arm };
type Row = { id: string; jobs: { incoming: Memory; candidates: Memory[] }[];
  beforeRequest: { messages: { content: string }[] } };
type FinalPair = { id: string; expected: number; before: Arm; initialAfter: Arm; after: Arm;
  diagnostics: OutputDiagnostic[]; reasonLengths: number[]; finishReason?: string };
type Attempt = { id: string; charged: number; inputTokens: number; outputTokens: number; status: string; responseFile: string };
const root = resolve("artifacts/merge-protocol-ab"), path = resolve(root, "results-short-reason.json");
const baseline: { model: string; pairs: BasePair[]; attempts: { charged: number }[]; stopReason: string } =
  JSON.parse(readFileSync(resolve(root, "results.json"), "utf8"));
const fixture: { records: RecordEntry[]; cases: Row[] } = JSON.parse(readFileSync(resolve(root, "cases.json"), "utf8"));
const cfg = modelConfig(), realFetch = globalThis.fetch, budget = 1.6;
const baseCost = baseline.attempts.reduce((s, a) => s + a.charged, 0);
const promptHash = createHash("sha256").update(mergePrompt).digest("hex");
const ledger: { model: string; promptHash: string; baseCost: number; budget: number; pairs: FinalPair[];
  attempts: Attempt[]; stopReason: string; updatedAt: string } = existsSync(path) ? JSON.parse(readFileSync(path, "utf8"))
  : { model: cfg.llmModel, promptHash, baseCost, budget, pairs: [], attempts: [], stopReason: "running", updatedAt: "" };
const spent = () => baseCost + ledger.attempts.reduce((s, a) => s + a.charged, 0);
const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}%` : "—";

function persist() {
  ledger.updatedAt = new Date().toISOString(); writeFileSync(path, JSON.stringify(ledger, null, 2));
  const rows = ledger.pairs, expected = rows.reduce((s, p) => s + p.expected, 0);
  const arms = ["before", "initialAfter", "after"] as const;
  const full = arms.map(arm => rows.filter(p => p[arm].fullSchema).length);
  const kept = arms.map(arm => rows.reduce((s, p) => s + p[arm].retained, 0));
  const outputTokens = arms.map(arm => rows.reduce((s, p) => s + (p[arm].outputTokens || 0), 0));
  const lengths = rows.flatMap(p => p.reasonLengths);
  const issues: Record<string, number> = {};
  rows.forEach(p => p.diagnostics.forEach(d => { const k = `${d.stage}:${d.path.replace(/\.\d+\./g, ".*.")}:${d.code}`; issues[k] = (issues[k] || 0) + 1; }));
  const shortCost = ledger.attempts.reduce((s, a) => s + a.charged, 0);
  const lines = ["# 最终短理由版对比", "", `模型：${cfg.llmModel}。已测试 **${rows.length} 批、${expected} 个新记忆任务**。`, "",
    "| 指标 | 修改前 | 三项修复初版 | 最终短理由版 |", "|---|---:|---:|---:|",
    `| 整批结构及ID对应合格 | ${full.map(n => `${n}/${rows.length}（${pct(n, rows.length)}）`).join(" | ")} |`,
    `| 合格且保留供后续操作校验的决策 | ${kept.map(n => `${n}/${expected}（${pct(n, expected)}）`).join(" | ")} |`, "",
    `三组在相同任务上的输出 token 总量：修改前 ${outputTokens[0]}；修复初版 ${outputTokens[1]}；最终版 ${outputTokens[2]}。输出更少不代表语义判断更准确。`, "",
    `可解析响应中的 reason 长度：${lengths.filter(n => n <= 80).length}/${lengths.length} 条在80字符内，最长 ${Math.max(0, ...lengths)} 字符；JSON解析失败的响应不计入长度统计。代码仍按500字符硬校验，未截断文本。`, "",
    `本轮短理由补测估费 **¥${shortCost.toFixed(4)}**；加上前一轮对比 **¥${spent().toFixed(4)} / ¥${budget}**。按输入0.8元/百万、输出2.7元/百万 token 计算，实际扣费以服务商账单为准；中断或无 usage 请求按保守上界记账。`, "",
    `停止原因：${ledger.stopReason}。`, "", "## 仍存在的结构问题", "",
    ...(Object.keys(issues).length ? Object.entries(issues).map(([k, n]) => `- ${k}: ${n}`) : ["- 本组未观察到结构错误。"]), "",
    "## 范围与解释", "", "修改前及三项修复初版复用上一轮保存的响应，不重复花费。最终版收到完全相同的任务、原文和候选，均关闭 thinking，各任务只有一次新调用；最终版在上一轮之后测试，未交替请求顺序。", "",
    "样本选自历史格式失败轮次，候选由最终记忆快照重建，并非当时请求的精确重放或随机样本。保留决策包含新增/独立保存，不能称为合并成功率。脚本不执行入库，真实部分入库与操作安全边界由离线测试验证。这里不是 LoCoMo 问答复测，不能据此宣称回答分数提升。", "",
    "最终修改：统一JSON协议、详细安全诊断、逐项校验，另要求 reason 为80字符以内的单句，禁止逐项分析候选。旧版仍整批校验；新版不额外重试模型，不裁剪错误响应来计作通过。", "",
    "## 逐批对比", "", "| 样本 | 任务数 | 修改前保留 | 修复初版保留 | 最终版保留 |", "|---|---:|---:|---:|---:|",
    ...rows.map(p => `| ${p.id} | ${p.expected} | ${p.before.retained} | ${p.initialAfter.retained} | ${p.after.retained} |`), ""];
  writeFileSync(resolve(root, "comparison-short-reason.md"), lines.join("\n"));
}

async function main() {
  if (!cfg.llmKey || cfg.mode !== "live" || cfg.llmModel !== baseline.model) throw Error("Live model must match baseline");
  if (baseline.attempts.length !== baseline.pairs.length * 2 || baseline.stopReason === "running") throw Error("Wait for the first comparison to finish");
  if (ledger.model !== cfg.llmModel || ledger.promptHash !== promptHash || ledger.baseCost !== baseCost) throw Error("Ledger/prompt mismatch");
  if (ledger.attempts.length !== ledger.pairs.length) throw Error("Incomplete prior request; inspect ledger before spending more");
  mkdirSync(resolve(root, "responses-short-reason"), { recursive: true });
  const store = new MemoryStore(":memory:"); fixture.records.forEach(r => store.saveRecord(r));
  try {
    for (const pair of baseline.pairs.slice(ledger.pairs.length)) {
      const row = fixture.cases.find(r => r.id === pair.id)!;
      let attempt: Attempt | undefined, reasonLengths: number[] = [], finishReason: string | undefined;
      globalThis.fetch = async (input, init) => {
        const body = JSON.parse(String(init?.body)); body.enable_thinking = false;
        if (body.messages[1].content !== row.beforeRequest.messages[1].content) throw Error("input_mismatch");
        const reserve = (Buffer.byteLength(JSON.stringify(body), "utf8") + 2048) * 0.8 / 1e6 + body.max_tokens * 2.7 / 1e6;
        if (spent() + reserve > budget) throw Error("budget");
        attempt = { id: pair.id, charged: reserve, inputTokens: 0, outputTokens: 0, status: "pending",
          responseFile: `responses-short-reason/${String(ledger.pairs.length + 1).padStart(3, "0")}.json` };
        ledger.attempts.push(attempt); persist();
        const response = await realFetch(input, { ...init, body: JSON.stringify(body) });
        if (!response.ok) { attempt.status = `http_${response.status}`; persist(); return response; }
        const data = await response.clone().json();
        writeFileSync(resolve(root, attempt.responseFile), JSON.stringify(data, null, 2));
        const usage = data.usage;
        if (!Number.isFinite(usage?.prompt_tokens) || usage.prompt_tokens < 0 || !Number.isFinite(usage?.completion_tokens) || usage.completion_tokens < 0) {
          attempt.status = "missing_usage"; persist(); throw Error("missing_usage");
        }
        attempt.inputTokens = usage.prompt_tokens; attempt.outputTokens = usage.completion_tokens;
        attempt.charged = (usage.prompt_tokens * 0.8 + usage.completion_tokens * 2.7) / 1e6; attempt.status = "ok";
        finishReason = data.choices?.[0]?.finish_reason;
        try {
          const content = data.choices[0].message.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
          const parsed = JSON.parse(content);
          reasonLengths = Array.isArray(parsed.decisions) ? parsed.decisions.filter((d: { reason?: unknown }) => typeof d?.reason === "string")
            .map((d: { reason: string }) => d.reason.length) : [];
        } catch { /* The production parser records JSON diagnostics. */ }
        persist(); return response;
      };
      let decisions = 0, diagnostics: OutputDiagnostic[] = [];
      try {
        const result = await decideMemoryMerges(store, row.jobs);
        decisions = result.decisions.length; diagnostics = result.diagnostics;
      } catch (error) {
        if (error instanceof StructuredOutputError) diagnostics = error.diagnostics;
        else { ledger.stopReason = attempt ? `请求未完成（${attempt.status}），保守记账并停止` : "剩余预算不足或输入不一致，未发送下一请求"; persist(); break; }
      } finally { globalThis.fetch = realFetch; }
      if (!attempt || attempt.status !== "ok") { ledger.stopReason = "未获得有效usage，停止"; persist(); break; }
      ledger.pairs.push({ id: pair.id, expected: pair.expected, before: pair.before, initialAfter: pair.after,
        after: { retained: decisions, fullSchema: diagnostics.length === 0, charged: attempt.charged,
          inputTokens: attempt.inputTokens, outputTokens: attempt.outputTokens }, diagnostics, reasonLengths, finishReason });
      ledger.stopReason = "running"; persist();
      console.log(JSON.stringify({ pair: ledger.pairs.length, id: pair.id, expected: pair.expected, retained: decisions, totalCost: +spent().toFixed(4) }));
    }
    if (ledger.stopReason === "running") ledger.stopReason = "上一轮全部样本已完成最终版补测";
    persist(); console.log(`REPORT=${resolve(root, "comparison-short-reason.md")}; TOTAL_COST=${spent().toFixed(4)}`);
  } finally { globalThis.fetch = realFetch; store.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Short-reason diagnostic failed"); process.exitCode = 1; });

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { modelConfig } from "../src/lib/providers";
import { makeSmallPlan, type Sample } from "./locomo-small-support";

const model = modelConfig();
assert.equal(model.mode, "live");
assert.equal(model.llmModel, "gpt-6-luna");
assert.ok(new Set(["localhost", "127.0.0.1", "::1"]).has(new URL(model.embeddingBase).hostname));
const root = resolve(process.env.LOCOMO_599_OUT || "artifacts/locomo-luna-mem0-599-v2");
const totalBudgetUsd = Number(process.env.LOCOMO_599_BUDGET_USD || 30);
const totalTokenCap = Number(process.env.LOCOMO_599_TOKEN_CAP || 40_000_000);
const inputUsdPerMillion = Number(process.env.LOCOMO_INPUT_USD_PER_MILLION || 5);
const outputUsdPerMillion = Number(process.env.LOCOMO_OUTPUT_USD_PER_MILLION || 15);
assert.ok(Number.isFinite(totalBudgetUsd) && totalBudgetUsd > 0 && totalBudgetUsd <= 30);
assert.ok(Number.isSafeInteger(totalTokenCap) && totalTokenCap >= 1_000_000 && totalTokenCap <= 40_000_000);

const dataPath = resolve("artifacts/locomo-data/locomo10.json"), dataBytes = readFileSync(dataPath);
const data: Sample[] = JSON.parse(dataBytes.toString("utf8").replace(/^\uFEFF/, ""));
const ids = ["conv-26", "conv-49", "conv-50"];
const samples = ids.map(id => {
  const sample = data.find(row => row.sample_id === id); assert.ok(sample);
  const sessionCount = Object.keys(sample.conversation).filter(key => /^session_\d+$/.test(key)).length;
  const flattened = makeSmallPlan(sample, sessionCount);
  return { id, sessionCount, turns: flattened.turns.length, questions: sample.qa.length,
    out: resolve(root, id), weight: flattened.turns.length * 0.1 + sample.qa.length * 0.0085 };
});
assert.equal(samples.reduce((n, row) => n + row.questions, 0), 599);
assert.equal(samples.reduce((n, row) => n + row.turns, 0), 1496);
const pilot = JSON.parse(readFileSync("artifacts/locomo-mem0-pilot-conv-30-t8-luna-v2/report.json", "utf8"));
assert.equal(pilot.status, "completed");

// Include Luna requests already made for preflights and the small pilot in the $30 estimate.
const priorUsage = { tokens: 0, usd: 0 };
for (const directory of readdirSync("artifacts", { withFileTypes: true }).filter(entry => entry.isDirectory() &&
  (entry.name.startsWith("locomo-mem0-pilot-") || entry.name.startsWith("mem0-preflight-")))) {
  const path = resolve("artifacts", directory.name, "report.json"); if (!existsSync(path)) continue;
  const report = JSON.parse(readFileSync(path, "utf8"));
  if ((report.manifest?.chatModel || report.model) !== model.llmModel) continue;
  for (const request of report.requests || []) {
    if (request.kind !== "chat") continue;
    const input = request.promptTokens ?? request.inputTokens ?? 0;
    const output = request.completionTokens ?? request.outputTokens ?? 0;
    priorUsage.tokens += input + output;
    priorUsage.usd += (input * inputUsdPerMillion + output * outputUsdPerMillion) / 1_000_000;
  }
}
const plan = {
  benchmark: "LoCoMo 599-question three-conversation comparison",
  model: model.llmModel, apiStyle: model.llmApiStyle, embeddingModel: model.embeddingModel,
  datasetSha256: createHash("sha256").update(dataBytes).digest("hex"),
  sourceHashes: Object.fromEntries(["scripts/evaluate-locomo-four-arm.ts", "scripts/run-locomo-mem0-599.ts", "scripts/locomo-small-support.ts",
    "src/lib/rag.ts", "src/lib/retrieval.ts", "src/lib/merge-protocol.ts"].map(path =>
      [path, createHash("sha256").update(readFileSync(path)).digest("hex")])),
  conversations: samples.map(({ id, sessionCount, turns, questions, out }) => ({ id, sessionCount, turns, questions, out })),
  totalQuestions: 599, totalTurns: 1496, arms: ["dynamic", "ordinary-top6", "mem0-oss"],
  costs: { capUsd: totalBudgetUsd, estimatedAlreadySpentUsd: priorUsage.usd, estimatedAlreadySpentTokens: priorUsage.tokens,
    inputUsdPerMillion, outputUsdPerMillion, estimateOnly: true,
    allocationWeight: "0.1 estimated USD per source turn + 0.0085 per question, scaled from the 8-turn Luna pilot" },
  tokenCap: totalTokenCap,
  selection: "All official questions in conv-26, conv-49, and conv-50; every source turn in all sessions; full fresh databases; no repeated questions.",
  caveats: "Selected 3/10 LoCoMo conversations. One model and one run per question. Answers use the same prompt and evidence character/token limits; Mem0 has its own extraction prompts. API model listing exposes no price, so local cost estimates are not a provider invoice or a provider-enforced spending cap.",
};
mkdirSync(root, { recursive: true });
const planPath = resolve(root, "plan.json");
if (existsSync(planPath)) assert.deepEqual(JSON.parse(readFileSync(planPath, "utf8")), plan, "Resume requires identical plan and price assumptions");
else writeFileSync(planPath, JSON.stringify(plan, null, 2));

type Run = { id: string; status: string; out: string; budgetUsd?: number; tokenCap?: number; spentUsd?: number; tokens?: number };
const runsPath = resolve(root, "runs.json");
const runs: Run[] = existsSync(runsPath) ? JSON.parse(readFileSync(runsPath, "utf8")) : samples.map(s => ({ id: s.id, status: "queued", out: s.out }));
const save = () => writeFileSync(runsPath, JSON.stringify(runs, null, 2));
const reportFor = (run: Run) => {
  const path = resolve(run.out, "report.json"); return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
};
const spentSinceStart = () => runs.reduce((sum, run) => sum + (reportFor(run)?.usage?.estimatedUsd || 0), 0);
const tokensSinceStart = () => runs.reduce((sum, run) => sum + (reportFor(run)?.usage?.chargedTokens || 0), 0);
async function runSample(index: number) {
  const sample = samples[index], run = runs.find(row => row.id === sample.id)!;
  if (run.status === "completed") return true;
  const report = reportFor(run);
  if (report?.status === "completed") { run.status = "completed"; save(); return true; }
  const remainingTokens = totalTokenCap - priorUsage.tokens - tokensSinceStart();
  if (remainingTokens < 180_000) { run.status = "budget_blocked"; save(); return false; }
  run.status = "running";
  if (!Number.isFinite(run.budgetUsd) || run.budgetUsd! <= 0.9) run.budgetUsd = totalBudgetUsd;
  run.tokenCap ??= Math.max(180_000, Math.floor(remainingTokens * sample.weight / samples.slice(index).reduce((n, s) => n + s.weight, 0)));
  save();
  const env = {
    ...process.env, LOCOMO_SAMPLE: sample.id, LOCOMO_SESSIONS: String(sample.sessionCount), LOCOMO_TURN_LIMIT: String(sample.turns),
    LOCOMO_ALL_QUESTIONS: "true", LOCOMO_INCLUDE_RAW3: "false", LOCOMO_OUT: run.out,
    LOCOMO_EXPECTED_MODEL: model.llmModel, LOCOMO_BUDGET_USD: String(run.budgetUsd), LOCOMO_BUDGET_TOKENS: String(run.tokenCap), LOCOMO_ENFORCE_USD_BUDGET: "false",
    LOCOMO_ANSWER_RESERVE: "800000", LOCOMO_ANSWER_BUDGET_USD: "0.9",
    LOCOMO_INPUT_USD_PER_MILLION: String(inputUsdPerMillion), LOCOMO_OUTPUT_USD_PER_MILLION: String(outputUsdPerMillion),
  };
  const log = resolve(root, `${sample.id}.log`);
  console.log(`START ${sample.id}: ${sample.turns} turns, ${sample.questions} questions, USD estimate-only (not enforced); token cap=${run.tokenCap}`);
  const child = spawn(process.execPath, ["--env-file=.env.local", "--import", "tsx", "scripts/evaluate-locomo-four-arm.ts"],
    { cwd: process.cwd(), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { appendFileSync(log, bytes); process.stdout.write(bytes); });
  const code = await new Promise<number | null>((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); });
  const completed = reportFor(run);
  assert.ok(completed, "Evaluator did not save a report");
  run.status = completed.status; run.spentUsd = completed.usage?.estimatedUsd || 0; run.tokens = completed.usage?.chargedTokens || 0; save();
  console.log(`END ${sample.id}: ${run.status}; tokens=${run.tokens}; estimate=$${run.spentUsd?.toFixed(3)}; total estimate=$${(priorUsage.usd + spentSinceStart()).toFixed(3)}`);
  return code === 0 && completed.status === "completed";
}

async function main() {
  save();
  console.log(`PLAN ${plan.totalQuestions} questions / ${plan.totalTurns} turns; model=${model.llmModel}; estimated cap=$${totalBudgetUsd}; previously estimated=$${priorUsage.usd.toFixed(3)}; remaining=$${(totalBudgetUsd - priorUsage.usd).toFixed(3)}`);
  if (process.env.LOCOMO_599_PLAN_ONLY === "true") {
    const weightTotal = samples.reduce((sum, sample) => sum + sample.weight, 0);
    for (const sample of samples) console.log(`${sample.id}: ${sample.turns} turns, ${sample.questions} questions, weighted cap≈$${((totalBudgetUsd - priorUsage.usd) * sample.weight / weightTotal).toFixed(2)}`);
    return;
  }
  for (let i = 0; i < samples.length; i++) if (!(await runSample(i))) {
    console.log(`PAUSED at ${samples[i].id}; checkpoints preserved in ${root}`);
    return;
  }
  console.log(`COMPLETE: ${resolve(root, "runs.json")}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "LoCoMo campaign failed"); process.exitCode = 1; });

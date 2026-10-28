// Fresh, complete conversations. Each child owns an independent database and budget.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { modelConfig } from "../src/lib/providers";
import { makeSmallPlan, type Sample } from "./locomo-small-support";

const root = resolve(process.env.LOCOMO_CAMPAIGN || "artifacts/locomo-sub2api-gpt61-fresh-599-v2");
const cfg = modelConfig(); assert.equal(cfg.llmApiStyle, "responses"); assert.equal(cfg.mode, "live");
const dataFile = "artifacts/locomo-data/locomo10.json", bytes = readFileSync(dataFile);
const data: Sample[] = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
const ids = ["conv-26", "conv-49", "conv-50"];
mkdirSync(root, { recursive: true });
const prePath = resolve(root, "preflight.json");
if (!existsSync(prePath)) {
  const probeFile = resolve(process.env.LOCOMO_RESPONSES_PROBE || "artifacts/responses-provider-probe/responses.json");
  assert.ok(existsSync(probeFile), "Run scripts/probe-sub2api.ts first, or set LOCOMO_RESPONSES_PROBE to its recorded response");
  const probe = JSON.parse(readFileSync(probeFile, "utf8"));
  assert.equal(probe.status, "completed"); assert.equal(probe.requestedModel, cfg.llmModel);
  const usage = probe.usage;
  for (const field of ["input_tokens", "output_tokens", "total_tokens"])
    assert.ok(Number.isSafeInteger(usage?.[field]) && usage[field] >= 0, "Probe must include actual token usage");
  assert.ok(usage.total_tokens >= usage.input_tokens + usage.output_tokens);
  writeFileSync(prePath, JSON.stringify({ model: cfg.llmModel, attempt: { status: "ok", chargedTokens: usage.total_tokens,
    promptTokens: usage.input_tokens, completionTokens: usage.output_tokens } }, null, 2), { flag: "wx" });
}
const preflight = JSON.parse(readFileSync(prePath, "utf8"));
assert.equal(preflight.model, cfg.llmModel); assert.equal(preflight.attempt.status, "ok");
const tokenCap = 30000000, preflightTokens = preflight.attempt.chargedTokens;
assert.ok(Number.isSafeInteger(preflightTokens) && preflightTokens >= 0 && preflightTokens < tokenCap);
const allocation = Math.floor((tokenCap - preflightTokens) / ids.length);
const plan = { scope: "full", model: cfg.llmModel, apiStyle: cfg.llmApiStyle, reasoningEffort: cfg.reasoningEffort,
  tokenCap, concurrency: 1, datasetSha256: createHash("sha256").update(bytes).digest("hex"),
  selection: "Every official question in three complete conversations, fixed before generation; no custom questions or prediction-based filtering; all databases freshly constructed by current code. No repeated questions to inflate count.",
  samples: ids.map(id => {
    const s = data.find(s => s.sample_id === id)!;
    const sessions = Object.keys(s.conversation).filter(k => /^session_\d+$/.test(k)).length;
    return { sample: id, sessions, turns: makeSmallPlan(s, sessions).turns.length, questionIndices: s.qa.map((_, i) => i), budgetTokens: allocation, out: resolve(root, id) };
  }),
  caveats: "Selected 3/10 conversations, not all LoCoMo. Some data appeared in earlier evaluations/debugging; not held out. Different chat model versus previous tests. Token cap is a runaway guard, not a target to spend.",
};
assert.equal(plan.samples.reduce((n, s) => n + s.questionIndices.length, 0), 599);
assert.equal(plan.samples.reduce((n, s) => n + s.turns, 0), 1496);
const planPath = resolve(root, "plan.json");
if (existsSync(planPath)) {
  const previous = JSON.parse(readFileSync(planPath, "utf8"));
  if (previous.concurrency === 2) {
    assert.deepEqual({ ...previous, concurrency: 1 }, plan);
    const archive = resolve(root, "plan-before-serial.json");
    if (!existsSync(archive)) writeFileSync(archive, JSON.stringify(previous, null, 2), { flag: "wx" });
    writeFileSync(planPath, JSON.stringify(plan, null, 2));
  } else assert.deepEqual(previous, plan);
}
else writeFileSync(planPath, JSON.stringify(plan, null, 2));
type Run = { sample: string; sessions: number; out: string; budgetTokens: number; status: string; chargedTokens?: number };
const runsPath = resolve(root, "runs.json");
const runs: Run[] = existsSync(runsPath) ? JSON.parse(readFileSync(runsPath, "utf8")) : plan.samples.map(s => ({ sample: s.sample, sessions: s.sessions, out: s.out, budgetTokens: s.budgetTokens, status: "queued" }));
const save = () => writeFileSync(runsPath, JSON.stringify(runs, null, 2)); save();
let next = 0, failed = false;
let renderQueue: Promise<void> = Promise.resolve();
async function render() {
  const proc = spawn(process.execPath, ["--import", "tsx", "scripts/render-locomo-campaign.ts"], { env: { ...process.env, LOCOMO_CAMPAIGN: root }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [proc.stdout, proc.stderr]) stream.on("data", bytes => appendFileSync(resolve(root, "scoring.log"), bytes));
  await new Promise<void>((done, reject) => { proc.once("error", reject); proc.once("exit", code => code === 0 ? done() : reject(Error("Offline scoring failed"))); });
}
async function worker() {
  while (!failed && next < runs.length) {
    const run = runs[next++];
    if (run.status === "completed") continue;
    run.status = "running"; save();
    console.log(`FULL START ${run.sample}: ${plan.samples.find(s => s.sample === run.sample)!.questionIndices.length} official questions`);
    const proc = spawn(process.execPath, ["--env-file=.env.local", "--import", "tsx", "scripts/evaluate-locomo-three-arm.ts"], {
      env: { ...process.env, LOCOMO_SAMPLE: run.sample, LOCOMO_SESSIONS: String(run.sessions), LOCOMO_ALL_QUESTIONS: "true", LOCOMO_OUT: run.out,
        LOCOMO_EXPECTED_MODEL: cfg.llmModel, LOCOMO_BUDGET_TOKENS: String(run.budgetTokens), LOCOMO_ANSWER_RESERVE: "1500000" },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [proc.stdout, proc.stderr]) stream.on("data", bytes => { appendFileSync(resolve(root, `${run.sample}.log`), bytes); process.stdout.write(`[${run.sample}] ${bytes}`); });
    const code = await new Promise<number | null>((done, reject) => { proc.once("error", reject); proc.once("exit", done); });
    const report = JSON.parse(readFileSync(resolve(run.out, "report.json"), "utf8"));
    run.status = report.status; run.chargedTokens = report.requests.reduce((n: number, r: { chargedTokens: number }) => n + r.chargedTokens, 0); save();
    if (code !== 0 || report.status !== "completed") { failed = true; process.exitCode = 1; }
    console.log(`FULL END ${run.sample} ${report.status}; tokens=${run.chargedTokens}`);
    renderQueue = renderQueue.then(render); await renderQueue;
  }
}
async function main() {
  await worker();
  await render();
  console.log(`FULL CAMPAIGN ${failed ? "FAILED; checkpoints saved" : "COMPLETED"}; ${resolve(root, "comparison.md")}`);
}
main().catch(e => { console.error(e instanceof Error ? e.message : "Campaign failed"); process.exitCode = 1; });

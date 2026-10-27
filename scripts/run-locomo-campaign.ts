import assert from "node:assert/strict";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { makeSmallPlan, type Sample } from "./locomo-small-support";

const base = resolve(process.env.LOCOMO_CAMPAIGN || "artifacts/locomo-deepseek-v4-pro-0813-3plus3");
mkdirSync(base, { recursive: true });
const model = "deepseek-v4-pro-0813", tokenCap = 1000000;
assert.equal(process.env.LLM_MODEL, model);
const data: Sample[] = JSON.parse(readFileSync("artifacts/locomo-data/locomo10.json", "utf8").replace(/^\uFEFF/, ""));
const order = ["conv-48", "conv-30", "conv-49", "conv-42", "conv-41", "conv-43", "conv-44", "conv-47", "conv-50"];
const plan = { model, tokenCap, order,
  rule: "Fixed sample order, selected by metadata before predictions: first two complete sessions when remaining >=300000 tokens; otherwise one complete session when remaining >=180000; otherwise stop new builds and repeat frozen answer triplets. No score-based changes. All independent batches built from scratch.",
  candidates: order.map(id => ({ id, prefixes: [1, 2].map(n => {
    const p = makeSmallPlan(data.find(s => s.sample_id === id)!, n);
    return { sessions: n, turns: p.turns.length, questionIndices: p.selected.map(q => q.index) };
  }) })),
  repeats: "After independent batches, at most four passes over completed questions in sample/question order; same prompts, no new unique questions.",
  quota: "User-stated 1M model quota; not a live billing verification. Input and output usage both counted, including preflight; local embeddings excluded.",
};
const planFile = resolve(base, "plan.json");
if (existsSync(planFile)) assert.deepEqual(JSON.parse(readFileSync(planFile, "utf8")), plan);
else writeFileSync(planFile, JSON.stringify(plan, null, 2));
const preflight = JSON.parse(readFileSync(resolve(base, "preflight.json"), "utf8"));
assert.equal(preflight.attempt.status, "ok"); assert.equal(preflight.model, model);
type Run = { sample: string; sessions: number; out: string; budgetTokens: number; status?: string; chargedTokens?: number };
const runsFile = resolve(base, "runs.json");
const runs: Run[] = existsSync(runsFile) ? JSON.parse(readFileSync(runsFile, "utf8")) : [];
const save = () => writeFileSync(runsFile, JSON.stringify(runs, null, 2));
const used = () => preflight.attempt.chargedTokens + runs.reduce((n, run) => {
  const file = resolve(run.out, "report.json");
  if (!existsSync(file)) return n;
  return n + JSON.parse(readFileSync(file, "utf8")).requests.reduce((m: number, r: { chargedTokens: number }) => m + r.chargedTokens, 0);
}, 0);
async function child(script: string, env: Record<string, string>, log: string) {
  const proc = spawn(process.execPath, ["--env-file=.env.local", "--import", "tsx", script], { cwd: process.cwd(), env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [proc.stdout, proc.stderr]) stream.on("data", b => { appendFileSync(log, b); process.stdout.write(b); });
  const code = await new Promise<number | null>((resolve, reject) => { proc.once("error", reject); proc.once("exit", resolve); });
  return code;
}
async function main() {
  // Once repeats begin, the independent-build phase is frozen. A resumed campaign
  // must not allocate their already-spent tokens to another corpus.
  if (existsSync(resolve(base, "repeat/report.json"))) {
    const code = await child("scripts/repeat-locomo-three-arm.ts", { LOCOMO_CAMPAIGN: base }, resolve(base, "repeat.log"));
    if (code !== 0) process.exitCode = 1;
    return;
  }
  for (const sample of order) {
    const existing = runs.find(r => r.sample === sample);
    if (existing?.status === "completed") continue;
    const remaining = tokenCap - used();
    if (!existing && remaining < 180000) break;
    const run: Run = existing || { sample, sessions: remaining >= 300000 ? 2 : 1, out: "", budgetTokens: remaining };
    if (!existing) { run.out = resolve(base, `${sample}-s${run.sessions}`); runs.push(run); save(); }
    console.log(`CAMPAIGN start ${sample} s${run.sessions}; remaining=${remaining}`);
    const code = await child("scripts/evaluate-locomo-three-arm.ts", { LOCOMO_SAMPLE: sample, LOCOMO_SESSIONS: String(run.sessions), LOCOMO_OUT: run.out, LOCOMO_BUDGET_TOKENS: String(run.budgetTokens), LOCOMO_ANSWER_RESERVE: "120000" }, resolve(base, `${sample}.log`));
    const report = JSON.parse(readFileSync(resolve(run.out, "report.json"), "utf8"));
    run.status = report.status; run.chargedTokens = report.requests.reduce((n: number, r: { chargedTokens: number }) => n + r.chargedTokens, 0); save();
    console.log(`CAMPAIGN batch ${report.status}; total=${used()}; triples=${report.results.filter((r: any) => r.dynamic?.answer && r.raw?.answer && r.raw3?.answer).length}`);
    if (code !== 0 || report.status !== "completed") return;
  }
  if (runs.some(r => r.status === "completed")) {
    const code = await child("scripts/repeat-locomo-three-arm.ts", { LOCOMO_CAMPAIGN: base }, resolve(base, "repeat.log"));
    if (code !== 0) process.exitCode = 1;
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : "Campaign failure"); process.exitCode = 1; });

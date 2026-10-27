// Spend a campaign remainder on predeclared repeated answer triplets, without rebuilding.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { complete, modelConfig } from "../src/lib/providers";
import { chargeUsage, remainingAllows, reserveTokens, type TokenAttempt } from "./locomo-small-support";

const base = resolve("artifacts/locomo-extra-max0902"), out = resolve(base, "repeat");
const planBytes = readFileSync(resolve(base, "plan.json"));
const plan = JSON.parse(planBytes.toString("utf8"));
const cfg = modelConfig();
assert.equal(plan.additionalTokenCap, 600000); assert.equal(cfg.llmModel, plan.model);
const parents = plan.samples.map((s: { out: string }) => {
  const path = resolve(s.out, "report.json"), bytes = readFileSync(path), report = JSON.parse(bytes.toString("utf8"));
  assert.equal(report.status, "completed"); assert.equal(report.manifest.chatModel, cfg.llmModel);
  assert.ok(!report.requests.some((r: { kind: string; status: string }) => r.kind === "chat" && r.status !== "ok"));
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), report };
});
const inheritedTokens = parents.reduce((n: number, p: { report: { usage: { chargedTokens: number } } }) => n + p.report.usage.chargedTokens, 0);
const knownPrompts = new Map<string, number>();
const promptKey = (body: any) => JSON.stringify([body.model, body.messages, body.max_tokens]);
for (const { report: parent } of parents) {
  for (const arm of ["dynamic", "raw", "raw3"] as const) {
    const requests = parent.requests.filter((r: any) => r.kind === "chat" && r.phase === `evaluate-${arm}`);
    assert.equal(requests.length, parent.results.length);
    parent.results.forEach((source: any, i: number) => {
      assert.ok(Number.isSafeInteger(requests[i].promptTokens));
      const body = { model: cfg.llmModel, messages: [{ role: "system", content: parent.manifest.answerSystem }, { role: "user", content: JSON.stringify({ question: source.qa.question, historicalEvidence: source[arm].evidence.context }) }], max_tokens: 256 };
      knownPrompts.set(promptKey(body), requests[i].promptTokens);
    });
  }
}
// Identical frozen prompts have already been tokenized by this exact provider/model.
// Include full maximum output and an extra 512 tokens; never use this estimate for a new prompt.
const reservation = (body: any) => {
  const known = knownPrompts.get(promptKey(body));
  return known === undefined ? reserveTokens(body) : known + (body.max_tokens || 256) + 512;
};
const manifest = { model: cfg.llmModel, sharedCap: plan.additionalTokenCap, inheritedTokens, parents: parents.map((p: { path: string; sha256: string }) => ({ path: p.path, sha256: p.sha256 })),
  planSha256: createHash("sha256").update(planBytes).digest("hex"), scriptSha256: createHash("sha256").update(readFileSync("scripts/evaluate-locomo-repeat.ts")).digest("hex"),
  reservation: "Identical known prompt: original provider prompt_tokens + maximum output + 512; new prompt: conservative UTF8 bound. Actual usage charged after each call.",
  schedule: "At most four repetitions; sample order then original question order; all three arms each time, cyclic answer order; frozen evidence. Repeats do not add unique questions." };
mkdirSync(resolve(out, "responses"), { recursive: true });
const reportPath = resolve(out, "report.json");
type Request = TokenAttempt & { kind: string; responseFile?: string; responseModel?: string; httpStatus?: number };
type RepeatRow = { repetition: number; sample: string; index: number; qa: unknown; dynamic?: { answer: string }; raw?: { answer: string }; raw3?: { answer: string } };
type Report = { manifest: typeof manifest; status: string; requests: Request[]; results: RepeatRow[]; error?: string; updatedAt?: string; usage?: object };
const report: Report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : { manifest, status: "initialized", requests: [], results: [] };
assert.deepEqual(report.manifest, manifest);
assert.ok(!report.requests.some(r => r.status !== "ok"), "Unresolved request; do not repeat an unknown charge");
const save = () => { report.updatedAt = new Date().toISOString(); writeFileSync(reportPath, JSON.stringify(report, null, 2)); };
const charged = () => report.requests.reduce((n, r) => n + r.chargedTokens, 0);
const realFetch = globalThis.fetch;
let halted = false;
globalThis.fetch = async (input, init) => {
  if (halted) throw Error("Campaign guard halted");
  const body = { ...JSON.parse(String(init?.body)), enable_thinking: false, temperature: 0 };
  const reserve = reservation(body);
  if (!remainingAllows(report.requests, reserve, plan.additionalTokenCap - inheritedTokens)) { halted = true; throw Error("Shared budget reached; no request sent"); }
  const req: Request = { kind: "chat", phase: "repeat-answer", status: "pending", reserveTokens: reserve, chargedTokens: reserve };
  const id = report.requests.push(req) - 1; save();
  try {
    const response = await realFetch(input, { ...init, body: JSON.stringify(body) });
    const data = await response.clone().json(); req.httpStatus = response.status;
    req.responseFile = `responses/${id}.json`; writeFileSync(resolve(out, req.responseFile), JSON.stringify(data, null, 2));
    if (!response.ok) { req.status = `http_${response.status}`; halted = true; }
    else if (!chargeUsage(req, data.usage || {})) { req.status = "missing_usage"; halted = true; throw Error("Missing usage; reservation retained"); }
    else { req.status = "ok"; req.responseModel = data.model; if (data.model !== cfg.llmModel) { halted = true; throw Error("Unexpected model"); } }
    return response;
  } catch (e) { if (req.status === "pending") req.status = "request_error"; halted = true; throw e; }
  finally { save(); }
};

async function main() {
  try {
    for (let repetition = 1; repetition <= 4; repetition++) {
      for (const { report: parent } of parents) {
        for (const source of parent.results) {
          const found = report.results.find(r => r.repetition === repetition && r.sample === parent.manifest.sample && r.index === source.index);
          const row: RepeatRow = found || { repetition, sample: parent.manifest.sample, index: source.index, qa: source.qa };
          const arms = ["dynamic", "raw", "raw3"] as const;
          const content = (arm: typeof arms[number]) => JSON.stringify({ question: source.qa.question, historicalEvidence: source[arm].evidence.context });
          const reserve = arms.filter(a => !row[a]).reduce((n, arm) => n + reservation({ model: cfg.llmModel, messages: [{ role: "system", content: parent.manifest.answerSystem }, { role: "user", content: content(arm) }], max_tokens: 256, enable_thinking: false, temperature: 0 }), 0);
          if (!remainingAllows(report.requests, reserve, plan.additionalTokenCap - inheritedTokens)) { report.status = "budget_stopped"; save(); return; }
          if (!found) report.results.push(row);
          const shift = (source.index + repetition) % 3;
          for (const arm of [...arms.slice(shift), ...arms.slice(0, shift)]) {
            if (row[arm]) continue;
            const answer = await complete(parent.manifest.answerSystem, [{ role: "user", content: content(arm) }], 256);
            if (halted) throw Error("Guard halted campaign");
            row[arm] = { answer }; save();
          }
          console.log(`REPEAT ${repetition} ${row.sample} QA ${row.index}; SHARED_TOKENS=${inheritedTokens + charged()}`);
        }
      }
    }
    report.status = "completed"; save();
  } catch (e) { report.status = "failed"; report.error = e instanceof Error ? e.message : "Repeated answer failed"; save(); throw e; }
  finally {
    report.usage = { addedTokens: charged(), inheritedTokens, sharedTokens: inheritedTokens + charged(), sharedCap: plan.additionalTokenCap };
    save(); globalThis.fetch = realFetch;
    console.log(`REPEAT END ${report.status}; SHARED_TOKENS=${inheritedTokens + charged()}`);
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : "Repeat failed"); process.exitCode = 1; });

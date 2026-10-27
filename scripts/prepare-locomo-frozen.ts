// Freeze existing evidence for an answer-model-only comparison. No network calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve(process.env.LOCOMO_SOURCE || "artifacts/locomo-deepseek-v4-pro-0813-3plus3");
const out = resolve(process.env.LOCOMO_FROZEN || "artifacts/locomo-frozen-65");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const runs: { out: string; sample: string }[] = read(resolve(source, "runs.json"));
const arms = ["dynamic", "raw", "raw3"] as const;
const parents = runs.map(run => {
  const reportPath = resolve(run.out, "report.json"), report = read(reportPath);
  assert.equal(report.status, "completed");
  assert.ok(report.requests.filter((r: any) => r.kind === "chat").every((r: any) => r.status === "ok"));
  return { run, report, files: Object.fromEntries([reportPath, resolve(run.out, "dynamic.sqlite"), resolve(run.out, "raw.sqlite")].map(path => [path, hash(readFileSync(path))])) };
});
const models = [...new Set(parents.map(p => p.report.manifest.chatModel))]; assert.equal(models.length, 1);
const inputs = parents.flatMap(({ report, run }) => report.results.map((row: any) => {
  assert.ok(arms.every(arm => typeof row[arm]?.answer === "string" && !row[arm].error));
  return { sample: run.sample, originalIndex: row.index,
    arms: Object.fromEntries(arms.map(arm => [arm, { system: report.manifest.answerSystem,
      user: JSON.stringify({ question: row.qa.question, historicalEvidence: row[arm].evidence.context }), maxTokens: report.manifest.answerMaxTokens }])) };
}));
assert.equal(new Set(inputs.map(row => `${row.sample}:${row.originalIndex}`)).size, inputs.length);
const inputsText = JSON.stringify(inputs, null, 2);
const plan = { mode: "Answer model only; existing knowledge and exact retrieved evidence frozen", source, buildingModel: models[0],
  questions: inputs.length, inputSha256: hash(inputsText), parents: parents.map(p => ({ sample: p.run.sample, files: p.files })),
  retrieval: "Existing dynamic 3+3 / recent2 / stage5 and existing ordinary Top3/Top6 evidence; no rebuilding, embedding, extraction or merge",
  controls: "Same question set, evidence, answer prompt, max output, temperature0, thinking disabled across models. Gold answers and prior predictions are excluded from inputs.json.",
  limitation: "Evaluates how a new model answers from DeepSeek-built memories. Does not evaluate extraction or merging by the new model. New model token counts must be measured anew.",
};
mkdirSync(out, { recursive: true });
for (const [name, contents] of [["inputs.json", inputsText], ["plan.json", JSON.stringify(plan, null, 2)]]) {
  const path = resolve(out, name);
  if (existsSync(path)) assert.equal(readFileSync(path, "utf8"), contents, "Frozen inputs changed; use a new output directory");
  else writeFileSync(path, contents);
}
console.log(JSON.stringify({ out, questions: inputs.length, buildingModel: models[0], inputSha256: plan.inputSha256, cloudCalls: 0 }, null, 2));

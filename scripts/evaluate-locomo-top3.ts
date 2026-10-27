// Predeclared ordinary-RAG sensitivity: same chunks and cached dynamic answers, K=3.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { complete, embed, modelConfig } from "../src/lib/providers";
import { MemoryStore } from "../src/lib/store";
import { retrieveFrom } from "../src/lib/retrieval";
import { chargeUsage, makeSmallPlan, plainChunks, remainingAllows, reserveTokens, type Sample, type TokenAttempt } from "./locomo-small-support";

const base = resolve("artifacts/locomo-plain-rag-max0902-conv48-s2"), out = resolve(base, "ordinary-top3");
const sourceBytes = readFileSync(resolve(base, "report.json")), source = JSON.parse(sourceBytes.toString("utf8"));
const declared = JSON.parse(readFileSync(resolve(base, "top3-plan.json"), "utf8")), cfg = modelConfig();
assert.equal(source.status, "completed"); assert.equal(cfg.llmModel, declared.model); assert.equal(cfg.embeddingModel, source.manifest.embeddingModel);
assert.equal(cfg.space, source.memories[0]?.space, "Embedding space changed");
assert.deepEqual(declared.selectedQuestionIndices, source.manifest.selectedQuestionIndices); assert.equal(declared.ordinaryTopK, 3);
const firstAnswer = source.requests.find((x: { phase: string }) => x.phase.startsWith("evaluate-")); assert.ok(firstAnswer);
// Declaration is independently timestamped and was written only while no answers existed.
assert.ok(declared.declaredAt); assert.ok(declared.sharedTotalTokenCap === 800000);
const dataset: Sample[] = JSON.parse(readFileSync(resolve("artifacts/locomo-data/locomo10.json"), "utf8").replace(/^\uFEFF/, ""));
const sample = dataset.find(s => s.sample_id === source.manifest.sample)!;
const chunks = plainChunks(makeSmallPlan(sample, source.manifest.sessionCount).turns, declared.chunkTargetChars);
const chunkSources = new Map(chunks.map(c => [c.id, c.sourceIds]));
mkdirSync(out, { recursive: true }); mkdirSync(resolve(out, "responses"), { recursive: true });
const manifest = { ...source.manifest, baselineMode: "ordinary-top3", ordinaryRag: { ...source.manifest.ordinaryRag, topK: 3,
  retrieval: "single-pass cosine top-3, no minimum score cutoff, no query expansion, no extraction/merge/reranking" },
  sourceReportSha256: createHash("sha256").update(sourceBytes).digest("hex"), parentReport: "../report.json",
  followupCodeSha256: createHash("sha256").update(readFileSync("scripts/evaluate-locomo-top3.ts")).digest("hex"),
  reuse: "Dynamic answers and ingestion are inherited unchanged. Only ordinary top-3 answers are newly generated. Token accounting includes parent and followup together.",
  declaration: declared };
const reportPath = resolve(out, "report.json");
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : { ...source, manifest, status: "initialized",
  requests: source.requests.map((x: { responseFile?: string }) => ({ ...x, ...(x.responseFile ? { responseFile: `../${x.responseFile}` } : {}) })),
  results: source.results.map((x: { raw?: unknown }) => ({ ...x, raw: undefined })) };
assert.deepEqual(report.manifest, manifest);
assert.ok(!report.requests.some((x: { kind: string; status: string }) => x.kind === "chat" && ["pending", "request_error", "missing_usage"].includes(x.status)), "Unresolved prior request; inspect ledger before rerun");
const save = () => { report.updatedAt = new Date().toISOString(); writeFileSync(reportPath, JSON.stringify(report, null, 2)); };
const spent = () => report.requests.reduce((s: number, r: TokenAttempt) => s + r.chargedTokens, 0);
let halted = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (halted) throw Error("Guard halted requests");
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.pathname.endsWith("/embeddings")) return realFetch(input, init);
  const body = { ...JSON.parse(String(init?.body)), enable_thinking: false, temperature: 0 }, reserve = reserveTokens(body);
  if (!remainingAllows(report.requests, reserve, declared.sharedTotalTokenCap)) { halted = true; throw Error("Shared 800k token cap reached; no request sent"); }
  const metric: TokenAttempt & Record<string, unknown> = { phase: "evaluate-raw-top3", kind: "chat", status: "pending", reserveTokens: reserve, chargedTokens: reserve, ms: 0 };
  const index = report.requests.push(metric) - 1, started = Date.now(); save();
  try {
    const response = await realFetch(input, { ...init, body: JSON.stringify(body) });
    const data = await response.clone().json(); metric.httpStatus = response.status;
    metric.responseFile = `responses/${index}.json`; writeFileSync(resolve(out, String(metric.responseFile)), JSON.stringify(data, null, 2));
    if (!response.ok) { metric.status = `http_${response.status}`; halted = true; }
    else if (!chargeUsage(metric, data.usage || {})) { metric.status = "missing_usage"; halted = true; throw Error("Missing usage; conservative reserve retained"); }
    else { metric.status = "ok"; metric.responseModel = data.model; metric.finishReason = data.choices?.[0]?.finish_reason; }
    return response;
  } catch (e) { if (metric.status === "pending") metric.status = "request_error"; halted = true; throw e; }
  finally { metric.ms = Date.now() - started; save(); }
};

async function main() {
  const store = new MemoryStore(resolve(base, "raw.sqlite"));
  try {
    for (const row of report.results) {
      if (row.raw) continue;
      const started = Date.now(), vector = await embed(row.qa.question);
      const evidence = retrieveFrom(store, source.manifest.sample, cfg.space, vector, "sources", -1,
        { ...source.manifest.policy, firstCandidates: 3, firstLimit: 3 });
      const retrievalMs = Date.now() - started, answerStarted = Date.now();
      try {
        const answer = await complete(source.manifest.answerSystem, [{ role: "user", content: JSON.stringify({ question: row.qa.question, historicalEvidence: evidence.context }) }], 256);
        if (halted) throw Error("Provider/token guard halted evaluation");
        const ids = [...new Set([...evidence.first, ...evidence.second].flatMap(h => h.includedSourceIds || []).flatMap(id => chunkSources.get(id) || []))];
        row.raw = { answer, evidence, retrievalMs, answerMs: Date.now() - answerStarted, provenanceDiaIds: ids,
          provenanceRecall: row.qa.evidence.length ? row.qa.evidence.filter((id: string) => ids.includes(id)).length / row.qa.evidence.length : undefined };
      } catch (e) { row.raw = { error: e instanceof Error ? e.message : "Request failed", evidence, retrievalMs, answerMs: Date.now() - answerStarted }; save(); throw e; }
      save(); console.log(`TOP3 QA ${row.index} ok; SHARED_TOKENS=${spent()}`);
    }
    report.status = "completed"; delete report.error; save(); console.log(`COMPLETE TOP3; SHARED_TOKENS=${spent()}; REPORT=${reportPath}`);
  } catch (e) { report.status = "failed"; report.error = e instanceof Error ? e.message : "Failed"; save(); throw e; }
  finally {
    report.usage = { chargedTokens: spent(), budgetTokens: declared.sharedTotalTokenCap,
      knownInput: report.requests.reduce((n: number, x: TokenAttempt) => n + (x.promptTokens || 0), 0),
      knownOutput: report.requests.reduce((n: number, x: TokenAttempt) => n + (x.completionTokens || 0), 0) };
    save(); globalThis.fetch = realFetch; store.close();
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : "Top-3 comparison failed"); process.exitCode = 1; });

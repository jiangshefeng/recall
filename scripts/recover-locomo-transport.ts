// Explicit recovery of a *stopped* run after transport-only evaluator changes.
// Never changes memory/model/retrieval code or erases an unknown charge.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";

const out = resolve(process.env.LOCOMO_OUT || "");
assert.ok(process.env.LOCOMO_OUT, "Set LOCOMO_OUT to a stopped checkpoint");
const file = resolve(out, "report.json"), original = readFileSync(file, "utf8"), report = JSON.parse(original);
assert.ok(["failed", "completed", "budget_stopped"].includes(report.status), "Run must have stopped before recovery");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const changed: object[] = [];
for (const [path, before] of Object.entries(report.manifest.sourceCode)) {
  const after = hash(readFileSync(path));
  if (before === after) continue;
  assert.equal(path, "scripts/evaluate-locomo-three-arm.ts", "Memory, model and retrieval changes require a fresh database");
  assert.equal(before, process.env.LOCOMO_RECOVER_EVALUATOR_SHA256, "Explicit previous evaluator hash required");
  changed.push({ path, before, after }); report.manifest.sourceCode[path] = after;
}
const resolved: object[] = [];
for (const [index, request] of report.requests.entries()) {
  if (request.kind !== "chat" || !["pending", "missing_usage", "request_error"].includes(request.status)) continue;
  assert.ok(request.responseFile, "Cannot repeat a request without a terminal response");
  const data = JSON.parse(readFileSync(resolve(out, request.responseFile), "utf8"));
  assert.equal(data.status, "failed"); assert.equal(data.error?.code, "gateway_concurrency_limit");
  assert.deepEqual(data.output, []);
  resolved.push({ index, before: request.status, after: "gateway_rejected_reserved", reservation: request.chargedTokens });
  request.status = "gateway_rejected_reserved"; request.errorCode = data.error.code;
}
assert.ok(changed.length || resolved.length, "Nothing to recover");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const archive = `report-before-transport-${stamp}.json`;
assert.ok(!existsSync(resolve(out, archive))); writeFileSync(resolve(out, archive), original, { flag: "wx" });
report.recoveries ??= [];
report.recoveries.push({ at: new Date().toISOString(), archive, changed, resolved,
  reason: "Serial transport and bounded explicit gateway-rejection retry; existing memory/answer semantics and all charge reservations retained. Completed writes, including partial fallbacks, are not repeated." });
report.status = "recovered"; delete report.error;
writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 2)); renameSync(`${file}.tmp`, file);
console.log(JSON.stringify({ out, changed, resolved }, null, 2));

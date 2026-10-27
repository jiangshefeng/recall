import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { modelConfig } from "../src/lib/providers";
import { reserveTokens, chargeUsage, type TokenAttempt } from "./locomo-small-support";

const cfg = modelConfig();
const out = resolve(process.env.LOCOMO_OUT || "artifacts/locomo-deepseek-v4-pro-0813-3plus3");
mkdirSync(out, { recursive: true });
const file = resolve(out, "preflight.json");
if (existsSync(file)) throw Error("Preflight already exists; inspect it rather than repeat a possibly billed request");
const payload = { model: cfg.llmModel, messages: [{ role: "user", content: "Reply only OK." }], max_tokens: 8, enable_thinking: false, temperature: 0 };
const attempt: TokenAttempt = { phase: "campaign-preflight", status: "pending", reserveTokens: reserveTokens(payload), chargedTokens: reserveTokens(payload) };
const save = (extra = {}) => writeFileSync(file, JSON.stringify({ model: cfg.llmModel, attempt, ...extra }, null, 2));
async function main() {
save();
try {
  const response = await fetch(`${cfg.llmBase}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${cfg.llmKey}`, "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(45000) });
  const data = await response.json();
  const known = chargeUsage(attempt, data.usage || {});
  attempt.status = !response.ok ? `http_${response.status}` : !known ? "missing_usage" : data.model !== cfg.llmModel ? "unexpected_model" : "ok";
  save({ response: data });
  console.log(JSON.stringify({ status: attempt.status, responseModel: data.model, usage: data.usage, answer: data.choices?.[0]?.message?.content, error: data.error }, null, 2));
  if (attempt.status !== "ok") process.exitCode = 1;
} catch (error) {
  attempt.status = "request_error";
  save({ error: error instanceof Error ? error.message : "request_error" });
  console.log("Preflight failed; conservative reservation retained");
  process.exitCode = 1;
}
}
void main();

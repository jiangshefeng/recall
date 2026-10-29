import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { modelConfig, publicConfig } from "../src/lib/providers";

// Mem0 OSS sends anonymous usage telemetry by default. Disable it before the
// package is dynamically imported; no user or benchmark data should leave via telemetry.
process.env.MEM0_TELEMETRY = "false";

const out = resolve(process.env.MEM0_PREFLIGHT_OUT || `artifacts/mem0-preflight-${Date.now()}`);
mkdirSync(out, { recursive: true });
const cfg = modelConfig();
if (cfg.mode !== "live" || !publicConfig().ready) throw new Error("Live LLM and embedding configuration is required");
const tokenCap = 50_000;
const openaiRoot = resolve("node_modules/mem0ai/node_modules/openai");
const runtimeUrl = pathToFileURL(resolve(openaiRoot, "_shims/node-runtime.mjs")).href;
let originalFetch: typeof fetch;
const requests: Array<{ kind: string; status: string; inputTokens?: number; outputTokens?: number; ms: number }> = [];
let chargedTokens = 0;
let stopped = false;
const meteredFetch: typeof fetch = async (input, init) => {
  if (stopped) throw new Error("Mem0 smoke-test token guard stopped the request");
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const kind = url.pathname.endsWith("/embeddings") ? "embedding" : "chat";
  const payload = JSON.parse(String(init?.body || "{}"));
  if (kind === "chat") {
    payload.max_tokens = Math.min(Number(payload.max_tokens || 512), 512);
    payload.temperature = 0;
    payload.enable_thinking = false;
    const inputReserve = Buffer.byteLength(JSON.stringify(payload), "utf8") + 1024;
    if (chargedTokens + inputReserve + 512 > tokenCap) {
      stopped = true;
      throw new Error("Mem0 smoke-test reached its 50,000 token pre-request cap");
    }
  }
  const metric = { kind, status: "pending", ms: 0 } as typeof requests[number];
  requests.push(metric);
  const started = Date.now();
  try {
    const response = await originalFetch(input, { ...init, body: JSON.stringify(payload) });
    metric.status = `http_${response.status}`;
    if (kind === "chat" && response.ok) {
      const body = await response.clone().json();
      const usage = body.usage;
      if (!Number.isFinite(usage?.prompt_tokens) || !Number.isFinite(usage?.completion_tokens)) {
        stopped = true;
        throw new Error("Provider omitted usage; stopping to avoid untracked spend");
      }
      metric.inputTokens = usage.prompt_tokens;
      metric.outputTokens = usage.completion_tokens;
      chargedTokens += usage.total_tokens || usage.prompt_tokens + usage.completion_tokens;
      if (chargedTokens > tokenCap) stopped = true;
    }
    if (!response.ok) stopped = true;
    return response;
  } catch (error) {
    metric.status = "error";
    stopped = true;
    throw error;
  } finally {
    metric.ms = Date.now() - started;
    writeFileSync(resolve(out, "requests.json"), JSON.stringify({ tokenCap, chargedTokens, requests }, null, 2));
  }
};
async function main() {
  const { getRuntime } = await import(runtimeUrl);
  const runtime = getRuntime();
  originalFetch = runtime.fetch;
  const shimsUrl = pathToFileURL(resolve(openaiRoot, "_shims/registry.mjs")).href;
  const shims = await import(shimsUrl);
  shims.setShims({ ...runtime, fetch: meteredFetch });
  const { Memory } = await import("mem0ai/oss");
  const memory = new Memory({
    disableHistory: true,
    embedder: { provider: "openai", config: { apiKey: cfg.embeddingKey, baseURL: cfg.embeddingBase, model: cfg.embeddingModel } },
    vectorStore: { provider: "memory", config: { collectionName: "mem0-preflight", dbPath: resolve(out, "mem0.sqlite") } },
    llm: { provider: "openai", config: { apiKey: cfg.llmKey, baseURL: cfg.llmBase, model: cfg.llmModel } },
  });
  const userId = `mem0-preflight-${Date.now()}`;
  await memory.add("I am learning React and want to work as a frontend developer.", { userId });
  if (stopped) throw new Error("Mem0 add hit a provider or token guard");
  const result = await memory.search("What kind of developer role am I interested in?", { filters: { user_id: userId }, topK: 3 });
  if (stopped) throw new Error("Mem0 search hit a provider or token guard");
  const report = { model: cfg.llmModel, embeddingModel: cfg.embeddingModel, vectorStore: "Mem0 OSS local SQLite", telemetry: false,
    chargedTokens, tokenCap, results: result.results, requests };
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(`MEM0 PREFLIGHT OK; chat tokens=${chargedTokens}; requests=${requests.length}; report=${resolve(out, "report.json")}`);
}

main().catch(error => {
  writeFileSync(resolve(out, "error.json"), JSON.stringify({ error: error instanceof Error ? error.message : "Preflight failed", chargedTokens, requests }, null, 2));
  console.error(error instanceof Error ? error.message : "Mem0 preflight failed");
  process.exitCode = 1;
});

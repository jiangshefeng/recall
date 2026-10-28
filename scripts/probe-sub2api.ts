import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSSE } from "../src/lib/sse";

const out = resolve(process.env.RESPONSES_PROBE_OUT || "artifacts/responses-provider-probe");
mkdirSync(out, { recursive: true });
const file = resolve(out, "responses.json");
if (existsSync(file)) throw Error("Probe already recorded; inspect it before repeating any request");
const key = process.env.LLM_API_KEY;
if (!key) throw Error("LLM_API_KEY is missing");
const endpoint = `${(process.env.LLM_BASE_URL || "").replace(/\/$/, "")}/responses`, model = process.env.LLM_MODEL || "";
if (!model || !/^https?:\/\//.test(endpoint)) throw Error("Configure LLM_BASE_URL and LLM_MODEL first");
const result: { endpoint: string; requestedModel: string; status: string; httpStatus?: number; events: unknown[]; usage?: unknown; error?: string } = { endpoint, requestedModel: model, status: "pending", events: [] };
const safe = (text: string) => text.replaceAll(key, "[redacted]");
const save = () => writeFileSync(file, safe(JSON.stringify(result, null, 2)));
async function main() {
  save();
  try {
    const res = await fetch(endpoint, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, instructions: "Reply only OK.", input: [{ role: "user", content: [{ type: "input_text", text: "OK" }] }], max_output_tokens: 64, reasoning: { effort: "low" }, store: false, stream: true }), signal: AbortSignal.timeout(45000) });
    result.httpStatus = res.status;
    if (!res.ok) { result.status = "http_error"; result.error = (await res.text()).slice(0, 3000); }
    else if (!res.body || !res.headers.get("content-type")?.includes("text/event-stream")) { result.status = "unexpected_content_type"; result.error = (await res.text()).slice(0, 3000); }
    else {
      for await (const event of readSSE(res.body)) {
        if (event.data === "[DONE]") continue;
        const data = JSON.parse(event.data); result.events.push(data);
        if (data.response?.usage) result.usage = data.response.usage;
        if (data.type === "response.completed") result.status = "completed";
        if (["response.failed", "response.incomplete", "error"].includes(data.type)) result.status = data.type;
        save();
      }
      if (result.status === "pending") result.status = "missing_terminal_event";
    }
  } catch (e) { result.status = "request_error"; result.error = e instanceof Error ? e.message : "Request failed"; }
  save();
  const terminal: any = result.events.find((e: any) => ["response.completed", "response.incomplete", "response.failed"].includes(e.type));
  console.log(safe(JSON.stringify({ status: result.status, httpStatus: result.httpStatus, requestedModel: model, responseModel: terminal?.response?.model, usage: result.usage, answer: terminal?.response?.output?.filter((o: any) => o.type === "message").flatMap((o: any) => o.content?.filter((c: any) => c.type === "output_text").map((c: any) => c.text)).join(""), error: result.error }, null, 2)));
  if (result.status !== "completed") process.exitCode = 1;
}
void main();

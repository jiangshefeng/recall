import { z } from "zod";
import { answerQuestion, remember, retrieve } from "@/lib/rag";
import { apiError, readBody, scopeSchema } from "@/lib/http";
import { publicConfig } from "@/lib/providers";

export const runtime = "nodejs";
export const maxDuration = 300;
const schema = z.object({
  scope: scopeSchema,
  question: z.string().trim().min(1).max(4000),
  strategy: z.enum(["expand", "sources"]).default("expand"),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(10_000) })).max(6).default([]),
});
export async function POST(req: Request) {
  try {
    const input = await readBody(req, schema);
    const config = publicConfig();
    if (!config.ready) return Response.json({ error: `缺少配置：${config.missing.join("、")}` }, { status: 400 });
    const started = Date.now();
    const evidence = await retrieve(input.scope, input.question, input.strategy);
    const answer = await answerQuestion(input.question, input.history, evidence);
    const memory = await remember(input.scope, input.question, answer, input.history);
    return Response.json({ answer, evidence, memory, elapsedMs: Date.now() - started, mode: config.mode });
  } catch (e) { return apiError(e); }
}

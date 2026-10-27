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
  stream: z.boolean().default(false),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(10_000) })).max(6).default([]),
});
export async function POST(req: Request) {
  try {
    const input = await readBody(req, schema);
    const config = publicConfig();
    if (!config.ready) return Response.json({ error: `缺少配置：${config.missing.join("、")}` }, { status: 400 });
    const started = Date.now();
    if (input.stream) {
      const encoder = new TextEncoder(), abort = new AbortController();
      let disconnected = false, answerComplete = false;
      const signal = AbortSignal.any([req.signal, abort.signal]);
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          function emit(type: string, data: object) {
            if (!disconnected && !signal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`));
          }
          try {
            emit("status", { message: "正在检索相关记忆…" });
            const evidence = await retrieve(input.scope, input.question, input.strategy);
            if (signal.aborted) return;
            emit("evidence", { evidence });
            emit("status", { message: "正在生成回答…" });
            let sentDelta = false;
            const answer = await answerQuestion(input.question, input.history, evidence, text => {
              sentDelta = true; emit("delta", { text });
            }, signal);
            if (signal.aborted) return;
            // Demo responses are deterministic and do not call a streaming model.
            if (!sentDelta) emit("delta", { text: answer });
            answerComplete = true;
            emit("answer", { answer });
            emit("status", { message: "回答已完成，正在整理记忆…" });
            const memory = await remember(input.scope, input.question, answer, input.history);
            emit("done", { memory, elapsedMs: Date.now() - started, mode: config.mode });
          } catch (error) {
            emit("error", { message: error instanceof Error ? error.message : "请求失败", answerComplete });
          } finally { if (!disconnected) controller.close(); }
        },
        cancel() { disconnected = true; abort.abort(); },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
    }
    const evidence = await retrieve(input.scope, input.question, input.strategy);
    const answer = await answerQuestion(input.question, input.history, evidence);
    const memory = await remember(input.scope, input.question, answer, input.history);
    return Response.json({ answer, evidence, memory, elapsedMs: Date.now() - started, mode: config.mode });
  } catch (e) { return apiError(e); }
}

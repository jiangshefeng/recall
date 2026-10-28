import { readSSE } from "./sse";

export type ResponsesMetadata = { finishReason?: string };
export function responsesText(response: any): string {
  return (response.output || []).filter((item: any) => item.type === "message" && item.role === "assistant")
    .flatMap((item: any) => (item.content || []).filter((part: any) => part.type === "output_text").map((part: any) => part.text))
    .join("");
}

// A terminal response is required even after text deltas: interrupted generations
// must never be accepted as completed answers or written back to memory.
export async function readResponses(response: Response, onDelta?: (text: string) => void,
  onMetadata?: (meta: ResponsesMetadata) => void): Promise<string> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
    throw new Error("Responses 接口未返回 SSE 流");
  let terminal: any, deltas = "";
  for await (const event of readSSE(response.body)) {
    if (event.data.trim() === "[DONE]") continue;
    const data = JSON.parse(event.data);
    if (data.type === "error" || data.type === "response.failed") throw new Error("Responses 接口返回生成错误");
    if (data.type === "response.output_text.delta") {
      if (typeof data.delta !== "string") throw new Error("Responses 接口返回无效文本");
      deltas += data.delta; onDelta?.(data.delta);
    }
    if (["response.completed", "response.incomplete"].includes(data.type)) terminal = data.response;
  }
  if (!terminal || !["completed", "incomplete"].includes(terminal.status)) throw new Error("Responses 流未正常结束，未写入记忆");
  const finishReason = terminal.status === "completed" ? "stop"
    : terminal.incomplete_details?.reason === "max_output_tokens" ? "length" : "content_filter";
  onMetadata?.({ finishReason });
  const text = responsesText(terminal);
  if (deltas && text !== deltas) throw new Error("Responses 最终文本与流式文本不一致");
  if (onDelta && terminal.status !== "completed") throw new Error("Responses 回答未完成，未写入记忆");
  if (!text && !onMetadata) throw new Error("Responses 接口没有返回有效文本");
  if (!deltas && text) onDelta?.(text);
  return text;
}

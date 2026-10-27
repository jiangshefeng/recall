import { z } from "zod";

export const scopeSchema = z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N}_-]+$/u, "空间名称只能包含文字、数字、下划线和连字符");
export async function readBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const origin = req.headers.get("origin");
  // Next.js may normalize request.url to localhost; Host retains the browser's address.
  const host = req.headers.get("host") || new URL(req.url).host;
  if (origin && new URL(origin).host !== host) throw new Error("不允许跨站写入");
  const text = await req.text();
  if (text.length > 64_000) throw new Error("请求内容过长");
  return schema.parse(JSON.parse(text));
}
export function apiError(error: unknown) {
  const message = error instanceof z.ZodError ? error.issues.map(x => x.message).join("；")
    : error instanceof SyntaxError ? "请求 JSON 格式错误"
    : error instanceof Error ? error.message : "请求失败";
  return Response.json({ error: message }, { status: error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500 });
}

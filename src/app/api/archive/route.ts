import { z } from "zod";
import { getStore } from "@/lib/store";
import { apiError, scopeSchema } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const scope = scopeSchema.parse(params.get("scope") || "default");
    const id = z.string().min(1).max(100).parse(params.get("stageId"));
    const store = getStore(), stage = store.stage(scope, id);
    if (!stage) return Response.json({ error: "当前空间没有这份阶段摘要" }, { status: 404 });
    return Response.json({ stage, records: store.records(scope, stage.sourceIds) });
  } catch (e) { return apiError(e); }
}

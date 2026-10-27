import { getStore } from "@/lib/store";
import { publicConfig } from "@/lib/providers";
import { apiError, scopeSchema } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    const scope = scopeSchema.parse(new URL(req.url).searchParams.get("scope") || "default");
    const config = publicConfig(), store = getStore();
    const memories = store.memories(scope, config.space).map(({ vector, ...m }) => ({ ...m, dimensions: vector.length }));
    return Response.json({ config, memories, records: store.records(scope), stats: store.stats(scope, config.space) });
  } catch (e) { return apiError(e); }
}

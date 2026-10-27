import { z } from "zod";
import { retrieve } from "@/lib/rag";
import { apiError, readBody, scopeSchema } from "@/lib/http";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    const input = await readBody(req, z.object({ scope: scopeSchema, query: z.string().trim().min(1).max(4000), strategy: z.enum(["expand", "sources"]).default("expand") }));
    return Response.json(await retrieve(input.scope, input.query, input.strategy));
  } catch (e) { return apiError(e); }
}

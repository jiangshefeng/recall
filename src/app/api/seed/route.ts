import { z } from "zod";
import { seedDemo } from "@/lib/rag";
import { apiError, readBody, scopeSchema } from "@/lib/http";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    const { scope } = await readBody(req, z.object({ scope: scopeSchema }));
    await seedDemo(scope);
    return Response.json({ ok: true });
  } catch (e) { return apiError(e); }
}

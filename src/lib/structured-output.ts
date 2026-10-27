import { z } from "zod";

export type OutputDiagnostic = {
  stage: "json" | "schema" | "decision" | "mapping";
  code: string;
  path: string;
  incomingId?: string;
  finishReason?: string;
};

// Only schema paths/codes and known job IDs are retained, never response text.
export class StructuredOutputError extends Error {
  constructor(public diagnostics: OutputDiagnostic[]) {
    super(`模型输出不符合记忆结构（${diagnostics.map(d => `${d.stage}:${d.path}:${d.code}`).join("；")}），原始记录已保留`);
    this.name = "StructuredOutputError";
  }
}

export function schemaDiagnostics(error: z.ZodError, stage: "schema" | "decision", finishReason?: string,
  incomingId?: string): OutputDiagnostic[] {
  return error.issues.map(issue => ({ stage, code: issue.code, path: issue.path.join(".") || "$", incomingId, finishReason }));
}

export function parseStructured<T>(text: string, schema: z.ZodType<T>, finishReason?: string): T {
  let value: unknown;
  try { value = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()); }
  catch { throw new StructuredOutputError([{ stage: "json", code: "invalid_json", path: "$", finishReason }]); }
  const result = schema.safeParse(value);
  if (!result.success) throw new StructuredOutputError(schemaDiagnostics(result.error, "schema", finishReason));
  return result.data;
}

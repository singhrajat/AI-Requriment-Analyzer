import { z } from "zod";

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

// ── Zod schemas ────────────────────────────────────────────────────────────────

export const StageStatusSchema = z.enum(["pending", "running", "done", "error"]);
export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "done",
  "error",
  "needs_human_review",
  "awaiting_user_decision",
]);
export const InputSizeClassSchema = z.enum(["small", "large"]);

export const StagesSchema = z.object({
  fetch: StageStatusSchema,
  dev: StageStatusSchema,
  pm: StageStatusSchema,
  review: StageStatusSchema.optional(),
  merge: StageStatusSchema,
});

export const ReviewOutputEntrySchema = z.object({
  attempt: z.number(),
  output: z.string(),
  createdAt: z.string().optional(),
});

export const MergeSourceSchema = z.enum(["reviewer_approved", "escalated_after_max_retries"]);

export const BrsRunSchema = z
  .object({
    _id: z.string(),
    status: RunStatusSchema,
    inputSizeClass: InputSizeClassSchema.optional(),
    chunkCount: z.number().optional(),
    chunkMergeStatus: z.enum(["ok", "error"]).optional(),
    chunkMergeError: z.string().optional(),
    stages: StagesSchema,
    fetchOutput: z.string().optional(),
    devOutput: z.string().optional(),
    pmOutput: z.string().optional(),
    mergedReport: z.string().optional(),
    mergeSource: MergeSourceSchema.optional(),
    awaitingUserDecision: z.boolean().optional(),
    review_outputs: z.array(ReviewOutputEntrySchema).optional(),
    error: z.string().optional(),
    displayName: z.string().optional(),
    originalFileName: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    completedAt: z.string().optional(),
  })
  .passthrough();

export const StatsSchema = z.object({
  total: z.number(),
  inPipeline: z.number(),
  reportsReady: z.number(),
  avgDuration: z.number(),
});

export const RunsResponseSchema = z.object({
  runs: z.array(BrsRunSchema),
  stats: StatsSchema,
});

export const SubmitResponseSchema = z.object({
  runId: z.string(),
});

export const RunDecisionResponseSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
});

export const RunControlResponseSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
});

// ── Types ──────────────────────────────────────────────────────────────────────

export type BrsRun = z.infer<typeof BrsRunSchema>;
export type Stats = z.infer<typeof StatsSchema>;
export type RunsResponse = z.infer<typeof RunsResponseSchema>;
export type StageStatus = z.infer<typeof StageStatusSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type MergeSource = z.infer<typeof MergeSourceSchema>;

// ── Helpers ────────────────────────────────────────────────────────────────────

async function safeFetch<T>(url: string, schema: z.ZodType<T>, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  const json = await res.json();
  return schema.parse(json);
}

// ── API functions ──────────────────────────────────────────────────────────────

export async function submitBrs(file: File, displayName?: string): Promise<{ runId: string }> {
  const form = new FormData();
  form.append("file", file);
  if (typeof displayName === "string" && displayName.trim().length > 0) {
    form.append("displayName", displayName.trim());
  }
  return safeFetch(`${BASE_URL}/api/brs/submit`, SubmitResponseSchema, {
    method: "POST",
    body: form,
  });
}

export async function getRuns(): Promise<RunsResponse> {
  return safeFetch(`${BASE_URL}/api/brs/runs`, RunsResponseSchema);
}

export async function getRun(id: string): Promise<BrsRun> {
  return safeFetch(`${BASE_URL}/api/brs/runs/${id}`, BrsRunSchema);
}

export async function postRunDecision(
  id: string,
  action: "save" | "discard"
): Promise<{ ok: boolean; status: string }> {
  return safeFetch(`${BASE_URL}/api/brs/runs/${encodeURIComponent(id)}/decision`, RunDecisionResponseSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

export function runExportDocxUrl(id: string): string {
  const enc = encodeURIComponent(id);
  return `${BASE_URL}/api/brs/runs/${enc}/export.docx`;
}

export async function downloadRunDocx(id: string): Promise<void> {
  const res = await fetch(runExportDocxUrl(id));
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Export failed (${res.status}): ${body}`);
  }
  const disposition = res.headers.get("Content-Disposition");
  let filename = `brs-${id}.docx`;
  const match = disposition?.match(/filename="([^"]+)"/);
  if (match?.[1]) filename = match[1];
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function deleteRun(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/brs/runs/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
}

export async function postRunControl(
  id: string,
  action: "stop" | "resume"
): Promise<{ ok: boolean; status: string }> {
  return safeFetch(`${BASE_URL}/api/brs/runs/${encodeURIComponent(id)}/control`, RunControlResponseSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

import { z } from "zod";

const blockingIssueObject = z.object({
  problem: z.string().catch(""),
  agent: z.enum(["developer", "pm", "both"]).catch("both"),
  required_fix: z.string().optional(),
});

/** Accept legacy string entries from the model; coerce to both agents. */
export const blockingIssueSchema = z.union([
  blockingIssueObject,
  z.string().transform((s) => ({
    problem: s,
    agent: "both" as const,
    required_fix: "",
  })),
]);

export const reviewerSummarySchema = z.object({
  dev_confidence: z.coerce.number(),
  pm_confidence: z.coerce.number(),
  overall_system_confidence: z.coerce.number(),
  ready_for_merge: z.coerce.boolean(),
  blocking_issues: z.array(blockingIssueSchema).default([]),
  top_3_critical_suggestions: z.array(z.unknown()).optional(),
});

export const brsReviewerOutputSchema = z
  .object({
    summary: reviewerSummarySchema.passthrough(),
    developer_agent_review: z
      .object({
        suggestions: z
          .array(
            z.object({
              priority: z.string().optional(),
              section: z.string().optional(),
              requirement: z.string().optional(),
              issue: z.string().optional(),
              suggestion: z.string().optional(),
            })
          )
          .optional(),
      })
      .optional(),
    pm_agent_review: z
      .object({
        suggestions: z
          .array(
            z.object({
              priority: z.string().optional(),
              section: z.string().optional(),
              requirement: z.string().optional(),
              issue: z.string().optional(),
              suggestion: z.string().optional(),
            })
          )
          .optional(),
      })
      .optional(),
  })
  .passthrough();

export type ParsedBrsReview = z.infer<typeof brsReviewerOutputSchema>;
export type ParsedBlockingIssue = z.infer<typeof blockingIssueSchema>;

export function normalizeBlockingIssue(
  issue: ParsedBlockingIssue
): { problem: string; agent: "developer" | "pm" | "both"; required_fix: string } {
  if (typeof issue === "string") {
    return { problem: issue, agent: "both", required_fix: "" };
  }
  return {
    problem: issue.problem,
    agent: issue.agent,
    required_fix: issue.required_fix ?? "",
  };
}

export function agentsToRerunFromBlocking(
  issues: ParsedBlockingIssue[]
): { dev: boolean; pm: boolean } {
  let dev = false;
  let pm = false;
  for (const raw of issues) {
    const n = normalizeBlockingIssue(raw);
    if (n.agent === "developer" || n.agent === "both") dev = true;
    if (n.agent === "pm" || n.agent === "both") pm = true;
  }
  if (!dev && !pm) {
    return { dev: true, pm: true };
  }
  return { dev, pm };
}

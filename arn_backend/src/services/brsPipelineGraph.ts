import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { createHash } from "node:crypto";
import type { LangfuseTraceClient } from "langfuse";
import { BrsPipelineRun } from "../models/BrsPipelineRun";
import {
  getChatModelForRole,
  getChatModelIdForRole,
  getChatModelTelemetryForRole,
  getLangfuse,
  getOpenAIEmbeddings,
  getOpenAiEmbeddingModelId,
  getReviewerChatModel,
  getReviewerModelTelemetry,
} from "../config/modelConfig";
import { splitBrsDocumentTextSectionWise } from "./brsRecursiveChunk";
import { brsPointId, upsertBrsVectors } from "./qdrantBrsStore";
import { embedMergeReportForRun } from "./mergeReportRagChunks";
import {
  FETCH_AGENT_PROMPT,
  CHUNK_MERGE_PROMPT,
  DEV_CHECKLIST_PROMPT,
  PM_CHECKLIST_PROMPT,
  MERGE_PROMPT,
  REVIEWER_AGENT_PROMPT,
} from "../prompts/brsPipelinePrompts";
import {
  agentsToRerunFromBlocking,
  brsReviewerOutputSchema,
  normalizeBlockingIssue,
  type ParsedBrsReview,
} from "../schemas/brsReviewerOutput";
import { formatJsonLikeOutput } from "../utils/parseJsonLikeOutput";
import { emitBrsRunChanged } from "./brsRunEvents";

// ── State ──────────────────────────────────────────────────────────────────────

const PipelineState = Annotation.Root({
  runId: Annotation<string>({ reducer: (_prev, next) => next }),
  documentText: Annotation<string>({ reducer: (_prev, next) => next }),
  halted: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  inputSizeClass: Annotation<"small" | "large" | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  chunkCount: Annotation<number | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  fetchResult: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  devOutput: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  pmOutput: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  mergedReport: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  correctivesDev: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "{}",
  }),
  correctivesPm: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "{}",
  }),
  rerunsAfterBlock: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  reviewPassCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  lastParsedReview: Annotation<ParsedBrsReview | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  lastReviewerRaw: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  escalatedMergeRequest: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  error: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
});

type PipelineStateType = typeof PipelineState.State;

// ── Helpers ────────────────────────────────────────────────────────────────────

async function updateRun(runId: string, fields: Record<string, unknown>) {
  await BrsPipelineRun.findByIdAndUpdate(runId, { $set: fields });
  emitBrsRunChanged(runId, Object.keys(fields));
}

type OpenAiCompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

function pickFiniteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function absorbOpenAiUsageFromLangChainResult(result: unknown, sink: OpenAiCompletionUsage): void {
  if (!result || typeof result !== "object") return;
  const o = result as Record<string, unknown>;

  const um = o.usage_metadata as Record<string, unknown> | undefined;
  if (um) {
    const pi = pickFiniteNumber(um.input_tokens) ?? pickFiniteNumber(um.prompt_tokens);
    const po = pickFiniteNumber(um.output_tokens) ?? pickFiniteNumber(um.completion_tokens);
    const tt = pickFiniteNumber(um.total_tokens);
    if (pi !== undefined) sink.prompt_tokens = pi;
    if (po !== undefined) sink.completion_tokens = po;
    if (tt !== undefined) sink.total_tokens = tt;
  }

  const rm = o.response_metadata as Record<string, unknown> | undefined;
  const tu = rm?.token_usage as Record<string, unknown> | undefined;
  if (tu) {
    const pi = pickFiniteNumber(tu.prompt_tokens) ?? pickFiniteNumber(tu.input_tokens);
    const po = pickFiniteNumber(tu.completion_tokens) ?? pickFiniteNumber(tu.output_tokens);
    const tt = pickFiniteNumber(tu.total_tokens);
    if (pi !== undefined) sink.prompt_tokens = pi;
    if (po !== undefined) sink.completion_tokens = po;
    if (tt !== undefined) sink.total_tokens = tt;
  }

  if (
    sink.total_tokens === undefined &&
    sink.prompt_tokens !== undefined &&
    sink.completion_tokens !== undefined
  ) {
    sink.total_tokens = sink.prompt_tokens + sink.completion_tokens;
  }
}

function openAiUsageToLangfuseDetails(
  sink: OpenAiCompletionUsage
): Record<string, number> | undefined {
  const { prompt_tokens: pt, completion_tokens: ct, total_tokens: tt } = sink;
  if (pt === undefined && ct === undefined && tt === undefined) return undefined;
  const out: Record<string, number> = {};
  if (pt !== undefined) out.prompt_tokens = pt;
  if (ct !== undefined) out.completion_tokens = ct;
  if (tt !== undefined) out.total_tokens = tt;
  else if (pt !== undefined && ct !== undefined) out.total_tokens = pt + ct;
  return Object.keys(out).length ? out : undefined;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function getOrCreatePipelineTrace(runId: string) {
  const langfuse = getLangfuse();
  const run = await BrsPipelineRun.findById(runId).select("langfuseTraceId langfuseHost").lean();
  const reviewerTelem = getReviewerModelTelemetry();
  const modelRouting = {
    default: getChatModelIdForRole("default"),
    fetch: getChatModelIdForRole("fetch"),
    dev: getChatModelIdForRole("dev"),
    pm: getChatModelIdForRole("pm"),
    reviewer: reviewerTelem.modelName,
  };

  if (run?.langfuseTraceId) {
    return langfuse.trace({
      id: run.langfuseTraceId,
      name: "brs-pipeline",
      metadata: { runId, modelRouting },
    });
  }

  const trace = langfuse.trace({
    name: "brs-pipeline",
    metadata: { runId, modelRouting },
  });

  // Persist correlation so subsequent nodes reuse this same trace.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const traceId = (trace as any).id as string | undefined;
  if (traceId) {
    await updateRun(runId, {
      langfuseTraceId: traceId,
      ...(process.env.LANGFUSE_HOST ? { langfuseHost: process.env.LANGFUSE_HOST } : {}),
    });
  }

  return trace;
}

async function isStopRequested(runId: string): Promise<boolean> {
  const run = await BrsPipelineRun.findById(runId).select("status control.stopRequestedAt").lean();
  return !!run?.control?.stopRequestedAt || run?.status === "paused";
}

async function pauseRun(runId: string): Promise<void> {
  // Flip to paused and clear any "running" stage markers back to pending so resume can re-run safely.
  const run = await BrsPipelineRun.findById(runId).lean();
  if (!run) return;
  if (run.status === "done" || run.status === "error" || run.status === "needs_human_review" || run.status === "awaiting_user_decision") {
    return;
  }
  const nextStages: Record<string, unknown> = {};
  const stages = run.stages ?? {};
  for (const key of ["fetch", "dev", "pm", "review", "merge"] as const) {
    const current = (stages as any)[key];
    if (current === "running") {
      nextStages[`stages.${key}`] = "pending";
    }
  }
  await updateRun(runId, {
    status: "paused",
    "control.pausedAt": new Date(),
    ...nextStages,
  });
}

async function stopIfRequested(runId: string): Promise<boolean> {
  if (!(await isStopRequested(runId))) return false;
  await pauseRun(runId);
  return true;
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

async function callModel(args: {
  trace: LangfuseTraceClient;
  role: "default" | "fetch" | "dev" | "pm";
  step: string;
  prompt: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const { trace, role, step, prompt, metadata } = args;
  const model = getChatModelForRole(role);
  const telem = getChatModelTelemetryForRole(role);

  // Keep a lightweight audit trail in logs (Langfuse tracing already captures spans + generations).
  console.info(`[brsPipelineGraph] role=${role} model=${getChatModelIdForRole(role)}`);

  const usage: OpenAiCompletionUsage = {};
  const generation = trace.generation({
    name: step,
    model: telem.modelName,
    modelParameters: {
      temperature: telem.temperature,
      max_tokens: telem.maxTokens,
    },
    input: undefined,
    metadata: {
      role,
      promptChars: prompt.length,
      promptSha256: sha256Hex(prompt),
      ...(metadata ?? {}),
    },
  });

  let response: unknown;
  try {
    response = await model.invoke([new HumanMessage(prompt)]);
    absorbOpenAiUsageFromLangChainResult(response, usage);
  } finally {
    const text =
      response && typeof response === "object" && "content" in (response as any)
        ? (response as any).content
        : "";
    const contentStr =
      typeof text === "string" ? text : JSON.stringify(text ?? "");
    generation.end({
      output: {
        outputChars: contentStr.length,
        outputSha256: sha256Hex(contentStr),
      },
      usageDetails: openAiUsageToLangfuseDetails(usage),
    });
  }

  const content =
    response && typeof response === "object" && "content" in (response as any)
      ? (response as any).content
      : "";
  return typeof content === "string" ? content : JSON.stringify(content);
}

async function callReviewerModel(args: {
  trace: LangfuseTraceClient;
  step: string;
  prompt: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const { trace, step, prompt, metadata } = args;
  const model = getReviewerChatModel();
  const telem = getReviewerModelTelemetry();
  const usage: OpenAiCompletionUsage = {};
  const generation = trace.generation({
    name: step,
    model: telem.modelName,
    modelParameters: {
      temperature: telem.temperature,
      max_tokens: telem.maxTokens,
    },
    input: undefined,
    metadata: {
      role: "reviewer",
      promptChars: prompt.length,
      promptSha256: sha256Hex(prompt),
      ...(metadata ?? {}),
    },
  });

  let response: unknown;
  try {
    response = await model.invoke([new HumanMessage(prompt)]);
    absorbOpenAiUsageFromLangChainResult(response, usage);
  } finally {
    const text =
      response && typeof response === "object" && "content" in (response as any)
        ? (response as any).content
        : "";
    const contentStr =
      typeof text === "string" ? text : JSON.stringify(text ?? "");
    generation.end({
      output: {
        outputChars: contentStr.length,
        outputSha256: sha256Hex(contentStr),
      },
      usageDetails: openAiUsageToLangfuseDetails(usage),
    });
  }

  const content =
    response && typeof response === "object" && "content" in (response as any)
      ? (response as any).content
      : "";
  return typeof content === "string" ? content : JSON.stringify(content);
}

function safeParseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  const raw = fenced ? fenced[1] : text;
  return JSON.parse(raw.trim());
}

function parseReviewerOutput(raw: string): ParsedBrsReview {
  const obj = safeParseJson(raw);
  return brsReviewerOutputSchema.parse(obj);
}

function buildCorrectivesForDev(review: ParsedBrsReview): string {
  const blocking = review.summary.blocking_issues
    .map(normalizeBlockingIssue)
    .filter((b) => b.agent === "developer" || b.agent === "both");
  const payload = {
    blocking_issues: blocking,
    suggestions: review.developer_agent_review?.suggestions ?? [],
  };
  return JSON.stringify(payload);
}

function buildCorrectivesForPm(review: ParsedBrsReview): string {
  const blocking = review.summary.blocking_issues
    .map(normalizeBlockingIssue)
    .filter((b) => b.agent === "pm" || b.agent === "both");
  const payload = {
    blocking_issues: blocking,
    suggestions: review.pm_agent_review?.suggestions ?? [],
  };
  return JSON.stringify(payload);
}

// ── Nodes ──────────────────────────────────────────────────────────────────────

async function embedAndMeasure(state: PipelineStateType): Promise<Partial<PipelineStateType>> {
  const langfuse = getLangfuse();
  const trace = await getOrCreatePipelineTrace(state.runId);
  trace.update({
    metadata: {
      runId: state.runId,
      documentChars: state.documentText.length,
      documentSha256: sha256Hex(state.documentText),
    },
  });
  const span = trace.span({
    name: "embedAndMeasure",
    input: {
      runId: state.runId,
      documentChars: state.documentText.length,
      documentSha256: sha256Hex(state.documentText),
    },
  });

  try {
    if (await stopIfRequested(state.runId)) {
      span.end({ output: { paused: true } });
      return { halted: true };
    }

    const existing = await BrsPipelineRun.findById(state.runId)
      .select("documentText inputSizeClass chunkCount embeddings.brs")
      .lean();
    if (existing?.documentText && existing?.inputSizeClass) {
      span.end({
        output: {
          reused: true,
          inputSizeClass: existing.inputSizeClass,
          chunkCount: existing.chunkCount,
          documentText: existing.documentText,
        },
      });
      return {
        inputSizeClass: existing.inputSizeClass as any,
        chunkCount: existing.chunkCount as any,
      };
    }

    await updateRun(state.runId, { status: "running", "stages.fetch": "running" });

    /** All runs: section-wise + recursive chunking only (no single-vector brs_full path). */
    const inputSizeClass: "small" | "large" = "large";
    let chunks = await splitBrsDocumentTextSectionWise(state.documentText);
    if (chunks.length === 0) {
      const trimmed = state.documentText.trim();
      chunks = trimmed ? [{ text: trimmed, index: 0 }] : [{ text: "(empty document)", index: 0 }];
    }
    const chunkCount = chunks.length;

    const embedModel = getOpenAiEmbeddingModelId();
    await updateRun(state.runId, { inputSizeClass, chunkCount, documentText: state.documentText });
    trace.update({
      metadata: {
        inputSizeClass,
        chunkCount,
        brsEmbeddingModel: embedModel,
      },
    });

    const meta = await BrsPipelineRun.findById(state.runId).select("displayName originalFileName").lean();
    const sourceName = meta?.displayName || meta?.originalFileName || state.runId;

    try {
      const embeddings = getOpenAIEmbeddings();
      const texts = chunks.map((c) => c.text);
      const vectors = await embeddings.embedDocuments(texts);

      const points = chunks.map((c, i) => ({
        id: brsPointId(state.runId, "brs_chunk", c.index),
        vector: vectors[i]!,
        payload: {
          runId: state.runId,
          sourceName,
          kind: "brs_chunk" as const,
          chunkIndex: c.index,
          text: c.text,
          sectionNumber: c.sectionNumber,
          sectionTitle: c.sectionTitle,
          headingPath: c.headingPath,
          partIndex: c.partIndex,
          partCount: c.partCount,
        },
      }));

      await upsertBrsVectors(points);

      await updateRun(state.runId, {
        "embeddings.brs": {
          provider: "openai",
          model: embedModel,
          strategy: "chunked",
          createdAt: new Date(),
        },
      });

      span.end({
        output: {
          inputSizeClass,
          chunkCount,
          brsEmbedding: {
            strategy: "chunked",
            chunks: chunks.length,
            dims: vectors[0]?.length ?? 0,
          },
        },
      });
    } catch (err) {
      console.error(`OpenAI/Qdrant embedding failed for run ${state.runId}:`, err);
      span.end({
        output: {
          inputSizeClass,
          chunkCount,
          brsEmbeddingError: err instanceof Error ? err.message : String(err),
        },
      });
    }

    return { inputSizeClass, chunkCount };
  } finally {
    await langfuse.flushAsync();
  }
}

function routeAfterEmbed(state: PipelineStateType): "chunkAndFetch" | "end" {
  if (state.halted) return "end";
  return "chunkAndFetch";
}

async function chunkAndFetch(state: PipelineStateType): Promise<Partial<PipelineStateType>> {
  const langfuse = getLangfuse();
  const trace = await getOrCreatePipelineTrace(state.runId);

  try {
    if (await stopIfRequested(state.runId)) {
      const span = trace.span({ name: "chunkAndFetch", input: { pausedCheck: true } });
      span.end({ output: { paused: true } });
      return { halted: true };
    }

    const run = await BrsPipelineRun.findById(state.runId).select("stages.fetch fetchOutput documentText").lean();
    if (run?.stages?.fetch === "done" && typeof run.fetchOutput === "string" && run.fetchOutput.length > 0) {
      const span = trace.span({
        name: "chunkAndFetch",
        input: { reusedFromPersistence: true, documentText: state.documentText },
      });
      span.end({ output: { fetchOutput: run.fetchOutput } });
      return { fetchResult: run.fetchOutput };
    }

    let chunks = await splitBrsDocumentTextSectionWise(state.documentText);
    if (chunks.length === 0) {
      const trimmed = state.documentText.trim();
      chunks = trimmed ? [{ text: trimmed, index: 0 }] : [{ text: "(empty document)", index: 0 }];
    }
    const chunkPrompts = chunks.map((c) =>
      interpolate(FETCH_AGENT_PROMPT, { documentText: c.text })
    );

    // Sequential so a stop request can be honored between chunks.
    const chunkResults: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (await stopIfRequested(state.runId)) {
        const span = trace.span({
          name: "chunkAndFetch",
          input: {
            documentChars: state.documentText.length,
            documentSha256: sha256Hex(state.documentText),
            chunkCount: chunks.length,
            completedChunkIndex: i,
          },
        });
        span.end({
          output: {
            paused: true,
            chunkCount: chunks.length,
            completed: chunkResults.length,
            completedChunkResults: chunkResults.length,
          },
        });
        return { halted: true };
      }
      chunkResults.push(
        await callModel({
          trace,
          role: "fetch",
          step: "fetch_chunk",
          prompt: chunkPrompts[i]!,
          metadata: { chunkIndex: chunks[i]!.index },
        })
      );
    }

    const mergePrompt = interpolate(CHUNK_MERGE_PROMPT, {
      chunkResults: JSON.stringify(
        chunkResults.map((r) => {
          try {
            return safeParseJson(r);
          } catch {
            return r;
          }
        })
      ),
    });

    let mergedFetch: string;
    const span = trace.span({
      name: "chunkAndFetch",
      input: {
        documentChars: state.documentText.length,
        documentSha256: sha256Hex(state.documentText),
        chunkCount: chunks.length,
        mergePromptChars: mergePrompt.length,
        mergePromptSha256: sha256Hex(mergePrompt),
      },
    });
    try {
      mergedFetch = await callModel({
        trace,
        role: "fetch",
        step: "fetch_merge",
        prompt: mergePrompt,
        metadata: { chunkCount: chunks.length },
      });
      await updateRun(state.runId, {
        "stages.fetch": "done",
        chunkMergeStatus: "ok",
        fetchOutput: mergedFetch,
      });
    } catch (err) {
      mergedFetch = chunkResults.join("\n\n---\n\n");
      await updateRun(state.runId, {
        "stages.fetch": "done",
        chunkMergeStatus: "error",
        chunkMergeError: err instanceof Error ? err.message : String(err),
        fetchOutput: mergedFetch,
      });
    }

    span.end({
      output: {
        chunkCount: chunks.length,
        chunkResultsCount: chunkResults.length,
        fetchOutputChars: mergedFetch.length,
        fetchOutputSha256: sha256Hex(mergedFetch),
      },
    });
    return { fetchResult: mergedFetch };
  } finally {
    await langfuse.flushAsync();
  }
}

async function devAgent(state: PipelineStateType): Promise<Partial<PipelineStateType>> {
  const langfuse = getLangfuse();
  const trace = await getOrCreatePipelineTrace(state.runId);

  try {
    if (await stopIfRequested(state.runId)) {
      const span = trace.span({ name: "devAgent", input: { pausedCheck: true } });
      span.end({ output: { paused: true } });
      return { halted: true };
    }

    const run = await BrsPipelineRun.findById(state.runId).select("stages.dev devOutput").lean();
    if (run?.stages?.dev === "done" && typeof run.devOutput === "string" && run.devOutput.length > 0) {
      const span = trace.span({
        name: "devAgent",
        input: { reusedFromPersistence: true, fetchResult: state.fetchResult, documentText: state.documentText },
      });
      span.end({ output: { devOutput: run.devOutput } });
      return { devOutput: run.devOutput };
    }

    await updateRun(state.runId, { "stages.dev": "running" });

    const prompt = interpolate(DEV_CHECKLIST_PROMPT, {
      FETCH_AGENT_JSON_OUTPUT: state.fetchResult ?? state.documentText,
      REVIEWER_CORRECTIVES: state.correctivesDev ?? "{}",
    });
    const span = trace.span({
      name: "devAgent",
      input: { promptChars: prompt.length, promptSha256: sha256Hex(prompt) },
    });
    const result = await callModel({
      trace,
      role: "dev",
      step: "dev_agent",
      prompt,
    });

    await updateRun(state.runId, { "stages.dev": "done", devOutput: result });
    span.end({
      output: { devOutputChars: result.length, devOutputSha256: sha256Hex(result) },
    });
    return { devOutput: result };
  } finally {
    await langfuse.flushAsync();
  }
}

async function pmAgent(state: PipelineStateType): Promise<Partial<PipelineStateType>> {
  const langfuse = getLangfuse();
  const trace = await getOrCreatePipelineTrace(state.runId);

  try {
    if (await stopIfRequested(state.runId)) {
      const span = trace.span({ name: "pmAgent", input: { pausedCheck: true } });
      span.end({ output: { paused: true } });
      return { halted: true };
    }

    const run = await BrsPipelineRun.findById(state.runId).select("stages.pm pmOutput").lean();
    if (run?.stages?.pm === "done" && typeof run.pmOutput === "string" && run.pmOutput.length > 0) {
      const span = trace.span({
        name: "pmAgent",
        input: { reusedFromPersistence: true, fetchResult: state.fetchResult, documentText: state.documentText },
      });
      span.end({ output: { pmOutput: run.pmOutput } });
      return { pmOutput: run.pmOutput };
    }

    await updateRun(state.runId, { "stages.pm": "running" });

    const prompt = interpolate(PM_CHECKLIST_PROMPT, {
      FETCH_AGENT_JSON_OUTPUT: state.fetchResult ?? state.documentText,
      REVIEWER_CORRECTIVES: state.correctivesPm ?? "{}",
    });
    const span = trace.span({
      name: "pmAgent",
      input: { promptChars: prompt.length, promptSha256: sha256Hex(prompt) },
    });
    const result = await callModel({
      trace,
      role: "pm",
      step: "pm_agent",
      prompt,
    });

    await updateRun(state.runId, { "stages.pm": "done", pmOutput: result });
    span.end({ output: { pmOutputChars: result.length, pmOutputSha256: sha256Hex(result) } });
    return { pmOutput: result };
  } finally {
    await langfuse.flushAsync();
  }
}

async function reviewerAgent(state: PipelineStateType): Promise<Partial<PipelineStateType>> {
  const langfuse = getLangfuse();
  const fetchJson = state.fetchResult ?? "";
  const devJson = state.devOutput ?? "{}";
  const pmJson = state.pmOutput ?? "{}";
  const trace = await getOrCreatePipelineTrace(state.runId);
  const prompt = interpolate(REVIEWER_AGENT_PROMPT, {
    FETCH_AGENT_JSON: fetchJson,
    DEV_AGENT_JSON: devJson,
    PM_AGENT_JSON: pmJson,
  });
  const span = trace.span({
    name: "reviewerAgent",
    input: { promptChars: prompt.length, promptSha256: sha256Hex(prompt) },
  });

  try {
    if (await stopIfRequested(state.runId)) {
      span.end({ output: { paused: true } });
      return { halted: true };
    }

    await updateRun(state.runId, { "stages.review": "running" });

    const raw = await callReviewerModel({
      trace,
      step: "reviewer_agent",
      prompt,
    });
    const parsed = parseReviewerOutput(raw);
    const pass = (state.reviewPassCount ?? 0) + 1;

    await BrsPipelineRun.findByIdAndUpdate(state.runId, {
      $set: { "stages.review": "done" },
      $push: {
        review_outputs: {
          attempt: pass,
          output: raw,
          createdAt: new Date(),
        },
      },
    });

    const ready = parsed.summary.ready_for_merge;
    const escalated =
      !ready && (state.rerunsAfterBlock ?? 0) >= 2;

    span.end({
      output: {
        ready_for_merge: ready,
        escalatedMergeRequest: escalated,
        reviewPass: pass,
        dev_confidence: parsed.summary.dev_confidence,
        pm_confidence: parsed.summary.pm_confidence,
        overall_system_confidence: parsed.summary.overall_system_confidence,
        blockingIssueCount: parsed.summary.blocking_issues?.length ?? 0,
      },
    });

    trace.update({
      metadata: {
        reviewPassCount: pass,
        rerunsAfterBlock: state.rerunsAfterBlock ?? 0,
        ready_for_merge: ready,
        escalatedMergeRequest: escalated,
        dev_confidence: parsed.summary.dev_confidence,
        pm_confidence: parsed.summary.pm_confidence,
        overall_system_confidence: parsed.summary.overall_system_confidence,
      },
    });

    return {
      lastParsedReview: parsed,
      lastReviewerRaw: raw,
      reviewPassCount: pass,
      escalatedMergeRequest: escalated,
    };
  } finally {
    await langfuse.flushAsync();
  }
}

function routeAfterReviewer(
  state: PipelineStateType
): "merge" | "selectiveRerun" | "end" {
  if (state.halted) return "end";
  const ready = state.lastParsedReview?.summary.ready_for_merge ?? false;
  if (ready) {
    return "merge";
  }
  if ((state.rerunsAfterBlock ?? 0) < 2) {
    return "selectiveRerun";
  }
  return "merge";
}

async function selectiveRerun(state: PipelineStateType): Promise<Partial<PipelineStateType>> {
  const langfuse = getLangfuse();
  const trace = await getOrCreatePipelineTrace(state.runId);

  try {
    if (await stopIfRequested(state.runId)) {
      const span = trace.span({ name: "selectiveRerun", input: { pausedCheck: true } });
      span.end({ output: { paused: true } });
      return { halted: true };
    }

    const review = state.lastParsedReview;
    if (!review) {
      const span = trace.span({ name: "selectiveRerun", input: { note: "missing_lastParsedReview" } });
      span.end({ output: { error: "no_review" } });
      return { rerunsAfterBlock: (state.rerunsAfterBlock ?? 0) + 1 };
    }

    const { dev, pm } = agentsToRerunFromBlocking(review.summary.blocking_issues);
    const correctivesDevStr = buildCorrectivesForDev(review);
    const correctivesPmStr = buildCorrectivesForPm(review);

    const nextReruns = (state.rerunsAfterBlock ?? 0) + 1;
    trace.update({ metadata: { rerunsAfterBlock: nextReruns } });

    const devPrompt = dev
      ? interpolate(DEV_CHECKLIST_PROMPT, {
          FETCH_AGENT_JSON_OUTPUT: state.fetchResult ?? state.documentText,
          REVIEWER_CORRECTIVES: correctivesDevStr,
        })
      : undefined;
    const pmPrompt = pm
      ? interpolate(PM_CHECKLIST_PROMPT, {
          FETCH_AGENT_JSON_OUTPUT: state.fetchResult ?? state.documentText,
          REVIEWER_CORRECTIVES: correctivesPmStr,
        })
      : undefined;

    const span = trace.span({
      name: "selectiveRerun",
      input: {
        devRerun: dev,
        pmRerun: pm,
        correctivesDevChars: correctivesDevStr.length,
        correctivesDevSha256: sha256Hex(correctivesDevStr),
        correctivesPmChars: correctivesPmStr.length,
        correctivesPmSha256: sha256Hex(correctivesPmStr),
        devPromptChars: devPrompt?.length ?? 0,
        pmPromptChars: pmPrompt?.length ?? 0,
      },
    });

    const tasks: Promise<void>[] = [];
    if (dev && devPrompt) {
      tasks.push(
        (async () => {
          await updateRun(state.runId, { "stages.dev": "running" });
          const result = await callModel({
            trace,
            role: "dev",
            step: "dev_agent_rerun",
            prompt: devPrompt,
            metadata: { rerunAttempt: nextReruns },
          });
          await updateRun(state.runId, { "stages.dev": "done", devOutput: result });
        })()
      );
    }
    if (pm && pmPrompt) {
      tasks.push(
        (async () => {
          await updateRun(state.runId, { "stages.pm": "running" });
          const result = await callModel({
            trace,
            role: "pm",
            step: "pm_agent_rerun",
            prompt: pmPrompt,
            metadata: { rerunAttempt: nextReruns },
          });
          await updateRun(state.runId, { "stages.pm": "done", pmOutput: result });
        })()
      );
    }

    await Promise.all(tasks);

    const run = await BrsPipelineRun.findById(state.runId).lean();

    span.end({
      output: {
        nextReruns,
        dev,
        pm,
        devOutput: run?.devOutput ?? state.devOutput,
        pmOutput: run?.pmOutput ?? state.pmOutput,
      },
    });
    return {
      rerunsAfterBlock: nextReruns,
      correctivesDev: "{}",
      correctivesPm: "{}",
      devOutput: run?.devOutput ?? state.devOutput,
      pmOutput: run?.pmOutput ?? state.pmOutput,
    };
  } finally {
    await langfuse.flushAsync();
  }
}

async function mergeAgents(state: PipelineStateType): Promise<Partial<PipelineStateType>> {
  const langfuse = getLangfuse();
  const trace = await getOrCreatePipelineTrace(state.runId);

  try {
    if (await stopIfRequested(state.runId)) {
      const span = trace.span({ name: "mergeAgents", input: { pausedCheck: true } });
      span.end({ output: { paused: true } });
      return { halted: true };
    }

    const existing = await BrsPipelineRun.findById(state.runId).select("stages.merge mergedReport status").lean();
    if (existing?.stages?.merge === "done" && typeof existing.mergedReport === "string" && existing.mergedReport.length > 0) {
      const span = trace.span({ name: "mergeAgents", input: { reusedFromPersistence: true } });
      span.end({ output: { mergedReport: existing.mergedReport } });
      return { mergedReport: existing.mergedReport };
    }

    await updateRun(state.runId, { "stages.merge": "running" });

    const prompt = interpolate(MERGE_PROMPT, {
      devChecklist: state.devOutput ?? "{}",
      pmChecklist: state.pmOutput ?? "{}",
    });
    const span = trace.span({
      name: "mergeAgents",
      input: { promptChars: prompt.length, promptSha256: sha256Hex(prompt) },
    });
    const result = await callModel({
      trace,
      role: "default",
      step: "merge_agent",
      prompt,
    });
    const mergedReportText = formatJsonLikeOutput(result);

    const escalated = state.escalatedMergeRequest === true;
    trace.update({
      metadata: {
        mergeEscalated: escalated,
        mergeSource: escalated ? "escalated_after_max_retries" : "reviewer_approved",
      },
    });

    // Persist merged report first, then attempt embedding (embedding failure must not fail the pipeline).
    if (escalated) {
      await updateRun(state.runId, {
        "stages.merge": "done",
        mergedReport: mergedReportText,
        mergeSource: "escalated_after_max_retries",
        status: "awaiting_user_decision",
        awaitingUserDecision: true,
      });
    } else {
      await updateRun(state.runId, {
        "stages.merge": "done",
        mergedReport: mergedReportText,
        mergeSource: "reviewer_approved",
        status: "done",
        completedAt: new Date(),
        awaitingUserDecision: false,
      });
    }

    // Index the merged report into the dedicated `merge_report` Qdrant collection on the
    // non-escalated path. Escalated runs wait for the user's Save decision; see decisionRoute.
    if (!escalated) {
      try {
        await embedMergeReportForRun(state.runId);
      } catch (embedErr) {
        // Embedding must never fail the pipeline; embedMergeReportForRun already logs internally.
        console.error(`[mergeAgents] merge embed failed for run ${state.runId}:`, embedErr);
      }
    }

    span.end({
      output: {
        mergedReportChars: mergedReportText.length,
        mergedReportSha256: sha256Hex(mergedReportText),
        escalated,
      },
    });
    return { mergedReport: mergedReportText };
  } finally {
    await langfuse.flushAsync();
  }
}

// ── Graph ──────────────────────────────────────────────────────────────────────

const graph = new StateGraph(PipelineState)
  .addNode("embedAndMeasure", embedAndMeasure)
  .addNode("chunkAndFetch", chunkAndFetch)
  .addNode("devAgent", devAgent)
  .addNode("pmAgent", pmAgent)
  .addNode("reviewerAgent", reviewerAgent)
  .addNode("selectiveRerun", selectiveRerun)
  .addNode("mergeAgents", mergeAgents)
  .addEdge(START, "embedAndMeasure")
  .addConditionalEdges("embedAndMeasure", routeAfterEmbed, {
    end: END,
    chunkAndFetch: "chunkAndFetch",
  })
  .addEdge("chunkAndFetch", "devAgent")
  .addEdge("chunkAndFetch", "pmAgent")
  .addEdge("devAgent", "reviewerAgent")
  .addEdge("pmAgent", "reviewerAgent")
  .addConditionalEdges("reviewerAgent", routeAfterReviewer, {
    end: END,
    merge: "mergeAgents",
    selectiveRerun: "selectiveRerun",
  })
  .addEdge("selectiveRerun", "reviewerAgent")
  .addEdge("mergeAgents", END);

const compiledGraph = graph.compile();

// ── Entry point ────────────────────────────────────────────────────────────────

/**
 * Launch the BRS pipeline asynchronously (fire-and-forget).
 * Updates the Mongo run document as each stage completes.
 */
export async function launchBrsPipeline(runId: string, documentText: string): Promise<void> {
  compiledGraph
    .invoke({ runId, documentText })
    .catch(async (err: Error) => {
      console.error(`Pipeline error for run ${runId}:`, err);
      await BrsPipelineRun.findByIdAndUpdate(runId, {
        $set: { status: "error", error: err.message },
      });
    });
}

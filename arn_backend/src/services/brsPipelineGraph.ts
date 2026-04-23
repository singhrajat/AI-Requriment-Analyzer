import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { BrsPipelineRun } from "../models/BrsPipelineRun";
import { getChatModelForRole, getChatModelIdForRole, getLangfuse, getReviewerChatModel } from "../config/modelConfig";
import { isSmallInput } from "./tokenCounter";
import { chunkDocumentText } from "./chunkDocumentText";
import { embedText, embedTexts } from "./voyageEmbeddings";
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

async function callModel(role: "default" | "fetch" | "dev" | "pm", prompt: string): Promise<string> {
  const model = getChatModelForRole(role);
  // Keep a lightweight audit trail in logs (Langfuse tracing already captures spans).
  console.info(`[brsPipelineGraph] role=${role} model=${getChatModelIdForRole(role)}`);
  const response = await model.invoke([new HumanMessage(prompt)]);
  return typeof response.content === "string"
    ? response.content
    : JSON.stringify(response.content);
}

async function callReviewerModel(prompt: string): Promise<string> {
  const model = getReviewerChatModel();
  const response = await model.invoke([new HumanMessage(prompt)]);
  return typeof response.content === "string"
    ? response.content
    : JSON.stringify(response.content);
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
  const trace = langfuse.trace({ name: "brs-pipeline", input: { runId: state.runId } });
  const span = trace.span({ name: "embedAndMeasure" });

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
        },
      });
      return {
        inputSizeClass: existing.inputSizeClass as any,
        chunkCount: existing.chunkCount as any,
      };
    }

    await updateRun(state.runId, { status: "running", "stages.fetch": "running" });

    const small = isSmallInput(state.documentText);
    const inputSizeClass: "small" | "large" = small ? "small" : "large";
    const chunks = small ? [] : chunkDocumentText(state.documentText);
    const chunkCount = small ? 0 : chunks.length;

    await updateRun(state.runId, { inputSizeClass, chunkCount, documentText: state.documentText });

    try {
      if (small) {
        const vector = await embedText(state.documentText, { inputType: "document" });
        await updateRun(state.runId, {
          "embeddings.brs": {
            provider: "voyage",
            model: "voyage-3.5-lite",
            strategy: "single",
            vector,
            createdAt: new Date(),
          },
        });
        span.end({
          output: {
            inputSizeClass,
            chunkCount,
            brsEmbedding: { strategy: "single", dims: vector.length },
          },
        });
      } else {
        const texts = chunks.map((c) => c.text);
        const BATCH = 64;
        const vectors: number[][] = [];
        for (let i = 0; i < texts.length; i += BATCH) {
          const batch = texts.slice(i, i + BATCH);
          const batchVectors = await embedTexts(batch, { inputType: "document" });
          vectors.push(...batchVectors);
        }

        const chunkEmbeddings = chunks.map((c, i) => ({
          index: i,
          charStart: c.charStart,
          charEnd: c.charEnd,
          vector: vectors[i],
        }));

        await updateRun(state.runId, {
          "embeddings.brs": {
            provider: "voyage",
            model: "voyage-3.5-lite",
            strategy: "chunked",
            chunks: chunkEmbeddings,
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
      }
    } catch (err) {
      console.error(`Voyage embedding failed for run ${state.runId}:`, err);
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

function routeBySize(state: PipelineStateType): "fetchSmall" | "chunkAndFetch" | "end" {
  if (state.halted) return "end";
  return state.inputSizeClass === "small" ? "fetchSmall" : "chunkAndFetch";
}

async function fetchSmall(state: PipelineStateType): Promise<Partial<PipelineStateType>> {
  const langfuse = getLangfuse();
  const trace = langfuse.trace({ name: "brs-pipeline", input: { runId: state.runId } });
  const span = trace.span({ name: "fetchSmall" });

  try {
    if (await stopIfRequested(state.runId)) {
      span.end({ output: { paused: true } });
      return { halted: true };
    }

    const run = await BrsPipelineRun.findById(state.runId).select("stages.fetch fetchOutput documentText").lean();
    if (run?.stages?.fetch === "done" && typeof run.fetchOutput === "string" && run.fetchOutput.length > 0) {
      span.end({ output: { reused: true, length: run.fetchOutput.length } });
      return { fetchResult: run.fetchOutput };
    }

    const prompt = interpolate(FETCH_AGENT_PROMPT, { documentText: state.documentText });
    const result = await callModel("fetch", prompt);

    await updateRun(state.runId, {
      "stages.fetch": "done",
      fetchOutput: result,
    });
    span.end({ output: { length: result.length } });
    return { fetchResult: result };
  } finally {
    await langfuse.flushAsync();
  }
}

async function chunkAndFetch(state: PipelineStateType): Promise<Partial<PipelineStateType>> {
  const langfuse = getLangfuse();
  const trace = langfuse.trace({ name: "brs-pipeline", input: { runId: state.runId } });
  const span = trace.span({ name: "chunkAndFetch" });

  try {
    if (await stopIfRequested(state.runId)) {
      span.end({ output: { paused: true } });
      return { halted: true };
    }

    const run = await BrsPipelineRun.findById(state.runId).select("stages.fetch fetchOutput documentText").lean();
    if (run?.stages?.fetch === "done" && typeof run.fetchOutput === "string" && run.fetchOutput.length > 0) {
      span.end({ output: { reused: true, length: run.fetchOutput.length } });
      return { fetchResult: run.fetchOutput };
    }

    const chunks = chunkDocumentText(state.documentText);

    // Sequential so a stop request can be honored between chunks.
    const chunkResults: string[] = [];
    for (const chunk of chunks) {
      if (await stopIfRequested(state.runId)) {
        span.end({ output: { paused: true, chunkCount: chunks.length, completed: chunkResults.length } });
        return { halted: true };
      }
      const prompt = interpolate(FETCH_AGENT_PROMPT, { documentText: chunk.text });
      chunkResults.push(await callModel("fetch", prompt));
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
    try {
      mergedFetch = await callModel("fetch", mergePrompt);
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

    span.end({ output: { chunkCount: chunks.length } });
    return { fetchResult: mergedFetch };
  } finally {
    await langfuse.flushAsync();
  }
}

async function devAgent(state: PipelineStateType): Promise<Partial<PipelineStateType>> {
  const langfuse = getLangfuse();
  const trace = langfuse.trace({ name: "brs-pipeline", input: { runId: state.runId } });
  const span = trace.span({ name: "devAgent" });

  try {
    if (await stopIfRequested(state.runId)) {
      span.end({ output: { paused: true } });
      return { halted: true };
    }

    const run = await BrsPipelineRun.findById(state.runId).select("stages.dev devOutput").lean();
    if (run?.stages?.dev === "done" && typeof run.devOutput === "string" && run.devOutput.length > 0) {
      span.end({ output: { reused: true, length: run.devOutput.length } });
      return { devOutput: run.devOutput };
    }

    await updateRun(state.runId, { "stages.dev": "running" });

    const prompt = interpolate(DEV_CHECKLIST_PROMPT, {
      FETCH_AGENT_JSON_OUTPUT: state.fetchResult ?? state.documentText,
      REVIEWER_CORRECTIVES: state.correctivesDev ?? "{}",
    });
    const result = await callModel("dev", prompt);

    await updateRun(state.runId, { "stages.dev": "done", devOutput: result });
    span.end({ output: { length: result.length } });
    return { devOutput: result };
  } finally {
    await langfuse.flushAsync();
  }
}

async function pmAgent(state: PipelineStateType): Promise<Partial<PipelineStateType>> {
  const langfuse = getLangfuse();
  const trace = langfuse.trace({ name: "brs-pipeline", input: { runId: state.runId } });
  const span = trace.span({ name: "pmAgent" });

  try {
    if (await stopIfRequested(state.runId)) {
      span.end({ output: { paused: true } });
      return { halted: true };
    }

    const run = await BrsPipelineRun.findById(state.runId).select("stages.pm pmOutput").lean();
    if (run?.stages?.pm === "done" && typeof run.pmOutput === "string" && run.pmOutput.length > 0) {
      span.end({ output: { reused: true, length: run.pmOutput.length } });
      return { pmOutput: run.pmOutput };
    }

    await updateRun(state.runId, { "stages.pm": "running" });

    const prompt = interpolate(PM_CHECKLIST_PROMPT, {
      FETCH_AGENT_JSON_OUTPUT: state.fetchResult ?? state.documentText,
      REVIEWER_CORRECTIVES: state.correctivesPm ?? "{}",
    });
    const result = await callModel("pm", prompt);

    await updateRun(state.runId, { "stages.pm": "done", pmOutput: result });
    span.end({ output: { length: result.length } });
    return { pmOutput: result };
  } finally {
    await langfuse.flushAsync();
  }
}

async function reviewerAgent(state: PipelineStateType): Promise<Partial<PipelineStateType>> {
  const langfuse = getLangfuse();
  const trace = langfuse.trace({ name: "brs-pipeline", input: { runId: state.runId } });
  const span = trace.span({ name: "reviewerAgent" });

  try {
    if (await stopIfRequested(state.runId)) {
      span.end({ output: { paused: true } });
      return { halted: true };
    }

    await updateRun(state.runId, { "stages.review": "running" });

    const fetchJson = state.fetchResult ?? "";
    const devJson = state.devOutput ?? "{}";
    const pmJson = state.pmOutput ?? "{}";

    const prompt = interpolate(REVIEWER_AGENT_PROMPT, {
      FETCH_AGENT_JSON: fetchJson,
      DEV_AGENT_JSON: devJson,
      PM_AGENT_JSON: pmJson,
    });

    const raw = await callReviewerModel(prompt);
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
  const trace = langfuse.trace({ name: "brs-pipeline", input: { runId: state.runId } });
  const span = trace.span({ name: "selectiveRerun" });

  try {
    if (await stopIfRequested(state.runId)) {
      span.end({ output: { paused: true } });
      return { halted: true };
    }

    const review = state.lastParsedReview;
    if (!review) {
      span.end({ output: { error: "no_review" } });
      return { rerunsAfterBlock: (state.rerunsAfterBlock ?? 0) + 1 };
    }

    const { dev, pm } = agentsToRerunFromBlocking(review.summary.blocking_issues);
    const correctivesDevStr = buildCorrectivesForDev(review);
    const correctivesPmStr = buildCorrectivesForPm(review);

    const nextReruns = (state.rerunsAfterBlock ?? 0) + 1;

    const tasks: Promise<void>[] = [];
    if (dev) {
      tasks.push(
        (async () => {
          await updateRun(state.runId, { "stages.dev": "running" });
          const prompt = interpolate(DEV_CHECKLIST_PROMPT, {
            FETCH_AGENT_JSON_OUTPUT: state.fetchResult ?? state.documentText,
            REVIEWER_CORRECTIVES: correctivesDevStr,
          });
          const result = await callModel("dev", prompt);
          await updateRun(state.runId, { "stages.dev": "done", devOutput: result });
        })()
      );
    }
    if (pm) {
      tasks.push(
        (async () => {
          await updateRun(state.runId, { "stages.pm": "running" });
          const prompt = interpolate(PM_CHECKLIST_PROMPT, {
            FETCH_AGENT_JSON_OUTPUT: state.fetchResult ?? state.documentText,
            REVIEWER_CORRECTIVES: correctivesPmStr,
          });
          const result = await callModel("pm", prompt);
          await updateRun(state.runId, { "stages.pm": "done", pmOutput: result });
        })()
      );
    }

    await Promise.all(tasks);

    const run = await BrsPipelineRun.findById(state.runId).lean();

    span.end({ output: { nextReruns, dev, pm } });
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
  const trace = langfuse.trace({ name: "brs-pipeline", input: { runId: state.runId } });
  const span = trace.span({ name: "mergeAgents" });

  try {
    if (await stopIfRequested(state.runId)) {
      span.end({ output: { paused: true } });
      return { halted: true };
    }

    const existing = await BrsPipelineRun.findById(state.runId).select("stages.merge mergedReport status").lean();
    if (existing?.stages?.merge === "done" && typeof existing.mergedReport === "string" && existing.mergedReport.length > 0) {
      span.end({ output: { reused: true, length: existing.mergedReport.length } });
      return { mergedReport: existing.mergedReport };
    }

    await updateRun(state.runId, { "stages.merge": "running" });

    const prompt = interpolate(MERGE_PROMPT, {
      devChecklist: state.devOutput ?? "{}",
      pmChecklist: state.pmOutput ?? "{}",
    });
    const result = await callModel("default", prompt);

    const escalated = state.escalatedMergeRequest === true;

    // Persist merged report first, then attempt embedding (embedding failure must not fail the pipeline).
    if (escalated) {
      await updateRun(state.runId, {
        "stages.merge": "done",
        mergedReport: result,
        mergeSource: "escalated_after_max_retries",
        status: "awaiting_user_decision",
        awaitingUserDecision: true,
      });
    } else {
      await updateRun(state.runId, {
        "stages.merge": "done",
        mergedReport: result,
        mergeSource: "reviewer_approved",
        status: "done",
        completedAt: new Date(),
        awaitingUserDecision: false,
      });
    }

    try {
      const vector = await embedText(result, { inputType: "document" });
      await updateRun(state.runId, {
        "embeddings.mergedReport": {
          provider: "voyage",
          model: "voyage-3.5-lite",
          vector,
          createdAt: new Date(),
        },
      });
      span.end({ output: { length: result.length, escalated, mergedReportEmbeddingDims: vector.length } });
    } catch (err) {
      console.error(`Voyage embedding failed (mergedReport) for run ${state.runId}:`, err);
      span.end({
        output: {
          length: result.length,
          escalated,
          mergedReportEmbeddingError: err instanceof Error ? err.message : String(err),
        },
      });
    }
    return { mergedReport: result };
  } finally {
    await langfuse.flushAsync();
  }
}

// ── Graph ──────────────────────────────────────────────────────────────────────

const graph = new StateGraph(PipelineState)
  .addNode("embedAndMeasure", embedAndMeasure)
  .addNode("fetchSmall", fetchSmall)
  .addNode("chunkAndFetch", chunkAndFetch)
  .addNode("devAgent", devAgent)
  .addNode("pmAgent", pmAgent)
  .addNode("reviewerAgent", reviewerAgent)
  .addNode("selectiveRerun", selectiveRerun)
  .addNode("mergeAgents", mergeAgents)
  .addEdge(START, "embedAndMeasure")
  .addConditionalEdges("embedAndMeasure", routeBySize, {
    end: END,
    fetchSmall: "fetchSmall",
    chunkAndFetch: "chunkAndFetch",
  })
  .addEdge("fetchSmall", "devAgent")
  .addEdge("fetchSmall", "pmAgent")
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

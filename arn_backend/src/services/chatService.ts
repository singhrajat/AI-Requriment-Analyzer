import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import type { LangfuseTraceClient } from "langfuse";
import {
  BaseLLM,
  BaseRetriever,
  getResponseSynthesizer,
  TextNode,
  type ChatMessage,
  type ChatResponse,
  type ChatResponseChunk,
  type EngineResponse,
  type LLMChatParamsNonStreaming,
  type LLMChatParamsStreaming,
  type LLMMetadata,
  type NodeWithScore,
  type QueryBundle,
} from "llamaindex";
import {
  getChatModel,
  getChatModelDirect,
  getChatModelTelemetryForRoute,
  getLangfuse,
  getOpenAIEmbeddings,
} from "../config/modelConfig";
import {
  buildAugmentedUserQuery,
  CHAT_DIRECT_SMALLTALK_SYSTEM,
  CHAT_NO_INDEXED_DOCS_SYSTEM,
} from "../prompts/chatPrompts";
import { shouldAnswerChatWithoutRag } from "../utils/chatGreetingGate";
import { searchBrsSimilar } from "./qdrantBrsStore";

const DEFAULT_TOP_K = 5;

export type ChatCitation = {
  runId: string;
  sourceName: string;
  kind: "brs_chunk" | "brs_full" | "merged_report";
  chunkIndex?: number;
  /** Merge-only: dotted section path (e.g. `developerAnalysis.security`). */
  sectionPath?: string;
  /** Merge-only: 1-based part index when a section was split into multiple parts. */
  partIndex?: number;
  /** Merge-only: total number of parts for the section. */
  partCount?: number;
  score?: number;
};

export type ChatStreamEvent =
  | { type: "token"; token: string }
  | { type: "sources"; sources: ChatCitation[] };

function queryBundleToString(bundle: QueryBundle): string {
  const q = bundle.query;
  if (typeof q === "string") return q;
  if (Array.isArray(q)) {
    return q
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n\n");
  }
  return String(q);
}

function messageContentToString(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n\n");
  }
  return String(content);
}

function toLangChainMessages(messages: ChatMessage[]): BaseMessage[] {
  return messages.map((m) => {
    const text = messageContentToString(m.content);
    switch (m.role) {
      case "system":
        return new SystemMessage(text);
      case "assistant":
        return new AIMessage(text);
      default:
        return new HumanMessage(text);
    }
  });
}

function chunkContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "object" && part !== null && "text" in part) {
          return String((part as { text?: string }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

/** OpenAI chat completion usage; merged from streamed chunks for Langfuse `usageDetails`. */
type OpenAiCompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

function pickFiniteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Merge token usage from a LangChain / OpenAI stream chunk (last chunk often carries full usage). */
function absorbOpenAiUsageFromChunk(chunk: unknown, sink: OpenAiCompletionUsage): void {
  if (!chunk || typeof chunk !== "object") return;
  const o = chunk as Record<string, unknown>;

  const um = o.usage_metadata as Record<string, unknown> | undefined;
  if (um) {
    const pi =
      pickFiniteNumber(um.input_tokens) ??
      pickFiniteNumber(um.prompt_tokens);
    const po =
      pickFiniteNumber(um.output_tokens) ??
      pickFiniteNumber(um.completion_tokens);
    const tt = pickFiniteNumber(um.total_tokens);
    if (pi !== undefined) sink.prompt_tokens = pi;
    if (po !== undefined) sink.completion_tokens = po;
    if (tt !== undefined) sink.total_tokens = tt;
  }

  const rm = o.response_metadata as Record<string, unknown> | undefined;
  const tu = rm?.token_usage as Record<string, unknown> | undefined;
  if (tu) {
    const pi =
      pickFiniteNumber(tu.prompt_tokens) ?? pickFiniteNumber(tu.input_tokens);
    const po =
      pickFiniteNumber(tu.completion_tokens) ?? pickFiniteNumber(tu.output_tokens);
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

/** Maps to Langfuse OpenAI-style usage for cost calculation in the UI. */
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

/**
 * Bridges LangChain ChatOpenAI to LlamaIndex's LLM interface for {@link getResponseSynthesizer}.
 * When `usageAccumulator` is set, stream/invoke calls merge OpenAI token usage for Langfuse.
 */
class LangChainOpenAILlamaIndexLLM extends BaseLLM {
  constructor(
    private readonly lc: ChatOpenAI,
    private readonly meta: LLMMetadata,
    private readonly usageAccumulator?: OpenAiCompletionUsage
  ) {
    super();
  }

  get metadata(): LLMMetadata {
    return this.meta;
  }

  async chat(
    params: LLMChatParamsStreaming<object, object>
  ): Promise<AsyncIterable<ChatResponseChunk<object>>>;
  async chat(params: LLMChatParamsNonStreaming<object, object>): Promise<ChatResponse<object>>;
  async chat(
    params: LLMChatParamsStreaming<object, object> | LLMChatParamsNonStreaming<object, object>
  ): Promise<ChatResponse<object> | AsyncIterable<ChatResponseChunk<object>>> {
    const lcMessages = toLangChainMessages(params.messages);
    if (params.stream) {
      const stream = await this.lc.stream(lcMessages);
      const acc = this.usageAccumulator;
      async function* gen(): AsyncIterable<ChatResponseChunk<object>> {
        for await (const chunk of stream) {
          if (acc) {
            absorbOpenAiUsageFromChunk(chunk, acc);
          }
          const delta = chunkContentToString(chunk.content);
          if (delta) {
            yield { raw: null, delta };
          }
        }
      }
      return gen();
    }
    const res = await this.lc.invoke(lcMessages);
    if (this.usageAccumulator) {
      absorbOpenAiUsageFromChunk(res, this.usageAccumulator);
    }
    return {
      message: {
        role: "assistant",
        content: chunkContentToString(res.content),
      },
      raw: null,
    };
  }
}

class QdrantBrsRetriever extends BaseRetriever {
  constructor(
    private readonly topK: number,
    private readonly langfuseTrace?: LangfuseTraceClient,
    /** Optional Mongo run id; when set, restricts hits to that run in each queried collection. */
    private readonly runId?: string,
    /** When true, search merge-report Qdrant collection as well as BRS (both still scoped by runId when set). */
    private readonly includeMergeReportInRag?: boolean
  ) {
    super();
  }

  async _retrieve(queryBundle: QueryBundle): Promise<NodeWithScore[]> {
    const queryText = queryBundleToString(queryBundle);
    const span = this.langfuseTrace?.span({
      name: "retrieve",
      input: {
        query: queryText,
        runId: this.runId,
        includeMergeReportInRag: Boolean(this.includeMergeReportInRag),
      },
    });
    try {
      const out = await this.retrieveFromQdrant(queryBundle);
      span?.end({
        output: {
          nodeCount: out.length,
          nodes: out.map((n) => ({
            score: n.score,
            text: String((n.node as TextNode).text ?? ""),
            metadata: (n.node as TextNode).metadata,
          })),
        },
      });
      return out;
    } catch (err) {
      span?.end({
        output: { error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }

  private async retrieveFromQdrant(queryBundle: QueryBundle): Promise<NodeWithScore[]> {
    const queryText = queryBundleToString(queryBundle).trim();
    if (!queryText) return [];

    const emb = getOpenAIEmbeddings();
    const queryVector = await emb.embedQuery(queryText);
    if (!queryVector.length) return [];

    try {
      const hits = await searchBrsSimilar(queryVector, this.topK, {
        ...(this.runId ? { runId: this.runId } : {}),
        includeMergeReport: this.includeMergeReportInRag === true,
      });
      return hits.map((h) => ({
        node: new TextNode({
          text: h.payload.text,
          metadata: {
            runId: h.payload.runId,
            sourceName: h.payload.sourceName,
            kind: h.payload.kind,
            ...(h.payload.chunkIndex !== undefined ? { chunkIndex: h.payload.chunkIndex } : {}),
            ...(h.payload.sectionPath !== undefined ? { sectionPath: h.payload.sectionPath } : {}),
            ...(h.payload.partIndex !== undefined ? { partIndex: h.payload.partIndex } : {}),
            ...(h.payload.partCount !== undefined ? { partCount: h.payload.partCount } : {}),
          },
        }),
        score: h.score,
      }));
    } catch (err) {
      console.error("[chat] Qdrant retrieve failed:", err);
      return [];
    }
  }
}

async function* streamEngineResponse(stream: AsyncIterable<EngineResponse>): AsyncGenerator<string> {
  for await (const chunk of stream) {
    const d = chunk.delta;
    if (d) yield d;
  }
}

export type ChatHistoryItem = {
  role: "user" | "assistant" | "system";
  content: string;
};

function citationsFromNodes(nodes: NodeWithScore[]): ChatCitation[] {
  const seen = new Set<string>();
  const out: ChatCitation[] = [];
  for (const n of nodes) {
    // Guardrail: if storage returns an empty text payload, treat it as "not found"
    // so the UI does not surface a clickable BRS/source that has no content.
    const nodeText = String((n.node as TextNode).text ?? "").trim();
    if (!nodeText) continue;

    const meta = (n.node as TextNode).metadata as Partial<{
      runId: string;
      sourceName: string;
      kind: "brs_chunk" | "brs_full" | "merge_report";
      chunkIndex?: number;
      sectionPath?: string;
      partIndex?: number;
      partCount?: number;
    }>;
    const runId = meta.runId ? String(meta.runId) : "";
    const sourceName = meta.sourceName ? String(meta.sourceName) : runId;
    const rawKind = meta.kind;
    if (!runId || !sourceName || !rawKind) continue;

    // Normalize storage kind ("merge_report") to the public citation kind ("merged_report").
    const citationKind: ChatCitation["kind"] =
      rawKind === "merge_report" ? "merged_report" : rawKind;

    const key =
      citationKind === "merged_report"
        ? `${runId}::${citationKind}::${meta.sectionPath ?? ""}::${meta.partIndex ?? ""}`
        : `${runId}::${citationKind}::${meta.chunkIndex ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      runId,
      sourceName,
      kind: citationKind,
      chunkIndex: typeof meta.chunkIndex === "number" ? meta.chunkIndex : undefined,
      sectionPath: typeof meta.sectionPath === "string" ? meta.sectionPath : undefined,
      partIndex: typeof meta.partIndex === "number" ? meta.partIndex : undefined,
      partCount: typeof meta.partCount === "number" ? meta.partCount : undefined,
      score: typeof n.score === "number" ? n.score : undefined,
    });
  }
  return out;
}

/**
 * RAG path: LlamaIndex {@link RetrieverQueryEngine} + OpenAI query embedding + Qdrant similarity search.
 *
 * By default only the BRS collection is searched. When `includeMergeReportInRag` is true, the merge-report
 * collection is searched as well; both respect optional `runId` filtering.
 */
export async function* streamRagChat(params: {
  message: string;
  history: ChatHistoryItem[];
  runId?: string;
  /** When true (requires runId), retrieval includes merge-report vectors for that run. */
  includeMergeReportInRag?: boolean;
}): AsyncGenerator<ChatStreamEvent> {
  const historyForModel = params.history.slice(-24);

  if (shouldAnswerChatWithoutRag(params.message)) {
    const langfuse = getLangfuse();
    const telem = getChatModelTelemetryForRoute("direct");
    const trace = langfuse.trace({
      name: "chat",
      input: {
        mode: "direct",
        message: params.message,
        history: historyForModel,
      },
      metadata: {
        chatRoute: "direct",
        chosenModel: telem.modelName,
      },
    });

    try {
      const lc = getChatModelDirect();
      const usageSink: OpenAiCompletionUsage = {};
      const generation = trace.generation({
        name: "chat_completion",
        model: telem.modelName,
        modelParameters: {
          temperature: telem.temperature,
          max_tokens: telem.maxTokens,
        },
        input: {
          system: CHAT_DIRECT_SMALLTALK_SYSTEM,
          userMessage: params.message,
        },
        metadata: { chatRoute: "direct", chosenModel: telem.modelName },
      });
      let assistantDirect = "";
      let completionStarted = false;
      try {
        const stream = await lc.stream([
          new SystemMessage(CHAT_DIRECT_SMALLTALK_SYSTEM),
          new HumanMessage(params.message),
        ]);
        for await (const chunk of stream) {
          absorbOpenAiUsageFromChunk(chunk, usageSink);
          const delta = chunkContentToString(chunk.content);
          if (delta) {
            if (!completionStarted) {
              generation.update({
                completionStartTime: new Date(),
              });
              completionStarted = true;
            }
            assistantDirect += delta;
            yield { type: "token", token: delta };
          }
        }
      } finally {
        generation.end({
          output: {
            assistantMessage: assistantDirect,
            mode: "direct",
          },
          usageDetails: openAiUsageToLangfuseDetails(usageSink),
        });
      }
      yield { type: "sources", sources: [] };
      trace.update({
        output: {
          done: true,
          mode: "direct",
          assistantMessage: assistantDirect,
          sources: [],
          chosenModel: telem.modelName,
        },
      });
      return;
    } catch (err) {
      trace.update({
        output: { error: err instanceof Error ? err.message : "unknown" },
      });
      throw err;
    } finally {
      await langfuse.flushAsync();
    }
  }

  const augmented = buildAugmentedUserQuery({
    message: params.message,
    history: params.history,
    useRagPrefix: true,
  });
  const ragTelem = getChatModelTelemetryForRoute("rag");
  const langfuse = getLangfuse();
  const trace = langfuse.trace({
    name: "chat",
    input: {
      mode: "rag",
      message: params.message,
      history: historyForModel,
      augmentedQuery: augmented,
      runId: params.runId,
      includeMergeReportInRag: Boolean(params.includeMergeReportInRag),
    },
    metadata: {
      chatRoute: "rag",
      chosenSynthesisModel: ragTelem.modelName,
      ...(params.runId ? { runId: params.runId } : {}),
      includeMergeReportInRag: Boolean(params.includeMergeReportInRag),
    },
  });

  try {
    const retriever = new QdrantBrsRetriever(
      DEFAULT_TOP_K,
      trace,
      params.runId,
      params.includeMergeReportInRag
    );
    const nodes = await retriever.retrieve({ query: augmented });
    const citations = citationsFromNodes(nodes);

    const lc = getChatModel();
    const telem = getChatModelTelemetryForRoute("rag");
    const ragLlmUsage: OpenAiCompletionUsage = {};
    const llmAdapter = new LangChainOpenAILlamaIndexLLM(
      lc,
      {
        model: telem.modelName,
        temperature: telem.temperature,
        topP: .7,
        maxTokens: telem.maxTokens,
        contextWindow: 128000,
        tokenizer: undefined,
        structuredOutput: false,
      },
      ragLlmUsage
    );

    if (nodes.length === 0) {
      const usageSink: OpenAiCompletionUsage = {};
      const generation = trace.generation({
        name: "chat_completion",
        model: telem.modelName,
        modelParameters: {
          temperature: telem.temperature,
          max_tokens: telem.maxTokens,
        },
        input: {
          system: CHAT_NO_INDEXED_DOCS_SYSTEM,
          userMessage: params.message,
        },
        metadata: { chatRoute: "rag_empty", chosenModel: telem.modelName },
      });
      let assistantNoIndex = "";
      let completionStarted = false;
      try {
        const stream = await lc.stream([
          new SystemMessage(CHAT_NO_INDEXED_DOCS_SYSTEM),
          new HumanMessage(params.message),
        ]);
        for await (const chunk of stream) {
          absorbOpenAiUsageFromChunk(chunk, usageSink);
          const delta = chunkContentToString(chunk.content);
          if (delta) {
            if (!completionStarted) {
              generation.update({
                completionStartTime: new Date(),
              });
              completionStarted = true;
            }
            assistantNoIndex += delta;
            yield { type: "token", token: delta };
          }
        }
      } finally {
        generation.end({
          output: {
            assistantMessage: assistantNoIndex,
            mode: "rag_empty",
          },
          usageDetails: openAiUsageToLangfuseDetails(usageSink),
        });
      }
      console.log("[chat][rag_empty] response:", assistantNoIndex);
      yield { type: "sources", sources: [] };
      trace.update({
        output: {
          done: true,
          mode: "rag_empty",
          assistantMessage: assistantNoIndex,
          sources: [],
          chosenModel: telem.modelName,
        },
      });
      return;
    }

    const synthesizer = getResponseSynthesizer("compact", { llm: llmAdapter });
    const generation = trace.generation({
      name: "synthesize",
      model: telem.modelName,
      modelParameters: {
        temperature: telem.temperature,
        max_tokens: telem.maxTokens,
      },
      input: {
        augmentedQuery: augmented,
        contextNodes: nodes.map((n) => ({
          score: n.score,
          text: String((n.node as TextNode).text ?? ""),
          metadata: (n.node as TextNode).metadata,
        })),
      },
      metadata: { chatRoute: "rag", chosenModel: telem.modelName },
    });
    let assistantRag = "";
    let completionStarted = false;
    const responseStream = await synthesizer.synthesize({ query: augmented, nodes }, true);
    try {
      for await (const token of streamEngineResponse(responseStream)) {
        if (!completionStarted) {
          generation.update({
            completionStartTime: new Date(),
          });
          completionStarted = true;
        }
        assistantRag += token;
        yield { type: "token", token };
      }
    } finally {
      generation.end({
        output: {
          assistantMessage: assistantRag,
          mode: "rag",
        },
        usageDetails: openAiUsageToLangfuseDetails(ragLlmUsage),
      });
    }
    console.log("[chat][rag] response:", assistantRag);
    console.log("[chat][rag] sources:", citations);
    yield { type: "sources", sources: citations };
    trace.update({
      output: {
        done: true,
        mode: "rag",
        assistantMessage: assistantRag,
        sources: citations,
        chosenModel: telem.modelName,
      },
    });
  } catch (err) {
    trace.update({
      output: { error: err instanceof Error ? err.message : "unknown" },
    });
    throw err;
  } finally {
    await langfuse.flushAsync();
  }
}

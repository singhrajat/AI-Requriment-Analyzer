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
import { getChatModel, getChatModelTelemetry, getLangfuse } from "../config/modelConfig";
import { BrsPipelineRun } from "../models/BrsPipelineRun";
import {
  buildAugmentedUserQuery,
  CHAT_DIRECT_SYSTEM_PROMPT,
  CHAT_NO_INDEXED_DOCS_SYSTEM,
} from "../prompts/chatPrompts";
import { embedText } from "./voyageEmbeddings";

const DEFAULT_TOP_K = 5;

export type ChatCitation = {
  runId: string;
  sourceName: string;
  kind: "brs_chunk" | "brs_full" | "merged_report";
  chunkIndex?: number;
  score?: number;
};

export type ChatStreamEvent =
  | { type: "token"; token: string }
  | { type: "sources"; sources: ChatCitation[] };

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

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

/**
 * Bridges LangChain ChatOpenAI to LlamaIndex's LLM interface for {@link getResponseSynthesizer}.
 */
class LangChainOpenAILlamaIndexLLM extends BaseLLM {
  constructor(
    private readonly lc: ChatOpenAI,
    private readonly meta: LLMMetadata
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
      async function* gen(): AsyncIterable<ChatResponseChunk<object>> {
        for await (const chunk of stream) {
          const delta = chunkContentToString(chunk.content);
          if (delta) {
            yield { raw: null, delta };
          }
        }
      }
      return gen();
    }
    const res = await this.lc.invoke(lcMessages);
    return {
      message: {
        role: "assistant",
        content: chunkContentToString(res.content),
      },
      raw: null,
    };
  }
}

type CandidateNode = {
  node: TextNode;
  score: number;
};

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "of",
  "on",
  "or",
  "our",
  "should",
  "show",
  "that",
  "the",
  "their",
  "then",
  "there",
  "they",
  "this",
  "to",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "you",
  "your",
]);

function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .match(/\b[a-z0-9][a-z0-9_-]{2,}\b/g);
  if (!words) return [];
  const uniq = new Set<string>();
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    if (w.length < 4) continue;
    uniq.add(w);
  }
  return [...uniq];
}

function nodeTextMatchesKeywords(node: NodeWithScore, keywords: string[]): boolean {
  if (keywords.length === 0) return true; // if we can't extract keywords, fall back to showing citations
  const text = String((node.node as TextNode).text ?? "").toLowerCase();
  if (!text) return false;
  return keywords.some((k) => text.includes(k));
}

class MongoBrsRetriever extends BaseRetriever {
  constructor(
    private readonly topK: number,
    private readonly langfuseTrace?: LangfuseTraceClient
  ) {
    super();
  }

  async _retrieve(queryBundle: QueryBundle): Promise<NodeWithScore[]> {
    const span = this.langfuseTrace?.span({ name: "retrieve" });
    try {
      const out = await this.retrieveFromMongo(queryBundle);
      span?.end({ output: { nodeCount: out.length } });
      return out;
    } catch (err) {
      span?.end();
      throw err;
    }
  }

  private async retrieveFromMongo(queryBundle: QueryBundle): Promise<NodeWithScore[]> {
    const queryText = queryBundleToString(queryBundle).trim();
    if (!queryText) return [];

    const queryVector = await embedText(queryText, { inputType: "query" });
    if (queryVector.length === 0) return [];

    const runs = await BrsPipelineRun.find({
      $or: [
        { "embeddings.brs.vector.0": { $exists: true } },
        { "embeddings.brs.chunks.0": { $exists: true } },
        { "embeddings.mergedReport.vector.0": { $exists: true } },
      ],
    })
      .select(
        "_id documentText mergedReport displayName originalFileName embeddings.brs embeddings.mergedReport"
      )
      .lean()
      .exec();

    const candidates: CandidateNode[] = [];

    for (const run of runs) {
      const runId = String(run._id);
      const sourceName = run.displayName || run.originalFileName || runId;
      const docText = run.documentText ?? "";

      const brs = run.embeddings?.brs;
      if (brs?.strategy === "chunked" && brs.chunks?.length) {
        for (const ch of brs.chunks) {
          if (!ch.vector?.length) continue;
          const slice = docText.slice(ch.charStart, ch.charEnd).trim();
          if (!slice) continue;
          const textNode = new TextNode({
            text: slice,
            metadata: {
              runId,
              sourceName,
              kind: "brs_chunk",
              chunkIndex: ch.index,
            },
          });
          candidates.push({
            node: textNode,
            score: cosineSimilarity(queryVector, ch.vector),
          });
        }
      } else if (brs?.vector?.length) {
        const text = docText.trim();
        if (text) {
          const textNode = new TextNode({
            text,
            metadata: { runId, sourceName, kind: "brs_full" },
          });
          candidates.push({
            node: textNode,
            score: cosineSimilarity(queryVector, brs.vector),
          });
        }
      }

      const mergedVec = run.embeddings?.mergedReport?.vector;
      const mergedText = run.mergedReport?.trim();
      if (mergedVec?.length && mergedText) {
        const textNode = new TextNode({
          text: mergedText,
          metadata: { runId, sourceName, kind: "merged_report" },
        });
        candidates.push({
          node: textNode,
          score: cosineSimilarity(queryVector, mergedVec),
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, this.topK);
    return top.map(({ node, score }) => ({ node, score }));
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
    const meta = (n.node as TextNode).metadata as Partial<{
      runId: string;
      sourceName: string;
      kind: ChatCitation["kind"];
      chunkIndex?: number;
    }>;
    const runId = meta.runId ? String(meta.runId) : "";
    const sourceName = meta.sourceName ? String(meta.sourceName) : runId;
    const kind = meta.kind;
    if (!runId || !sourceName || !kind) continue;

    const key = `${runId}::${kind}::${meta.chunkIndex ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      runId,
      sourceName,
      kind,
      chunkIndex: typeof meta.chunkIndex === "number" ? meta.chunkIndex : undefined,
      score: typeof n.score === "number" ? n.score : undefined,
    });
  }
  return out;
}

/**
 * RAG path: LlamaIndex {@link RetrieverQueryEngine} + voyage query embedding + MongoDB cosine retrieval.
 */
export async function* streamRagChat(params: {
  message: string;
  history: ChatHistoryItem[];
}): AsyncGenerator<ChatStreamEvent> {
  const langfuse = getLangfuse();
  const trace = langfuse.trace({
    name: "chat",
    input: { mode: "rag", messageLen: params.message.length },
  });

  const augmented = buildAugmentedUserQuery({
    message: params.message,
    history: params.history,
    useRagPrefix: true,
  });

  try {
    const retriever = new MongoBrsRetriever(DEFAULT_TOP_K, trace);
    const nodes = await retriever.retrieve({ query: augmented });
    const keywords = extractKeywords(params.message);
    const citationNodes = nodes.filter((n) => nodeTextMatchesKeywords(n, keywords));
    const citations = citationsFromNodes(citationNodes);

    const lc = getChatModel();
    const telem = getChatModelTelemetry();
    const llmAdapter = new LangChainOpenAILlamaIndexLLM(lc, {
      model: telem.modelName,
      temperature: telem.temperature,
      topP: 1,
      maxTokens: telem.maxTokens,
      contextWindow: 128000,
      tokenizer: undefined,
      structuredOutput: false,
    });

    if (nodes.length === 0) {
      const synthSpan = trace.span({ name: "synthesize", metadata: { fallback: "no_index" } });
      try {
        const stream = await lc.stream([
          new SystemMessage(CHAT_NO_INDEXED_DOCS_SYSTEM),
          new HumanMessage(params.message),
        ]);
        for await (const chunk of stream) {
          const delta = chunkContentToString(chunk.content);
          if (delta) yield { type: "token", token: delta };
        }
      } finally {
        synthSpan.end();
      }
      yield { type: "sources", sources: [] };
      trace.update({ output: { done: true, mode: "rag_empty" } });
      return;
    }

    const synthesizer = getResponseSynthesizer("compact", { llm: llmAdapter });
    const synthesizeSpan = trace.span({ name: "synthesize" });
    const responseStream = await synthesizer.synthesize({ query: augmented, nodes }, true);
    try {
      for await (const token of streamEngineResponse(responseStream)) {
        yield { type: "token", token };
      }
    } finally {
      synthesizeSpan.end();
    }
    yield { type: "sources", sources: citations };
    trace.update({ output: { done: true, mode: "rag" } });
  } catch (err) {
    trace.update({
      output: { error: err instanceof Error ? err.message : "unknown" },
    });
    throw err;
  } finally {
    await langfuse.flushAsync();
  }
}

/**
 * Direct LLM path (no vector retrieval).
 */
export async function* streamDirectChat(params: {
  message: string;
  history: ChatHistoryItem[];
}): AsyncGenerator<ChatStreamEvent> {
  const langfuse = getLangfuse();
  const trace = langfuse.trace({
    name: "chat",
    input: { mode: "direct", messageLen: params.message.length },
  });

  try {
    const lc = getChatModel();
    const messages: BaseMessage[] = [new SystemMessage(CHAT_DIRECT_SYSTEM_PROMPT)];
    for (const h of params.history.slice(-24)) {
      if (h.role === "system") messages.push(new SystemMessage(h.content));
      else if (h.role === "assistant") messages.push(new AIMessage(h.content));
      else messages.push(new HumanMessage(h.content));
    }
    messages.push(new HumanMessage(params.message));

    const stream = await lc.stream(messages);
    for await (const chunk of stream) {
      const delta = chunkContentToString(chunk.content);
      if (delta) yield { type: "token", token: delta };
    }
    yield { type: "sources", sources: [] };
    trace.update({ output: { done: true, mode: "direct" } });
  } catch (err) {
    trace.update({
      output: { error: err instanceof Error ? err.message : "unknown" },
    });
    throw err;
  } finally {
    await langfuse.flushAsync();
  }
}

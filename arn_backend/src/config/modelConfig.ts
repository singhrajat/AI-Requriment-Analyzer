import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Langfuse } from "langfuse";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env variable: ${key}`);
  return val;
}

function requireNumericEnv(key: string): number {
  const raw = requireEnv(key);
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric env variable ${key}: ${raw}`);
  }
  return n;
}

function optionalEnv(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
}

export interface ModelConfig {
  modelName: string;
  temperature: number;
  maxTokens: number;
}

export type ChatModelRole = "default" | "fetch" | "dev" | "pm" | "reviewer";

function getModelConfig(): ModelConfig {
  return {
    modelName: requireEnv("OPENAI_MODEL"),
    temperature: requireNumericEnv("OPENAI_TEMPERATURE"),
    maxTokens: requireNumericEnv("OPENAI_MAX_TOKENS"),
  };
}

function getRoleModelId(role: Exclude<ChatModelRole, "reviewer">): string {
  switch (role) {
    case "fetch":
      return requireEnv("OPENAI_FETCH_MODEL");
    case "dev":
      return requireEnv("OPENAI_DEV_MODEL");
    case "pm":
      return requireEnv("OPENAI_PM_MODEL");
    default:
      return requireEnv("OPENAI_MODEL");
  }
}

/** OpenAI reasoning models (o1, o3, o4-mini, …) only accept the default temperature (1). */
function effectiveOpenAiTemperature(modelName: string, requested: number): number {
  const id = modelName.split("/").pop() ?? modelName;
  return /^o\d/i.test(id) ? 1 : requested;
}

/** Model id for tiktoken / routing; same as `OPENAI_MODEL` (required). */
export function getOpenAiChatModelId(): string {
  return requireEnv("OPENAI_MODEL");
}

/**
 * Chat widget direct path (greeting / small talk). Uses `OPENAI_CHAT_DIRECT_MODEL` when set, else `OPENAI_MODEL`.
 */
export function getOpenAiChatDirectModelId(): string {
  return optionalEnv("OPENAI_CHAT_DIRECT_MODEL") ?? requireEnv("OPENAI_MODEL");
}

export type ChatRouteKind = "direct" | "rag";

/** Telemetry for portal chat: direct (greeting gate) vs RAG synthesis. */
export function getChatModelTelemetryForRoute(route: ChatRouteKind): {
  modelName: string;
  temperature: number;
  maxTokens: number;
} {
  const base = getModelConfig();
  const modelName =
    route === "direct" ? getOpenAiChatDirectModelId() : requireEnv("OPENAI_MODEL");
  return {
    modelName,
    temperature: effectiveOpenAiTemperature(modelName, base.temperature),
    maxTokens: base.maxTokens,
  };
}

/** Telemetry / adapter metadata for RAG chat (same as `getChatModelTelemetryForRoute("rag")`). */
export function getChatModelTelemetry(): {
  modelName: string;
  temperature: number;
  maxTokens: number;
} {
  return getChatModelTelemetryForRoute("rag");
}

function createChatOpenAIFromModelId(modelName: string): ChatOpenAI {
  const base = getModelConfig();
  const temperature = effectiveOpenAiTemperature(modelName, base.temperature);
  return new ChatOpenAI({
    apiKey: requireEnv("OPENAI_API_KEY"),
    model: modelName,
    temperature,
    maxTokens: base.maxTokens,
    modelKwargs: {
      stream_options: { include_usage: true },
    },
  });
}

/** RAG chat + no-index fallback; uses `OPENAI_MODEL`. */
export function getChatModel(): ChatOpenAI {
  return createChatOpenAIFromModelId(requireEnv("OPENAI_MODEL"));
}

/** Direct greeting/small-talk path; uses `OPENAI_CHAT_DIRECT_MODEL` or falls back to `OPENAI_MODEL`. */
export function getChatModelDirect(): ChatOpenAI {
  return createChatOpenAIFromModelId(getOpenAiChatDirectModelId());
}

export function getChatModelForRole(role: Exclude<ChatModelRole, "reviewer">): ChatOpenAI {
  const base = getModelConfig();
  const modelName = getRoleModelId(role);
  const temperature = effectiveOpenAiTemperature(modelName, base.temperature);
  return new ChatOpenAI({
    apiKey: requireEnv("OPENAI_API_KEY"),
    model: modelName,
    temperature,
    maxTokens: base.maxTokens,
  });
}

export function getChatModelIdForRole(role: Exclude<ChatModelRole, "reviewer">): string {
  return getRoleModelId(role);
}

/** Telemetry for pipeline agents: per-role model id + effective params. */
export function getChatModelTelemetryForRole(role: Exclude<ChatModelRole, "reviewer">): {
  modelName: string;
  temperature: number;
  maxTokens: number;
} {
  const base = getModelConfig();
  const modelName = getRoleModelId(role);
  return {
    modelName,
    temperature: effectiveOpenAiTemperature(modelName, base.temperature),
    maxTokens: base.maxTokens,
  };
}

/** BRS Reviewer Agent — model from `OPENAI_BRS_REVIEWER_MODEL` (reasoning-class per RULE-REVIEW-004). */
export function getReviewerChatModel(): ChatOpenAI {
  const base = getModelConfig();
  const modelName = requireEnv("OPENAI_BRS_REVIEWER_MODEL");
  const config = { ...base, modelName };
  const temperature = effectiveOpenAiTemperature(config.modelName, config.temperature);
  return new ChatOpenAI({
    apiKey: requireEnv("OPENAI_API_KEY"),
    model: config.modelName,
    temperature,
    maxTokens: config.maxTokens,
  });
}

export function getReviewerModelTelemetry(): {
  modelName: string;
  temperature: number;
  maxTokens: number;
} {
  const base = getModelConfig();
  const modelName = requireEnv("OPENAI_BRS_REVIEWER_MODEL");
  return {
    modelName,
    temperature: effectiveOpenAiTemperature(modelName, base.temperature),
    maxTokens: base.maxTokens,
  };
}

let _openAiEmbeddings: OpenAIEmbeddings | null = null;

/** Embedding model id from env only (`OPENAI_EMBEDDING_MODEL`). */
export function getOpenAiEmbeddingModelId(): string {
  return requireEnv("OPENAI_EMBEDDING_MODEL");
}

/**
 * Declared output dimensions when using reduced embeddings (`OPENAI_EMBEDDING_DIMENSIONS`).
 * If unset, OpenAI uses the model default (e.g. 3072 for text-embedding-3-large).
 */
export function getOpenAiEmbeddingDimensions(): number | undefined {
  const raw = process.env.OPENAI_EMBEDDING_DIMENSIONS;
  if (!raw || !raw.trim()) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`Invalid OPENAI_EMBEDDING_DIMENSIONS: ${raw}`);
  }
  return n;
}

export function getOpenAIEmbeddings(): OpenAIEmbeddings {
  if (!_openAiEmbeddings) {
    const model = getOpenAiEmbeddingModelId();
    const dimensions = getOpenAiEmbeddingDimensions();
    _openAiEmbeddings = new OpenAIEmbeddings({
      apiKey: requireEnv("OPENAI_API_KEY"),
      model,
      ...(dimensions !== undefined ? { dimensions } : {}),
      batchSize: 64,
    });
  }
  return _openAiEmbeddings;
}

export type RecursiveChunkEnvConfig = {
  chunkSize: number;
  chunkOverlap: number;
};

export function getRecursiveChunkConfig(): RecursiveChunkEnvConfig {
  const chunkSize = Number(process.env.CHUNK_SIZE ?? "1500");
  const chunkOverlap = Number(process.env.CHUNK_OVERLAP ?? "200");
  if (!Number.isFinite(chunkSize) || chunkSize < 1) {
    throw new Error(`Invalid CHUNK_SIZE: ${process.env.CHUNK_SIZE}`);
  }
  if (!Number.isFinite(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new Error(`Invalid CHUNK_OVERLAP (must be < CHUNK_SIZE): ${process.env.CHUNK_OVERLAP}`);
  }
  return { chunkSize, chunkOverlap };
}

/** Qdrant REST URL (e.g. http://localhost:6333). Required when using vector search. */
export function getQdrantUrl(): string {
  return requireEnv("QDRANT_URL");
}

export function getQdrantApiKey(): string | undefined {
  return optionalEnv("QDRANT_API_KEY");
}

export function getQdrantCollectionName(): string {
  return requireEnv("QDRANT_COLLECTION_NAME");
}

/** Qdrant collection that stores merge-report vectors (separate from BRS). Required when merge RAG is enabled. */
export function getQdrantMergeCollectionName(): string {
  return requireEnv("QDRANT_MERGE_COLLECTION_NAME");
}

let _langfuse: Langfuse | null = null;

export function getLangfuse(): Langfuse {
  if (!_langfuse) {
    _langfuse = new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? "",
      secretKey: process.env.LANGFUSE_SECRET_KEY ?? "",
      baseUrl: process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com",
      flushAt: 1,
    });
  }
  return _langfuse;
}

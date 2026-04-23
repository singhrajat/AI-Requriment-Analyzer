import { ChatOpenAI } from "@langchain/openai";
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

/** Telemetry / adapter metadata for chat integrations (LlamaIndex LLM wrapper, etc.). */
export function getChatModelTelemetry(): {
  modelName: string;
  temperature: number;
  maxTokens: number;
} {
  const config = getModelConfig();
  return {
    modelName: config.modelName,
    temperature: effectiveOpenAiTemperature(config.modelName, config.temperature),
    maxTokens: config.maxTokens,
  };
}

export function getChatModel(): ChatOpenAI {
  const config = getModelConfig();
  const temperature = effectiveOpenAiTemperature(config.modelName, config.temperature);
  return new ChatOpenAI({
    apiKey: requireEnv("OPENAI_API_KEY"),
    model: config.modelName,
    temperature,
    maxTokens: config.maxTokens,
  });
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

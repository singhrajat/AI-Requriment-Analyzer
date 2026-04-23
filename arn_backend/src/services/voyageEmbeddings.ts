type VoyageEmbedInputType = "query" | "document";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env variable: ${key}`);
  return val;
}

const VOYAGE_EMBEDDING_MODEL = "voyage-3.5-lite" as const;

function getVoyageEmbeddingModel(): typeof VOYAGE_EMBEDDING_MODEL {
  const configured = process.env.VOYAGE_EMBED_MODEL;
  if (!configured) return VOYAGE_EMBEDDING_MODEL;
  if (configured !== VOYAGE_EMBEDDING_MODEL) {
    throw new Error(
      `Invalid VOYAGE_EMBED_MODEL: ${configured}. Must be ${VOYAGE_EMBEDDING_MODEL}.`
    );
  }
  return VOYAGE_EMBEDDING_MODEL;
}

type VoyageEmbeddingsResponse = {
  data: Array<{
    embedding: number[];
    index: number;
    object: string;
  }>;
  model: string;
  object: string;
  usage?: unknown;
};

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function postEmbeddings(
  input: string | string[],
  input_type: VoyageEmbedInputType
): Promise<VoyageEmbeddingsResponse> {
  const apiKey = requireEnv("VOYAGE_API_KEY");
  const model = getVoyageEmbeddingModel();

  const res = await fetch("https://ai.mongodb.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input, input_type }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Voyage embeddings failed (${res.status}): ${body.slice(0, 500)}`);
  }

  return (await res.json()) as VoyageEmbeddingsResponse;
}

async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      await sleep(300 * attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Voyage embeddings failed");
}

export async function embedText(
  text: string,
  opts?: { inputType?: VoyageEmbedInputType }
): Promise<number[]> {
  const input_type: VoyageEmbedInputType = opts?.inputType ?? "document";
  const trimmed = text.trim();
  if (!trimmed) return [];

  const json = await withRetries(() => postEmbeddings(trimmed, input_type));
  const first = json.data?.[0]?.embedding;
  if (!Array.isArray(first)) throw new Error("Voyage embeddings returned invalid payload");
  return first;
}

export async function embedTexts(
  texts: string[],
  opts?: { inputType?: VoyageEmbedInputType }
): Promise<number[][]> {
  const input_type: VoyageEmbedInputType = opts?.inputType ?? "document";
  const cleaned = texts.map((t) => t.trim());
  if (cleaned.length === 0) return [];
  if (cleaned.some((t) => !t)) {
    throw new Error("Voyage embeddings received empty text input");
  }

  const json = await withRetries(() => postEmbeddings(cleaned, input_type));
  if (!Array.isArray(json.data) || json.data.length !== cleaned.length) {
    throw new Error("Voyage embeddings returned unexpected result length");
  }

  const vectors: number[][] = new Array(cleaned.length);
  for (const item of json.data) {
    if (!Array.isArray(item.embedding)) {
      throw new Error("Voyage embeddings returned invalid embedding");
    }
    vectors[item.index] = item.embedding;
  }

  if (vectors.some((v) => !Array.isArray(v))) {
    throw new Error("Voyage embeddings missing one or more vectors");
  }

  return vectors;
}


import { createHash } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import {
  getQdrantApiKey,
  getQdrantCollectionName,
  getQdrantMergeCollectionName,
  getQdrantUrl,
} from "../config/modelConfig";

export type BrsVectorKind =
  | "brs_chunk"
  | "brs_full"
  | "merge_report";

export type BrsVectorPayload = {
  runId: string;
  sourceName: string;
  kind: BrsVectorKind;
  /** Stored passage returned to the LLM (required for RAG). */
  text: string;
  chunkIndex?: number;
  /** Merge-only: dotted path identifying the section/item this part came from. */
  sectionPath?: string;
  /** Merge-only: 1-based part index when a section was split into multiple parts. */
  partIndex?: number;
  /** Merge-only: total number of parts for the section. */
  partCount?: number;
};

let _client: QdrantClient | null = null;
/** Per-collection cache: collection name → vector size that was ensured. */
const _ensuredCollections = new Map<string, number>();
/** Per-collection cache: collections that already have the `runId` keyword payload index. */
const _runIdKeywordIndexReady = new Set<string>();

function isPayloadIndexAlreadyExistsError(err: unknown): boolean {
  const e = err as { data?: { status?: { error?: string } } };
  const msg = e?.data?.status?.error ?? "";
  return /already exists|duplicate field/i.test(msg);
}

/** Ensures `runId` has a keyword payload index (required for filtered deletes/search on Qdrant Cloud). */
async function ensureRunIdKeywordPayloadIndex(client: QdrantClient, collectionName: string): Promise<void> {
  if (_runIdKeywordIndexReady.has(collectionName)) return;

  let info;
  try {
    info = await client.getCollection(collectionName);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 404) return;
    throw err;
  }

  const runIdSchema = info.payload_schema?.runId;
  if (runIdSchema?.data_type === "keyword") {
    _runIdKeywordIndexReady.add(collectionName);
    return;
  }

  try {
    await client.createPayloadIndex(collectionName, {
      field_name: "runId",
      field_schema: "keyword",
      wait: true,
    });
  } catch (err) {
    if (isPayloadIndexAlreadyExistsError(err)) {
      _runIdKeywordIndexReady.add(collectionName);
      return;
    }
    throw err;
  }
  _runIdKeywordIndexReady.add(collectionName);
}

export function getQdrantClient(): QdrantClient {
  if (!_client) {
    _client = new QdrantClient({
      url: getQdrantUrl(),
      apiKey: getQdrantApiKey(),
    });
  }
  return _client;
}

/**
 * Qdrant Cloud (strict) accepts point IDs only as unsigned integers or UUIDs.
 * Deterministic UUID (v4 layout, RFC 4122 variant) from a stable string key.
 */
function deterministicUuidFromKey(key: string): string {
  const digest = createHash("sha256").update(key, "utf8").digest();
  const b = Buffer.allocUnsafe(16);
  digest.copy(b, 0, 0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Deterministic point id for a BRS vector (chunk or full doc). */
export function brsPointId(runId: string, kind: "brs_chunk" | "brs_full", chunkIndex?: number): string {
  const key =
    kind === "brs_chunk"
      ? `arn_brs_point|${runId}|${kind}|${chunkIndex ?? 0}`
      : `arn_brs_point|${runId}|${kind}`;
  return deterministicUuidFromKey(key);
}

/** Deterministic point id for a merge-report vector (re-embed is idempotent via upsert). */
export function mergeReportPointId(runId: string, sectionPath: string, partIndex: number): string {
  const key = `arn_merge_report_point|${runId}|${sectionPath}|${partIndex}`;
  return deterministicUuidFromKey(key);
}

async function ensureCollection(collectionName: string, vectorSize: number): Promise<void> {
  if (_ensuredCollections.get(collectionName) === vectorSize) return;

  const client = getQdrantClient();
  const cols = await client.getCollections();
  const exists = cols.collections.some((c) => c.name === collectionName);

  if (!exists) {
    await client.createCollection(collectionName, {
      vectors: {
        size: vectorSize,
        distance: "Cosine",
      },
    });
  }

  await ensureRunIdKeywordPayloadIndex(client, collectionName);

  _ensuredCollections.set(collectionName, vectorSize);
}

/** Backwards-compatible: ensure the BRS collection (kept for existing callers). */
export async function ensureBrsCollection(vectorSize: number): Promise<void> {
  await ensureCollection(getQdrantCollectionName(), vectorSize);
}

export async function ensureMergeReportCollection(vectorSize: number): Promise<void> {
  await ensureCollection(getQdrantMergeCollectionName(), vectorSize);
}

export async function upsertBrsVectors(
  points: Array<{ id: string; vector: number[]; payload: BrsVectorPayload }>
): Promise<void> {
  if (points.length === 0) return;
  const dim = points[0].vector.length;
  const name = getQdrantCollectionName();
  await ensureCollection(name, dim);
  const client = getQdrantClient();
  await client.upsert(name, {
    wait: true,
    points: points.map((p) => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload as Record<string, unknown>,
    })),
  });
}

export async function upsertMergeReportVectors(
  points: Array<{ id: string; vector: number[]; payload: BrsVectorPayload }>
): Promise<void> {
  if (points.length === 0) return;
  const dim = points[0].vector.length;
  const name = getQdrantMergeCollectionName();
  await ensureCollection(name, dim);
  const client = getQdrantClient();
  await client.upsert(name, {
    wait: true,
    points: points.map((p) => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload as Record<string, unknown>,
    })),
  });
}

/** Best-effort delete that survives missing collections / missing payload indexes during cleanup. */
async function safeDeleteByRunId(client: QdrantClient, collectionName: string, runId: string): Promise<void> {
  try {
    await ensureRunIdKeywordPayloadIndex(client, collectionName);
  } catch (err) {
    console.warn(`[qdrant] ensureRunIdKeywordPayloadIndex(${collectionName}) failed:`, err);
  }
  try {
    await client.delete(collectionName, {
      wait: true,
      filter: {
        must: [{ key: "runId", match: { value: runId } }],
      },
    });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 404) return;
    throw err;
  }
}

/** Delete all points for a run from BOTH the BRS and merge collections (used by DELETE /runs/:id). */
export async function deleteQdrantPointsForRun(runId: string): Promise<void> {
  const client = getQdrantClient();
  const brs = getQdrantCollectionName();
  const merge = getQdrantMergeCollectionName();
  await Promise.all([
    safeDeleteByRunId(client, brs, runId),
    safeDeleteByRunId(client, merge, runId),
  ]);
}

/** Delete only merge-report points for a run (used on Discard of an escalated merge). BRS vectors stay. */
export async function deleteMergeReportPointsForRun(runId: string): Promise<void> {
  const client = getQdrantClient();
  const merge = getQdrantMergeCollectionName();
  await safeDeleteByRunId(client, merge, runId);
}

export type SearchHit = { score: number; payload: BrsVectorPayload };

export type BrsSearchOptions = {
  /** Restrict hits to a single BRS run (Mongo id). When omitted, search is global. */
  runId?: string;
  /**
   * When true, search the merge-report collection in addition to BRS (scores merged; still scoped by runId when set).
   * When false or omitted, only the BRS collection is queried.
   */
  includeMergeReport?: boolean;
};

/** Best-effort search of one collection; tolerates missing collection (returns []). */
async function searchCollection(
  client: QdrantClient,
  collectionName: string,
  queryVector: number[],
  topK: number,
  opts: BrsSearchOptions
): Promise<SearchHit[]> {
  const filter = opts.runId
    ? { must: [{ key: "runId", match: { value: opts.runId } }] }
    : undefined;

  let res;
  try {
    res = await client.search(collectionName, {
      vector: queryVector,
      limit: topK,
      with_payload: true,
      ...(filter ? { filter } : {}),
    });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 404) return [];
    throw err;
  }

  const out: SearchHit[] = [];
  for (const sp of res) {
    const p = sp.payload as Record<string, unknown> | null | undefined;
    if (!p || typeof p.text !== "string" || typeof p.runId !== "string" || typeof p.sourceName !== "string") {
      continue;
    }
    const kind = p.kind as BrsVectorKind;
    if (kind !== "brs_chunk" && kind !== "brs_full" && kind !== "merge_report") continue;
    const chunkIndex = typeof p.chunkIndex === "number" ? p.chunkIndex : undefined;
    const sectionPath = typeof p.sectionPath === "string" ? p.sectionPath : undefined;
    const partIndex = typeof p.partIndex === "number" ? p.partIndex : undefined;
    const partCount = typeof p.partCount === "number" ? p.partCount : undefined;
    out.push({
      score: sp.score ?? 0,
      payload: {
        runId: p.runId,
        sourceName: p.sourceName,
        kind,
        text: p.text,
        ...(chunkIndex !== undefined ? { chunkIndex } : {}),
        ...(sectionPath !== undefined ? { sectionPath } : {}),
        ...(partIndex !== undefined ? { partIndex } : {}),
        ...(partCount !== undefined ? { partCount } : {}),
      },
    });
  }
  return out;
}

/**
 * Similarity search over Qdrant BRS vectors, optionally including merge-report vectors for the same run(s).
 * Both collections share the same embedding model + dimension, so scores are comparable when merged.
 */
export async function searchBrsSimilar(
  queryVector: number[],
  topK: number,
  opts: BrsSearchOptions = {}
): Promise<SearchHit[]> {
  const client = getQdrantClient();
  const brs = getQdrantCollectionName();
  const includeMerge = opts.includeMergeReport === true;

  if (!includeMerge) {
    const brsHits = await searchCollection(client, brs, queryVector, topK, opts);
    brsHits.sort((a, b) => b.score - a.score);
    return brsHits.slice(0, topK);
  }

  const merge = getQdrantMergeCollectionName();
  const [brsHits, mergeHits] = await Promise.all([
    searchCollection(client, brs, queryVector, topK, opts),
    searchCollection(client, merge, queryVector, topK, opts),
  ]);
  const all = [...brsHits, ...mergeHits];
  all.sort((a, b) => b.score - a.score);
  return all.slice(0, topK);
}

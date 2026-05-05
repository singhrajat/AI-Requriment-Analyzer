import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { z } from "zod";
import {
  getLangfuse,
  getOpenAIEmbeddings,
  getOpenAiEmbeddingModelId,
  getRecursiveChunkConfig,
} from "../config/modelConfig";
import { BrsPipelineRun } from "../models/BrsPipelineRun";
import { parseJsonLikeOutput } from "../utils/parseJsonLikeOutput";
import {
  mergeReportPointId,
  upsertMergeReportVectors,
  type BrsVectorPayload,
} from "./qdrantBrsStore";

/**
 * Item-safe chunking budget per section/part. Larger than CHUNK_SIZE (which is character-based,
 * applied only as a last resort to a single huge item) — sections/items are usually short bullets.
 */
const SECTION_PART_BUDGET_CHARS = 4000;

const MergeReportSchema = z.object({
  summary: z.string().optional(),
  developerAnalysis: z
    .object({
      validations: z.array(z.unknown()).optional(),
      error_handling: z.array(z.unknown()).optional(),
      security: z.array(z.unknown()).optional(),
      edge_cases: z.array(z.unknown()).optional(),
    })
    .optional(),
  pmAnalysis: z
    .object({
      risks: z.array(z.unknown()).optional(),
      failure_points: z.array(z.unknown()).optional(),
      timeline_risks: z.array(z.unknown()).optional(),
      escalation_paths: z.array(z.unknown()).optional(),
    })
    .optional(),
  criticalActions: z.array(z.unknown()).optional(),
  overallRiskLevel: z.string().optional(),
});

type MergeReport = z.infer<typeof MergeReportSchema>;

type SectionPart = {
  sectionPath: string;
  text: string;
};

/** Render a single array item to a human-readable bullet line/block. */
function renderItem(item: unknown): string {
  if (item === null || item === undefined) return "";
  if (typeof item === "string") return item.trim();
  if (typeof item === "number" || typeof item === "boolean") return String(item);
  if (Array.isArray(item)) {
    return item.map((sub) => renderItem(sub)).filter(Boolean).join("; ");
  }
  if (typeof item === "object") {
    const obj = item as Record<string, unknown>;
    const lines: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        lines.push(`${k}: ${String(v)}`);
        continue;
      }
      if (Array.isArray(v)) {
        const rendered = v.map((sub) => renderItem(sub)).filter(Boolean).join("; ");
        if (rendered) lines.push(`${k}: ${rendered}`);
        continue;
      }
      if (typeof v === "object") {
        try {
          lines.push(`${k}: ${JSON.stringify(v)}`);
        } catch {
          // ignore unserializable
        }
      }
    }
    return lines.join("\n");
  }
  return String(item);
}

function bullet(line: string): string {
  return `- ${line.replace(/\n/g, "\n  ")}`;
}

/**
 * Build one or more parts for a section that consists of a list of items.
 * Batches items on item boundaries; only splits a single item if it alone exceeds the budget.
 */
async function buildPartsFromItems(
  sectionPath: string,
  header: string,
  items: unknown[]
): Promise<SectionPart[]> {
  const rendered = items
    .map((it) => renderItem(it))
    .map((s) => s.trim())
    .filter(Boolean);

  if (rendered.length === 0) return [];

  const parts: SectionPart[] = [];
  let current: string[] = [];
  let currentLen = header.length + 2;

  const flush = () => {
    if (current.length === 0) return;
    parts.push({
      sectionPath,
      text: `${header}\n\n${current.map(bullet).join("\n")}`.trim(),
    });
    current = [];
    currentLen = header.length + 2;
  };

  for (const itemText of rendered) {
    const itemLen = itemText.length + 4;
    if (itemLen > SECTION_PART_BUDGET_CHARS) {
      flush();
      const { chunkSize, chunkOverlap } = getRecursiveChunkConfig();
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize,
        chunkOverlap,
        separators: ["\n\n\n", "\n\n", "\n", ". ", " ", ""],
      });
      const subParts = await splitter.splitText(itemText);
      const cleaned = subParts.map((s) => s.trim()).filter(Boolean);
      cleaned.forEach((sub) => {
        parts.push({
          sectionPath,
          text: `${header}\n\n${bullet(sub)}`.trim(),
        });
      });
      continue;
    }

    if (currentLen + itemLen > SECTION_PART_BUDGET_CHARS && current.length > 0) {
      flush();
    }
    current.push(itemText);
    currentLen += itemLen;
  }

  flush();
  return parts;
}

function buildSummaryParts(report: MergeReport): SectionPart[] {
  const summary = (report.summary ?? "").trim();
  const risk = (report.overallRiskLevel ?? "").trim();
  if (!summary && !risk) return [];
  const lines: string[] = [];
  if (summary) lines.push(summary);
  if (risk) lines.push(`Overall risk level: ${risk}`);
  return [
    {
      sectionPath: "summary",
      text: `# Summary\n\n${lines.join("\n\n")}`.trim(),
    },
  ];
}

async function buildArraySectionParts(
  sectionPath: string,
  title: string,
  items: unknown[] | undefined
): Promise<SectionPart[]> {
  if (!items || items.length === 0) return [];
  const header = `# ${title}`;
  return buildPartsFromItems(sectionPath, header, items);
}

const DEV_KEYS: Array<keyof NonNullable<MergeReport["developerAnalysis"]>> = [
  "validations",
  "error_handling",
  "security",
  "edge_cases",
];

const PM_KEYS: Array<keyof NonNullable<MergeReport["pmAnalysis"]>> = [
  "risks",
  "failure_points",
  "timeline_risks",
  "escalation_paths",
];

function titleFromKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Build all section parts for a merge-report JSON. Pure function — exported for unit testing.
 */
export async function buildMergeReportSectionParts(report: MergeReport): Promise<SectionPart[]> {
  const out: SectionPart[] = [];

  out.push(...buildSummaryParts(report));

  out.push(
    ...(await buildArraySectionParts(
      "criticalActions",
      "Critical Actions",
      report.criticalActions
    ))
  );

  if (report.developerAnalysis) {
    for (const key of DEV_KEYS) {
      const items = report.developerAnalysis[key] as unknown[] | undefined;
      out.push(
        ...(await buildArraySectionParts(
          `developerAnalysis.${key}`,
          `Developer Analysis — ${titleFromKey(key)}`,
          items
        ))
      );
    }
  }

  if (report.pmAnalysis) {
    for (const key of PM_KEYS) {
      const items = report.pmAnalysis[key] as unknown[] | undefined;
      out.push(
        ...(await buildArraySectionParts(
          `pmAnalysis.${key}`,
          `PM Analysis — ${titleFromKey(key)}`,
          items
        ))
      );
    }
  }

  return out;
}

export type EmbedMergeReportInput = {
  runId: string;
  sourceName: string;
  mergedReportText: string;
};

/**
 * Parse → validate → section-build → embed → upsert into the merge-report Qdrant collection.
 * Failures are logged and swallowed: callers must never let merge embedding fail the pipeline.
 */
export async function embedMergeReport(input: EmbedMergeReportInput): Promise<void> {
  const { runId, sourceName, mergedReportText } = input;
  const langfuse = getLangfuse();
  const trace = langfuse.trace({
    name: "merge-report-embed",
    input: { runId, sourceName },
  });

  try {
    const parsed = parseJsonLikeOutput(mergedReportText);
    if (!parsed || typeof parsed !== "object") {
      trace.update({ output: { skipped: "merge_report_unparsable" } });
      console.warn(`[mergeReportEmbed] run ${runId}: unable to parse mergedReport JSON; skipping embed.`);
      return;
    }

    const validation = MergeReportSchema.safeParse(parsed);
    if (!validation.success) {
      trace.update({
        output: {
          skipped: "merge_report_schema_invalid",
          issues: validation.error.issues.slice(0, 5),
        },
      });
      console.warn(
        `[mergeReportEmbed] run ${runId}: mergedReport failed schema validation; skipping embed.`,
        validation.error.issues.slice(0, 3)
      );
      return;
    }

    const sectionPartsSpan = trace.span({ name: "build_sections" });
    const flat = await buildMergeReportSectionParts(validation.data);

    const groupedByPath = new Map<string, SectionPart[]>();
    for (const p of flat) {
      const arr = groupedByPath.get(p.sectionPath) ?? [];
      arr.push(p);
      groupedByPath.set(p.sectionPath, arr);
    }

    const points: Array<{ id: string; vector: number[]; payload: BrsVectorPayload }> = [];
    const embedTexts: string[] = [];
    const embedMeta: Array<{ sectionPath: string; partIndex: number; partCount: number; text: string }> = [];

    for (const [sectionPath, sectionParts] of groupedByPath.entries()) {
      const partCount = sectionParts.length;
      sectionParts.forEach((part, i) => {
        const partIndex = i + 1;
        embedTexts.push(part.text);
        embedMeta.push({ sectionPath, partIndex, partCount, text: part.text });
      });
    }

    sectionPartsSpan.end({
      output: { sectionCount: groupedByPath.size, partCount: embedTexts.length },
    });

    if (embedTexts.length === 0) {
      trace.update({ output: { skipped: "no_sections" } });
      return;
    }

    const embedSpan = trace.span({
      name: "embed",
      input: {
        provider: "openai",
        model: getOpenAiEmbeddingModelId(),
        partCount: embedTexts.length,
      },
    });
    const embeddings = getOpenAIEmbeddings();
    const vectors = await embeddings.embedDocuments(embedTexts);
    embedSpan.end({ output: { vectorCount: vectors.length, dim: vectors[0]?.length ?? 0 } });

    for (let i = 0; i < embedMeta.length; i++) {
      const m = embedMeta[i]!;
      const vec = vectors[i];
      if (!vec) continue;
      points.push({
        id: mergeReportPointId(runId, m.sectionPath, m.partIndex),
        vector: vec,
        payload: {
          runId,
          sourceName,
          kind: "merge_report",
          text: m.text,
          sectionPath: m.sectionPath,
          partIndex: m.partIndex,
          partCount: m.partCount,
        },
      });
    }

    const upsertSpan = trace.span({ name: "upsert", input: { pointCount: points.length } });
    await upsertMergeReportVectors(points);
    upsertSpan.end({ output: { ok: true } });

    trace.update({
      output: {
        runId,
        sourceName,
        sectionCount: groupedByPath.size,
        partCount: points.length,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mergeReportEmbed] run ${runId}: embed failed:`, err);
    trace.update({ output: { error: msg } });
  } finally {
    await langfuse.flushAsync();
  }
}

/**
 * Convenience wrapper: load the run from Mongo and embed its merge report. Non-throwing.
 * Used by both the pipeline (non-escalated path) and the route (escalated save).
 */
export async function embedMergeReportForRun(runId: string): Promise<void> {
  try {
    const run = await BrsPipelineRun.findById(runId)
      .select("displayName originalFileName mergedReport _id")
      .lean();
    if (!run) {
      console.warn(`[mergeReportEmbed] run ${runId}: not found in Mongo.`);
      return;
    }
    if (typeof run.mergedReport !== "string" || run.mergedReport.length === 0) {
      console.warn(`[mergeReportEmbed] run ${runId}: no mergedReport text; skipping embed.`);
      return;
    }
    const sourceName = run.displayName || run.originalFileName || runId;
    await embedMergeReport({
      runId,
      sourceName,
      mergedReportText: run.mergedReport,
    });
  } catch (err) {
    console.error(`[mergeReportEmbed] run ${runId}: load failed:`, err);
  }
}

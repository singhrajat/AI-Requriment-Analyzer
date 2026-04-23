import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import type { IBrsPipelineRun } from "../models/BrsPipelineRun";
import { paragraphsFromStructuredOutput } from "./brsStructuredOutputDocx";

type RunExport = Pick<
  IBrsPipelineRun,
  | "status"
  | "stages"
  | "devOutput"
  | "pmOutput"
  | "mergedReport"
  | "displayName"
  | "originalFileName"
  | "inputSizeClass"
  | "chunkCount"
  | "chunkMergeStatus"
  | "chunkMergeError"
  | "awaitingUserDecision"
  | "mergeSource"
> & {
  _id: { toString(): string } | string;
  createdAt?: Date;
  updatedAt?: Date;
  completedAt?: Date;
};

function runIdString(run: RunExport): string {
  return typeof run._id === "string" ? run._id : run._id.toString();
}

function formatDate(d?: Date): string {
  if (!d) return "—";
  try {
    return new Date(d).toISOString();
  } catch {
    return "—";
  }
}

function stageLabel(
  stages: RunExport["stages"] | undefined | null,
  key: "fetch" | "dev" | "pm" | "review" | "merge"
): string {
  const v = stages?.[key];
  return typeof v === "string" && v.length > 0 ? v : "—";
}

export function safeDocxAttachmentName(originalFileName: string | undefined, runId: string): string {
  const raw = (originalFileName ?? `brs-${runId}`).replace(/[/\\?%*:|"<>]/g, "_").trim() || `brs-${runId}`;
  const withoutExt = raw.replace(/\.[^/.]+$/i, "");
  const base = withoutExt.slice(0, 120) || `brs-${runId}`;
  return `${base}-BRS-output.docx`;
}

export async function buildBrsRunDocxBuffer(run: RunExport): Promise<Buffer> {
  if (run.status === "awaiting_user_decision") {
    throw new Error(
      "DOCX export is unavailable until you save or discard the provisional merged report."
    );
  }

  const id = runIdString(run);
  const metaLines: Paragraph[] = [
    new Paragraph({
      children: [
        new TextRun({ text: "Run ID: ", bold: true }),
        new TextRun(id),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Name: ", bold: true }),
        new TextRun(run.displayName ?? "—"),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Original file: ", bold: true }),
        new TextRun(run.originalFileName ?? "—"),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Status: ", bold: true }),
        new TextRun(run.status),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Created: ", bold: true }),
        new TextRun(formatDate(run.createdAt)),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Last updated: ", bold: true }),
        new TextRun(formatDate(run.updatedAt)),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Completed: ", bold: true }),
        new TextRun(formatDate(run.completedAt)),
      ],
    }),
  ];

  if (run.inputSizeClass != null) {
    metaLines.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Input size class: ", bold: true }),
          new TextRun(run.inputSizeClass),
        ],
      })
    );
  }
  if (run.chunkCount != null) {
    metaLines.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Chunk count: ", bold: true }),
          new TextRun(String(run.chunkCount)),
        ],
      })
    );
  }
  if (run.chunkMergeStatus != null) {
    metaLines.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Chunk merge: ", bold: true }),
          new TextRun(run.chunkMergeStatus),
        ],
      })
    );
  }
  if (run.chunkMergeError?.trim()) {
    metaLines.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Chunk merge error: ", bold: true }),
          new TextRun(run.chunkMergeError),
        ],
      })
    );
  }

  const stageRows: Paragraph[] = [
    new Paragraph({
      text: "Pipeline stages",
      heading: HeadingLevel.HEADING_2,
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Fetch: ", bold: true }),
        new TextRun(stageLabel(run.stages, "fetch")),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Developer agent: ", bold: true }),
        new TextRun(stageLabel(run.stages, "dev")),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "PM agent: ", bold: true }),
        new TextRun(stageLabel(run.stages, "pm")),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Reviewer: ", bold: true }),
        new TextRun(stageLabel(run.stages, "review")),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Merge: ", bold: true }),
        new TextRun(stageLabel(run.stages, "merge")),
      ],
    }),
  ];

  const children: Paragraph[] = [
    new Paragraph({
      text: "BRS pipeline — generated outputs",
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 200 },
    }),
    ...metaLines,
    new Paragraph({ text: "" }),
    ...stageRows,
    new Paragraph({
      text: "Developer agent output",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 240, after: 120 },
    }),
    ...paragraphsFromStructuredOutput(run.devOutput, "No developer output recorded."),
    new Paragraph({
      text: "Project manager agent output",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 240, after: 120 },
    }),
    ...paragraphsFromStructuredOutput(run.pmOutput, "No PM output recorded."),
    new Paragraph({
      text: "Merged report",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 240, after: 120 },
    }),
    ...paragraphsFromStructuredOutput(run.mergedReport, "No merged report recorded."),
  ];

  const doc = new Document({
    creator: "BRS Agent Panel",
    title: `BRS output — ${id}`,
    description: "Exported pipeline results",
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

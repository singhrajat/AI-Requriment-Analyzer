import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { getRecursiveChunkConfig } from "../config/modelConfig";

export type BrsTextChunk = {
  text: string;
  index: number;
  sectionNumber?: string;
  sectionTitle?: string;
  headingPath?: string[];
  partIndex?: number;
  partCount?: number;
};

/**
 * LangChain hierarchical splitting: try larger separators first, then smaller ones.
 */
export async function splitBrsDocumentText(text: string): Promise<BrsTextChunk[]> {
  const { chunkSize, chunkOverlap } = getRecursiveChunkConfig();
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ["\n\n\n", "\n\n", "\n", ". ", " ", ""],
  });
  const parts = await splitter.splitText(text);
  const out: BrsTextChunk[] = [];
  let i = 0;
  for (const p of parts) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    out.push({ text: trimmed, index: i++ });
  }
  return out;
}

type DetectedSection = {
  sectionNumber: string;
  title: string;
  headingLine: string;
  body: string;
  level: number;
};

function detectNumberedSections(text: string): DetectedSection[] {
  const lines = text.split(/\r?\n/);
  const headingRe = /^\s*(\d+(?:\.\d+)*)\.\s+(.+?)\s*$/;

  const headings: Array<{ lineIndex: number; sectionNumber: string; title: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.match(headingRe);
    if (!m) continue;
    const sectionNumber = m[1]!;
    const title = m[2]!;
    headings.push({ lineIndex: i, sectionNumber, title });
  }

  if (headings.length === 0) return [];

  const sections: DetectedSection[] = [];
  for (let h = 0; h < headings.length; h++) {
    const cur = headings[h]!;
    const next = headings[h + 1];
    const bodyLines = lines.slice(cur.lineIndex + 1, next ? next.lineIndex : lines.length);
    const body = bodyLines.join("\n").trim();
    const headingLine = `${cur.sectionNumber}. ${cur.title}`.trim();
    const level = cur.sectionNumber.split(".").length;
    sections.push({
      sectionNumber: cur.sectionNumber,
      title: cur.title,
      headingLine,
      body,
      level,
    });
  }

  return sections;
}

/**
 * Two-stage chunking:
 * 1) Split by numbered headings like "1. Title", "3.2. Title"
 * 2) Within each section, apply recursive character chunking to enforce size limits.
 *
 * If no headings are detected, falls back to `splitBrsDocumentText`.
 */
export async function splitBrsDocumentTextSectionWise(text: string): Promise<BrsTextChunk[]> {
  const sections = detectNumberedSections(text);
  if (sections.length === 0) {
    return splitBrsDocumentText(text);
  }

  const { chunkSize, chunkOverlap } = getRecursiveChunkConfig();
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ["\n\n\n", "\n\n", "\n", ". ", " ", ""],
  });

  const out: BrsTextChunk[] = [];
  let globalIndex = 0;

  for (const s of sections) {
    const body = (s.body ?? "").trim();
    const headingPath = [s.headingLine];

    // Keep a section header even if body is empty.
    if (!body) {
      out.push({
        index: globalIndex++,
        text: s.headingLine,
        sectionNumber: s.sectionNumber,
        sectionTitle: s.title,
        headingPath,
        partIndex: 1,
        partCount: 1,
      });
      continue;
    }

    const parts = await splitter.splitText(body);
    const trimmedParts = parts.map((p) => p.trim()).filter(Boolean);
    const partCount = Math.max(1, trimmedParts.length);

    for (let i = 0; i < trimmedParts.length; i++) {
      const part = trimmedParts[i]!;
      out.push({
        index: globalIndex++,
        text: `${s.headingLine}\n${part}`.trim(),
        sectionNumber: s.sectionNumber,
        sectionTitle: s.title,
        headingPath,
        partIndex: i + 1,
        partCount,
      });
    }
  }

  return out;
}

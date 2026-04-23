import { countTokens } from "./tokenCounter";

export interface DocumentChunk {
  text: string;
  sectionIndex: number;
  tokenCount: number;
  /** Character offsets into the original document text (end-exclusive). */
  charStart: number;
  charEnd: number;
}

/**
 * Default max tokens per chunk. Keeps well under typical context windows
 * while leaving room for prompts and completion.
 */
const DEFAULT_CHUNK_TOKEN_LIMIT = 1500;

/**
 * Regex patterns for common BRS section headers:
 *   1. Introduction / 1.1 Scope / Section 1: …
 *   All-caps headings like "FUNCTIONAL REQUIREMENTS"
 *   Markdown-style headings: ## Heading
 */
const SECTION_HEADER_RE =
  /^(?:(?:\d+(?:\.\d+)*\.?\s+[A-Z].+)|(?:[A-Z][A-Z\s]{3,})|(?:#{1,3}\s+.+))$/m;

/**
 * Split document text into section-aware chunks.
 *
 * Strategy:
 * 1. Split on section headers (numbered / all-caps / markdown headings).
 * 2. If a section still exceeds `chunkTokenLimit`, further split it on
 *    paragraph boundaries (double newline).
 * 3. Return each chunk with its sequential index and token count.
 */
export function chunkDocumentText(
  text: string,
  chunkTokenLimit = DEFAULT_CHUNK_TOKEN_LIMIT
): DocumentChunk[] {
  const rawSections = splitOnSectionHeadersWithOffsets(text);
  const chunks: DocumentChunk[] = [];
  let sectionIndex = 0;

  for (const section of rawSections) {
    const trimmed = section.text.trim();
    if (!trimmed) continue;

    if (countTokens(trimmed) <= chunkTokenLimit) {
      const { charStart, charEnd } = trimOffsets(section.text, section.charStart);
      chunks.push({
        text: trimmed,
        sectionIndex,
        tokenCount: countTokens(trimmed),
        charStart,
        charEnd,
      });
      sectionIndex++;
    } else {
      // Further split on paragraphs
      const subChunks = splitOnParagraphsWithOffsets(section.text, section.charStart, chunkTokenLimit);
      for (const sub of subChunks) {
        const subTrimmed = sub.text.trim();
        if (!subTrimmed) continue;
        const { charStart, charEnd } = trimOffsets(sub.text, sub.charStart);
        chunks.push({
          text: subTrimmed,
          sectionIndex,
          tokenCount: countTokens(subTrimmed),
          charStart,
          charEnd,
        });
        sectionIndex++;
      }
    }
  }

  return chunks;
}

type TextSlice = { text: string; charStart: number; charEnd: number };

function splitOnSectionHeadersWithOffsets(text: string): TextSlice[] {
  const lines = text.split("\n");
  const sections: TextSlice[] = [];
  let current: string[] = [];
  let currentStart = 0;
  let cursor = 0;

  for (const line of lines) {
    const lineWithNewlineLen = line.length + 1; // +1 for '\n' (except last line; handled by join)
    if (SECTION_HEADER_RE.test(line.trim()) && current.length > 0) {
      const sectionText = current.join("\n");
      const sectionEnd = currentStart + sectionText.length;
      sections.push({ text: sectionText, charStart: currentStart, charEnd: sectionEnd });
      current = [line];
      currentStart = cursor;
    } else {
      current.push(line);
    }
    cursor += lineWithNewlineLen;
  }

  if (current.length > 0) {
    const sectionText = current.join("\n");
    const sectionEnd = currentStart + sectionText.length;
    sections.push({ text: sectionText, charStart: currentStart, charEnd: sectionEnd });
  }
  return sections;
}

function splitOnParagraphsWithOffsets(text: string, baseCharStart: number, tokenLimit: number): TextSlice[] {
  const paragraphs = text.split(/\n\n+/);
  const result: TextSlice[] = [];
  let buffer = "";
  let bufferStart = baseCharStart;
  let searchFrom = 0;
  let bufferStartInSection = 0;

  for (const para of paragraphs) {
    const paraPos = text.indexOf(para, searchFrom);
    const paraStartInSection = paraPos >= 0 ? paraPos : searchFrom;
    const paraStartAbs = baseCharStart + paraStartInSection;

    const candidate = buffer ? `${buffer}\n\n${para}` : para;
    if (countTokens(candidate) <= tokenLimit) {
      if (!buffer) {
        bufferStart = paraStartAbs;
        bufferStartInSection = paraStartInSection;
      }
      buffer = candidate;
    } else {
      if (buffer) {
        result.push({ text: buffer, charStart: bufferStart, charEnd: bufferStart + buffer.length });
      }
      // If a single paragraph exceeds the limit, hard-split by sentences
      if (countTokens(para) > tokenLimit) {
        result.push(...hardSplitWithOffsets(para, paraStartAbs, tokenLimit));
        buffer = "";
      } else {
        bufferStart = paraStartAbs;
        bufferStartInSection = paraStartInSection;
        buffer = para;
      }
    }
    searchFrom = paraPos >= 0 ? paraPos + para.length : searchFrom + para.length;
  }

  if (buffer) {
    result.push({ text: buffer, charStart: bufferStart, charEnd: bufferStart + buffer.length });
  }
  return result;
}

function hardSplitWithOffsets(text: string, baseCharStart: number, tokenLimit: number): TextSlice[] {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const result: TextSlice[] = [];
  let buffer = "";
  let bufferStart = baseCharStart;
  let searchFrom = 0;

  for (const sentence of sentences) {
    const sentencePos = text.indexOf(sentence, searchFrom);
    const sentenceStartAbs = baseCharStart + (sentencePos >= 0 ? sentencePos : searchFrom);

    const candidate = buffer ? `${buffer} ${sentence}` : sentence;
    if (countTokens(candidate) <= tokenLimit) {
      if (!buffer) bufferStart = sentenceStartAbs;
      buffer = candidate;
    } else {
      if (buffer) {
        result.push({ text: buffer, charStart: bufferStart, charEnd: bufferStart + buffer.length });
      }
      buffer = sentence;
      bufferStart = sentenceStartAbs;
    }
    searchFrom = sentencePos >= 0 ? sentencePos + sentence.length : searchFrom + sentence.length;
  }

  if (buffer) {
    result.push({ text: buffer, charStart: bufferStart, charEnd: bufferStart + buffer.length });
  }
  return result;
}

function trimOffsets(original: string, baseCharStart: number): { charStart: number; charEnd: number } {
  let start = 0;
  let end = original.length;
  while (start < end && /\s/.test(original[start])) start++;
  while (end > start && /\s/.test(original[end - 1])) end--;
  return { charStart: baseCharStart + start, charEnd: baseCharStart + end };
}

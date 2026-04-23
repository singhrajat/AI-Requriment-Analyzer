// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse") as (buffer: Buffer) => Promise<{ text: string }>;
import mammoth from "mammoth";

export type SupportedMime =
  | "application/pdf"
  | "text/plain"
  | "application/msword"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Extract plain text from an uploaded file buffer.
 * Supports PDF, plain text, DOC, and DOCX.
 */
export async function extractDocumentText(
  buffer: Buffer,
  mimetype: string
): Promise<string> {
  switch (mimetype) {
    case "application/pdf": {
      const result = await pdfParse(buffer);
      return result.text;
    }
    case "text/plain":
      return buffer.toString("utf-8");
    case "application/msword":
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    default:
      throw new Error(`Unsupported file type: ${mimetype}`);
  }
}

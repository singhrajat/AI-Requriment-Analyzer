import { HeadingLevel, Paragraph, TextRun } from "docx";
import { formatJsonLikeOutput, parseJsonLikeOutput } from "../utils/parseJsonLikeOutput";

const MAX_LINE = 8000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatPrimitive(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.trim() || "—";
  return String(v);
}

function isMergedReport(data: unknown): boolean {
  if (!isRecord(data)) return false;
  const hasSummary = typeof data.summary === "string";
  const hasNested =
    isRecord(data.developerAnalysis) ||
    isRecord(data.pmAnalysis) ||
    Array.isArray(data.criticalActions);
  return hasSummary && hasNested;
}

function isDevChecklistObject(data: unknown): boolean {
  if (!isRecord(data)) return false;
  if (isMergedReport(data)) return false;
  const keys = ["validations", "error_handling", "security", "edge_cases"];
  return keys.some((k) => k in data);
}

function pushChunkedLine(out: Paragraph[], line: string): void {
  if (line.length <= MAX_LINE) {
    out.push(new Paragraph({ children: [new TextRun(line || " ")] }));
    return;
  }
  for (let i = 0; i < line.length; i += MAX_LINE) {
    out.push(new Paragraph({ children: [new TextRun(line.slice(i, i + MAX_LINE))] }));
  }
}

/** Plain multi-line text (fallback when output is not JSON). */
function paragraphsFromPlainText(text: string, emptyLabel: string): Paragraph[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [
      new Paragraph({
        children: [new TextRun({ text: emptyLabel, italics: true })],
      }),
    ];
  }
  const lines = trimmed.split(/\r?\n/);
  const out: Paragraph[] = [];
  for (const line of lines) {
    pushChunkedLine(out, line);
  }
  return out;
}

function pSpace(): Paragraph {
  return new Paragraph({ text: "" });
}

function pLabel(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 160, after: 60 },
    children: [new TextRun({ text, bold: true })],
  });
}

function pSubheading(text: string): Paragraph {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 80 },
  });
}

function pBody(text: string, opts?: { spacing?: { before?: number; after?: number } }): Paragraph {
  return new Paragraph({
    spacing: opts?.spacing ?? { after: 100 },
    children: [new TextRun(text)],
  });
}

function pBullet(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 60 },
    indent: { left: 360, hanging: 200 },
    children: [new TextRun({ text: "• " }), new TextRun(text)],
  });
}

function pNumbered(index: number, text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 60 },
    indent: { left: 360, hanging: 200 },
    children: [new TextRun(`${index}. ${text}`)],
  });
}

function ruleFieldsRuns(rule: Record<string, unknown>): TextRun[] {
  const entries = Object.entries(rule).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return [new TextRun("—")];
  const field = typeof rule.field === "string" ? rule.field : null;
  const rest = entries.filter(([k]) => k !== "field");
  const runs: TextRun[] = [];
  if (field) {
    runs.push(new TextRun({ text: field, bold: true }));
  }
  if (field && rest.length > 0) {
    runs.push(new TextRun(" — "));
  }
  rest.forEach(([k, v], i) => {
    if (i > 0) runs.push(new TextRun(" · "));
    runs.push(new TextRun({ text: `${humanizeKey(k)}: `, bold: true }));
    runs.push(new TextRun(formatPrimitive(v)));
  });
  return runs;
}

function paragraphsFromValidationItem(item: Record<string, unknown>): Paragraph[] {
  const out: Paragraph[] = [];
  const req = typeof item.requirement === "string" ? item.requirement : null;
  if (req) {
    out.push(
      new Paragraph({
        spacing: { before: 80, after: 60 },
        children: [new TextRun({ text: req, bold: true })],
      })
    );
  }
  const rules = Array.isArray(item.validation_rules) ? item.validation_rules : [];
  for (const rule of rules) {
    if (isRecord(rule)) {
      out.push(new Paragraph({ spacing: { after: 40 }, children: ruleFieldsRuns(rule) }));
    } else {
      out.push(pBullet(formatPrimitive(rule)));
    }
  }
  const missing = typeof item.missing_criteria === "string" ? item.missing_criteria.trim() : "";
  if (missing) {
    out.push(
      new Paragraph({
        spacing: { before: 40, after: 80 },
        children: [
          new TextRun({ text: "Gaps: ", bold: true }),
          new TextRun(missing),
        ],
      })
    );
  }
  return out;
}

const SECTION_ORDER = [
  "validations",
  "error_handling",
  "security",
  "edge_cases",
  "risks",
  "failure_points",
  "timeline_risks",
  "escalation_paths",
];

function sortSectionKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const ia = SECTION_ORDER.indexOf(a);
    const ib = SECTION_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function paragraphsFromChecklistRecord(data: Record<string, unknown>): Paragraph[] {
  const out: Paragraph[] = [];
  for (const key of sortSectionKeys(Object.keys(data))) {
    out.push(pLabel(humanizeKey(key).toUpperCase()));
    out.push(...paragraphsFromValue(data[key], 0));
  }
  return out;
}

function paragraphsFromObjectDl(obj: Record<string, unknown>, depth: number): Paragraph[] {
  const out: Paragraph[] = [];
  for (const [k, v] of Object.entries(obj)) {
    out.push(
      new Paragraph({
        spacing: { before: 80, after: 40 },
        children: [new TextRun({ text: humanizeKey(k), bold: true })],
      })
    );
    out.push(...paragraphsFromValue(v, depth));
  }
  return out;
}

function paragraphsFromValue(value: unknown, depth: number): Paragraph[] {
  if (value === null || value === undefined) {
    return [pBody("—", { spacing: { after: 60 } })];
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [pBody(formatPrimitive(value))];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [pBody("None noted", { spacing: { after: 60 } })];
    }
    const allPrimitive = value.every(
      (x) => x === null || ["string", "number", "boolean"].includes(typeof x)
    );
    if (allPrimitive) {
      const out: Paragraph[] = [];
      for (const x of value) {
        out.push(pBullet(formatPrimitive(x)));
      }
      return out;
    }
    const validationsShape =
      value.length > 0 &&
      value.every((x) => isRecord(x) && ("requirement" in x || "validation_rules" in x));
    if (validationsShape && depth <= 2) {
      const out: Paragraph[] = [];
      for (const x of value) {
        if (isRecord(x)) out.push(...paragraphsFromValidationItem(x));
      }
      return out;
    }
    const out: Paragraph[] = [];
    for (const x of value) {
      if (isRecord(x)) {
        out.push(...paragraphsFromObjectCard(x, depth + 1));
      } else {
        out.push(...paragraphsFromValue(x, depth + 1));
      }
    }
    return out;
  }
  if (isRecord(value)) {
    if (depth >= 4) {
      return [
        new Paragraph({
          spacing: { after: 80 },
          children: [new TextRun({ text: JSON.stringify(value), font: "Courier New" })],
        }),
      ];
    }
    return paragraphsFromObjectCard(value, depth + 1);
  }
  return [pBody(String(value))];
}

function paragraphsFromObjectCard(obj: Record<string, unknown>, depth: number): Paragraph[] {
  return paragraphsFromObjectDl(obj, depth);
}

function paragraphsFromGenericRecord(data: Record<string, unknown>): Paragraph[] {
  if (isDevChecklistObject(data)) {
    return paragraphsFromChecklistRecord(data);
  }
  return paragraphsFromObjectDl(data, 0);
}

function paragraphsFromMergedReport(data: Record<string, unknown>): Paragraph[] {
  const out: Paragraph[] = [];
  const summary = typeof data.summary === "string" ? data.summary : "";
  if (summary) {
    out.push(pLabel("EXECUTIVE SUMMARY"));
    out.push(pBody(summary));
  }
  const risk = typeof data.overallRiskLevel === "string" ? data.overallRiskLevel : null;
  if (risk) {
    out.push(pSpace());
    out.push(
      new Paragraph({
        spacing: { after: 80 },
        children: [
          new TextRun({ text: "Overall risk: ", bold: true }),
          new TextRun(humanizeKey(risk)),
        ],
      })
    );
  }
  const critical = Array.isArray(data.criticalActions) ? data.criticalActions : [];
  if (critical.length > 0) {
    out.push(pLabel("CRITICAL ACTIONS"));
    critical.forEach((item, i) => {
      out.push(pNumbered(i + 1, formatPrimitive(item)));
    });
  }
  const dev = isRecord(data.developerAnalysis) ? data.developerAnalysis : null;
  if (dev && Object.keys(dev).length > 0) {
    out.push(pSubheading("Developer analysis"));
    out.push(...paragraphsFromChecklistRecord(dev));
  }
  const pm = isRecord(data.pmAnalysis) ? data.pmAnalysis : null;
  if (pm && Object.keys(pm).length > 0) {
    out.push(pSubheading("Project manager analysis"));
    out.push(...paragraphsFromChecklistRecord(pm));
  }
  return out;
}

/**
 * Same logical structure as the frontend StructuredOutputView: readable sections when JSON parses;
 * otherwise pretty-printed JSON as plain paragraphs.
 */
export function paragraphsFromStructuredOutput(
  text: string | undefined,
  emptyLabel: string
): Paragraph[] {
  const trimmed = text?.trim();
  if (!trimmed) {
    return [
      new Paragraph({
        children: [new TextRun({ text: emptyLabel, italics: true })],
      }),
    ];
  }

  const parsed = parseJsonLikeOutput(trimmed);
  if (parsed === null) {
    return paragraphsFromPlainText(formatJsonLikeOutput(trimmed), emptyLabel);
  }

  if (Array.isArray(parsed)) {
    return paragraphsFromValue(parsed, 0);
  }

  if (isRecord(parsed)) {
    if (isMergedReport(parsed)) {
      return paragraphsFromMergedReport(parsed);
    }
    return paragraphsFromGenericRecord(parsed);
  }

  return [pBody(formatPrimitive(parsed))];
}

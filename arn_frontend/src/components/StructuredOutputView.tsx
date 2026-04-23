import { formatJsonLikeOutput, parseJsonLikeOutput } from "../utils/formatJsonLikeOutput";

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

function MergedReportBody({ data }: { data: Record<string, unknown> }) {
  const summary = typeof data.summary === "string" ? data.summary : "";
  const risk = typeof data.overallRiskLevel === "string" ? data.overallRiskLevel : null;
  const critical = Array.isArray(data.criticalActions) ? data.criticalActions : [];
  const dev = isRecord(data.developerAnalysis) ? data.developerAnalysis : null;
  const pm = isRecord(data.pmAnalysis) ? data.pmAnalysis : null;

  return (
    <div className="structured-output structured-output--merged">
      {summary ? (
        <div className="structured-block structured-block--lead">
          <div className="structured-label">Executive summary</div>
          <p className="structured-text">{summary}</p>
        </div>
      ) : null}
      {risk ? (
        <div className="structured-inline-meta">
          <span className="structured-label">Overall risk</span>
          <span className={`structured-risk structured-risk--${risk}`}>{humanizeKey(risk)}</span>
        </div>
      ) : null}
      {critical.length > 0 ? (
        <div className="structured-block">
          <div className="structured-label">Critical actions</div>
          <ol className="structured-ol">
            {critical.map((item, i) => (
              <li key={i} className="structured-text">
                {formatPrimitive(item)}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {dev ? (
        <div className="structured-block">
          <div className="structured-subhead">Developer analysis</div>
          <ChecklistSections data={dev} />
        </div>
      ) : null}
      {pm ? (
        <div className="structured-block">
          <div className="structured-subhead">Project manager analysis</div>
          <ChecklistSections data={pm} />
        </div>
      ) : null}
    </div>
  );
}

function ChecklistSections({ data }: { data: Record<string, unknown> }) {
  const sectionOrder = ["validations", "error_handling", "security", "edge_cases", "risks", "failure_points", "timeline_risks", "escalation_paths"];
  const keys = Object.keys(data).sort((a, b) => {
    const ia = sectionOrder.indexOf(a);
    const ib = sectionOrder.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  return (
    <>
        {keys.map((key) => (
        <div key={key} className="structured-block structured-block--nested">
          <div className="structured-label">{humanizeKey(key)}</div>
          <ValueBlock value={data[key]} depth={0} />
        </div>
      ))}
    </>
  );
}

function ValidationItem({ item }: { item: Record<string, unknown> }) {
  const req = typeof item.requirement === "string" ? item.requirement : null;
  const rules = Array.isArray(item.validation_rules) ? item.validation_rules : [];
  const missing = typeof item.missing_criteria === "string" ? item.missing_criteria : "";

  return (
    <div className="structured-validation">
      {req ? <p className="structured-validation__req">{req}</p> : null}
      {rules.length > 0 ? (
        <ul className="structured-validation__rules">
          {rules.map((rule, i) =>
            isRecord(rule) ? (
              <li key={i}>
                <RuleFields rule={rule} />
              </li>
            ) : (
              <li key={i}>{formatPrimitive(rule)}</li>
            )
          )}
        </ul>
      ) : null}
      {missing ? (
        <p className="structured-validation__missing">
          <span className="structured-label structured-label--inline">Gaps</span> {missing}
        </p>
      ) : null}
    </div>
  );
}

function RuleFields({ rule }: { rule: Record<string, unknown> }) {
  const entries = Object.entries(rule).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return null;
  const field = typeof rule.field === "string" ? rule.field : null;
  const rest = entries.filter(([k]) => k !== "field");
  return (
    <span className="structured-rule">
      {field ? <strong className="structured-rule__field">{field}</strong> : null}
      {field && rest.length > 0 ? <span className="structured-rule__sep"> — </span> : null}
      {rest.map(([k, v], i) => (
        <span key={k} className="structured-rule__kv">
          {i > 0 ? <span className="structured-rule__sep"> · </span> : null}
          <span className="structured-rule__k">{humanizeKey(k)}:</span>{" "}
          <span className="structured-rule__v">{formatPrimitive(v)}</span>
        </span>
      ))}
    </span>
  );
}

function ObjectCard({ obj, depth = 0 }: { obj: Record<string, unknown>; depth?: number }) {
  const entries = Object.entries(obj);
  return (
    <div className="structured-card">
      <dl className="structured-dl">
        {entries.map(([k, v]) => (
          <div key={k} className="structured-dl__row">
            <dt>{humanizeKey(k)}</dt>
            <dd>
              <ValueBlock value={v} depth={depth} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ValueBlock({ value, depth }: { value: unknown; depth: number }) {
  if (value === null || value === undefined) {
    return <span className="structured-muted">—</span>;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <span className="structured-text">{formatPrimitive(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="structured-muted">None noted</span>;
    }
    const allPrimitive = value.every(
      (x) => x === null || ["string", "number", "boolean"].includes(typeof x)
    );
    if (allPrimitive) {
      return (
        <ul className="structured-ul structured-ul--tight">
          {value.map((x, i) => (
            <li key={i} className="structured-text">
              {formatPrimitive(x)}
            </li>
          ))}
        </ul>
      );
    }
    const validationsShape =
      value.length > 0 &&
      value.every((x) => isRecord(x) && ("requirement" in x || "validation_rules" in x));
    if (validationsShape && depth <= 2) {
      return (
        <div className="structured-stack">
          {value.map((x, i) => (isRecord(x) ? <ValidationItem key={i} item={x} /> : null))}
        </div>
      );
    }
    return (
      <div className="structured-stack">
        {value.map((x, i) =>
          isRecord(x) ? (
            <ObjectCard key={i} obj={x} depth={depth + 1} />
          ) : (
            <div key={i} className="structured-text">
              <ValueBlock value={x} depth={depth + 1} />
            </div>
          )
        )}
      </div>
    );
  }
  if (isRecord(value)) {
    if (depth >= 4) {
      return <span className="structured-text structured-text--mono">{JSON.stringify(value)}</span>;
    }
    return <ObjectCard obj={value} depth={depth + 1} />;
  }
  return <span className="structured-text">{String(value)}</span>;
}

function GenericObjectBody({ data }: { data: Record<string, unknown> }) {
  if (isDevChecklistObject(data)) {
    return (
      <div className="structured-output">
        <ChecklistSections data={data} />
      </div>
    );
  }
  return (
    <div className="structured-output">
      <ObjectCard obj={data} />
    </div>
  );
}

export interface StructuredOutputViewProps {
  raw: string;
  className?: string;
}

/**
 * Renders model output as readable sections when JSON parses; otherwise pretty-printed JSON in a pre.
 */
export function StructuredOutputView({ raw, className = "" }: StructuredOutputViewProps) {
  const parsed = parseJsonLikeOutput(raw);
  const wrapClass = ["structured-output-wrap", className].filter(Boolean).join(" ");

  if (parsed === null) {
    return (
      <pre className={`agent-output agent-output--raw ${wrapClass}`.trim()}>
        {formatJsonLikeOutput(raw)}
      </pre>
    );
  }

  if (Array.isArray(parsed)) {
    return (
      <div className={wrapClass}>
        <div className="structured-output">
          <ValueBlock value={parsed} depth={0} />
        </div>
      </div>
    );
  }

  if (isRecord(parsed)) {
    if (isMergedReport(parsed)) {
      return (
        <div className={wrapClass}>
          <MergedReportBody data={parsed} />
        </div>
      );
    }
    return (
      <div className={wrapClass}>
        <GenericObjectBody data={parsed} />
      </div>
    );
  }

  return (
    <div className={wrapClass}>
      <p className="structured-text">{formatPrimitive(parsed)}</p>
    </div>
  );
}

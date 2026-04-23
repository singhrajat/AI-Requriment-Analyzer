import type { BrsRun } from "../api/brs";

function parseLatestReviewSummary(run: BrsRun): {
  dev: number;
  pm: number;
  overall: number;
  ready: boolean | null;
} | null {
  const entries = run.review_outputs ?? [];
  if (entries.length === 0) return null;
  const last = entries[entries.length - 1];
  try {
    const raw = last.output.trim();
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]+?)```/);
    const body = jsonMatch ? jsonMatch[1] : raw;
    const parsed = JSON.parse(body) as {
      summary?: {
        dev_confidence?: number;
        pm_confidence?: number;
        overall_system_confidence?: number;
        ready_for_merge?: boolean;
      };
    };
    const s = parsed.summary;
    if (!s) return null;
    return {
      dev: Math.round(Number(s.dev_confidence ?? 0)),
      pm: Math.round(Number(s.pm_confidence ?? 0)),
      overall: Math.round(Number(s.overall_system_confidence ?? 0)),
      ready: typeof s.ready_for_merge === "boolean" ? s.ready_for_merge : null,
    };
  } catch {
    return null;
  }
}

export interface ReviewerSummaryCardProps {
  run: BrsRun;
}

export function ReviewerSummaryCard({ run }: ReviewerSummaryCardProps) {
  const reviewStatus = run.stages.review ?? "pending";
  const summary = parseLatestReviewSummary(run);

  return (
    <section className="output-card" aria-label="Reviewer summary">
      <div className="output-header">
        <div className="output-title">Reviewer</div>
        <span className={`output-badge output-badge--${reviewStatus === "done" ? "green" : reviewStatus === "running" ? "purple" : "muted"}`}>
          {reviewStatus === "done" ? "complete" : reviewStatus === "running" ? "running" : "waiting"}
        </span>
      </div>
      {summary ? (
        <dl className="reviewer-confidence-grid">
          <div>
            <dt>Dev confidence</dt>
            <dd>{summary.dev}</dd>
          </div>
          <div>
            <dt>PM confidence</dt>
            <dd>{summary.pm}</dd>
          </div>
          <div>
            <dt>Overall system confidence</dt>
            <dd>{summary.overall}</dd>
          </div>
          {summary.ready !== null ? (
            <div className="reviewer-confidence-grid__full">
              <dt>Ready for merge</dt>
              <dd>{summary.ready ? "Yes" : "No"}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="card__desc">Scores appear after the reviewer step completes.</p>
      )}
    </section>
  );
}

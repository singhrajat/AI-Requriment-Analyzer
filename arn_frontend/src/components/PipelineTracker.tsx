import type { StageStatus } from "../api/brs";

function pipeStatusClass(status: StageStatus): "done" | "running" | "waiting" | "error" | "attention" {
  switch (status) {
    case "done":
      return "done";
    case "running":
      return "running";
    case "error":
      return "error";
    default:
      return "waiting";
  }
}

function stageLabel(status: StageStatus): string {
  switch (status) {
    case "done":
      return "complete";
    case "running":
      return "running";
    case "error":
      return "error";
    default:
      return "waiting";
  }
}

export interface PipelineTrackerProps {
  fetchStatus?: StageStatus;
  devStatus?: StageStatus;
  pmStatus?: StageStatus;
  reviewStatus?: StageStatus;
  mergeStatus?: StageStatus;
  /** When true, merge step finished but the user must save or discard (escalated path). */
  mergeAwaitingUser?: boolean;
  inputSizeClass?: "small" | "large";
  chunkCount?: number;
  runLabel?: string;
}

export function PipelineTracker({
  fetchStatus = "pending",
  devStatus = "pending",
  pmStatus = "pending",
  reviewStatus = "pending",
  mergeStatus = "pending",
  mergeAwaitingUser = false,
  inputSizeClass,
  chunkCount,
  runLabel,
}: PipelineTrackerProps) {
  const parallelStatus: StageStatus =
    devStatus === "running" || pmStatus === "running"
      ? "running"
      : devStatus === "error" || pmStatus === "error"
        ? "error"
        : devStatus === "done" && pmStatus === "done"
          ? "done"
          : "pending";

  const mergePipeClass = mergeAwaitingUser ? "attention" : pipeStatusClass(mergeStatus);
  const mergePipeLabel = mergeAwaitingUser ? "needs approval" : stageLabel(mergeStatus);

  const sublabel =
    inputSizeClass === "large" && chunkCount != null
      ? `${chunkCount} sections — chunk merge ok`
      : inputSizeClass
        ? `${inputSizeClass} input`
        : null;

  return (
    <section className="section-block">
      <h3 className="section-label">
        Pipeline
        {runLabel ? <span className="section-label__suffix"> — {runLabel}</span> : null}
      </h3>
      {sublabel ? <p className="pipeline-sublabel">{sublabel}</p> : null}
      <div className="pipeline-row pipeline-row--with-review">
        <article className="pipe-card">
          <div className="pipe-icon pipe-icon--purple" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="12" height="12" rx="3" stroke="#534AB7" strokeWidth="1.2" />
              <path d="M4 7h6M4 4.5h6M4 9.5h4" stroke="#534AB7" strokeWidth="1" strokeLinecap="round" />
            </svg>
          </div>
          <div className="pipe-name">Fetch agent</div>
          <div className="pipe-desc">Reads &amp; extracts BRS context</div>
          <div className={`pipe-status pipe-status--${pipeStatusClass(fetchStatus)}`}>
            ● {stageLabel(fetchStatus)}
          </div>
        </article>

        <div className="arrow-col" aria-hidden>
          ›
        </div>

        <article className="pipe-card">
          <div className="pipe-icon pipe-icon--teal" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="5.5" stroke="#1D9E75" strokeWidth="1.2" />
              <path d="M5 7l1.5 1.5L9 5" stroke="#1D9E75" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="pipe-name">Parallel agents</div>
          <div className="pipe-desc">Dev + PM running in parallel</div>
          <div className={`pipe-status pipe-status--${pipeStatusClass(parallelStatus)}`}>
            ● {stageLabel(parallelStatus)}
          </div>
        </article>

        <div className="arrow-col" aria-hidden>
          ›
        </div>

        <article className="pipe-card">
          <div className="pipe-icon pipe-icon--purple" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 11V4l4-2 4 2v7" stroke="#534AB7" strokeWidth="1.2" strokeLinejoin="round" />
              <path d="M7 6v3" stroke="#534AB7" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </div>
          <div className="pipe-name">Reviewer</div>
          <div className="pipe-desc">Quality gate on dev + PM outputs</div>
          <div className={`pipe-status pipe-status--${pipeStatusClass(reviewStatus)}`}>
            ● {stageLabel(reviewStatus)}
          </div>
        </article>

        <div className="arrow-col" aria-hidden>
          ›
        </div>

        <article className="pipe-card">
          <div className="pipe-icon pipe-icon--coral" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 11L7 3l5 8H2z" stroke="#D85A30" strokeWidth="1.2" strokeLinejoin="round" />
              <path d="M7 7v2" stroke="#D85A30" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </div>
          <div className="pipe-name">Merged report</div>
          <div className="pipe-desc">Dev specs + risk analysis</div>
          <div className={`pipe-status pipe-status--${mergePipeClass}`}>● {mergePipeLabel}</div>
        </article>
      </div>
    </section>
  );
}

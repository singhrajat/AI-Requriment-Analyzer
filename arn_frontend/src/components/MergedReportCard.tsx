import type { StageStatus } from "../api/brs";
import { StructuredOutputView } from "./StructuredOutputView";

function statusLabel(s: StageStatus): string {
  switch (s) {
    case "done":
      return "ready";
    case "running":
      return "merging";
    case "error":
      return "error";
    default:
      return "pending";
  }
}

function statusBadgeClass(s: StageStatus): "muted" | "purple" | "green" | "coral" {
  switch (s) {
    case "done":
      return "green";
    case "running":
      return "purple";
    case "error":
      return "coral";
    default:
      return "muted";
  }
}

export interface MergedReportCardProps {
  mergeStatus?: StageStatus;
  mergedReport?: string;
  awaitingUserDecision?: boolean;
  mergeSource?: string;
}

export function MergedReportCard({
  mergeStatus = "pending",
  mergedReport,
  awaitingUserDecision = false,
  mergeSource,
}: MergedReportCardProps) {
  const badgeClass =
    awaitingUserDecision && mergeStatus === "done" ? "coral" : statusBadgeClass(mergeStatus);
  const badgeLabel =
    awaitingUserDecision && mergeStatus === "done" ? "awaiting approval" : statusLabel(mergeStatus);

  return (
    <section className="output-card" aria-label="Merged output report">
      <div className="output-header">
        <div className="output-title">Merged output report</div>
        <span className={`output-badge output-badge--${badgeClass}`}>
          {badgeLabel}
        </span>
      </div>
      {awaitingUserDecision && mergedReport ? (
        <p className="merge-decision-banner" role="status">
          This merge was produced after the maximum automated review retries. Save to accept it as final, or discard
          to clear it and mark the run for human follow-up.
          {mergeSource === "escalated_after_max_retries" ? " (Escalated merge.)" : null}
        </p>
      ) : null}
      {mergeStatus === "done" && mergedReport ? (
        <StructuredOutputView raw={mergedReport} className="merged-report-output merged-report-output--structured" />
      ) : (
        <div className="output-cols">
          <div className="output-col">
            <div className="output-col-title">Dev specs</div>
            <div className="output-line" style={{ width: "90%" }} />
            <div className="output-line" style={{ width: "75%" }} />
            <div className="output-line" style={{ width: "60%" }} />
          </div>
          <div className="output-col">
            <div className="output-col-title">Risk analysis</div>
            <div className="output-line" style={{ width: "85%" }} />
            <div className="output-line" style={{ width: "70%" }} />
            <div className="output-line" style={{ width: "50%" }} />
          </div>
        </div>
      )}
    </section>
  );
}

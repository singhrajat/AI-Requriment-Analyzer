import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { deleteRun, downloadRunDocx, getRun, postRunControl, postRunDecision } from "../api/brs";
import type { BrsRun } from "../api/brs";
import { PipelineTracker } from "../components/PipelineTracker";
import { AgentOutputsGrid } from "../components/AgentOutputsGrid";
import { MergedReportCard } from "../components/MergedReportCard";
import { ReviewerSummaryCard } from "../components/ReviewerSummaryCard";

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

export function SubmissionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<BrsRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveDisconnected, setLiveDisconnected] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [controlBusy, setControlBusy] = useState<"stop" | "resume" | "discard" | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!id) return;
    const runId = id;

    setError(null);
    setLiveDisconnected(false);

    if (sourceRef.current) sourceRef.current.close();

    const source = new EventSource(`${BASE_URL}/api/brs/runs/${encodeURIComponent(runId)}/stream`);
    sourceRef.current = source;

    source.addEventListener("run", (evt) => {
      try {
        const data = JSON.parse((evt as MessageEvent).data) as BrsRun;
        setRun(data);
        setLiveDisconnected(false);
      } catch {
        setError("Failed to parse live update.");
      }
    });

    source.addEventListener("end", () => {
      source.close();
    });

    source.onerror = async () => {
      setLiveDisconnected(true);
      source.close();
      try {
        const data = await getRun(runId);
        setRun(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load submission.");
      }
    };

    return () => {
      if (sourceRef.current) sourceRef.current.close();
    };
  }, [id]);

  async function handleMergeDecision(action: "save" | "discard") {
    if (!id) return;
    setDecisionBusy(true);
    setError(null);
    try {
      await postRunDecision(id, action);
      navigate("/submissions", {
        state: {
          snackbar: {
            variant: "success",
            message: action === "save" ? "Merge saved successfully." : "Merge discarded.",
          },
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision request failed.");
    } finally {
      setDecisionBusy(false);
    }
  }

  async function handleExportDocx() {
    if (!id) return;
    setExporting(true);
    setError(null);
    try {
      await downloadRunDocx(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  async function handleStop() {
    if (!id) return;
    setControlBusy("stop");
    setError(null);
    try {
      await postRunControl(id, "stop");
      const data = await getRun(id);
      setRun(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Stop request failed.");
    } finally {
      setControlBusy(null);
    }
  }

  async function handleResume() {
    if (!id) return;
    setControlBusy("resume");
    setError(null);
    try {
      await postRunControl(id, "resume");
      const data = await getRun(id);
      setRun(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resume request failed.");
    } finally {
      setControlBusy(null);
    }
  }

  async function handleDiscardRun() {
    if (!id) return;
    setControlBusy("discard");
    setError(null);
    try {
      await deleteRun(id);
      navigate("/submissions", {
        state: { snackbar: { variant: "success", message: "Run discarded." } },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Discard failed.");
    } finally {
      setControlBusy(null);
    }
  }

  if (!id) {
    return (
      <div className="main-area__inner">
        <p className="card__desc">Missing submission id.</p>
      </div>
    );
  }

  if (error && !run) {
    return (
      <div className="main-area__inner main-area__stack">
        <Link to="/submissions" className="submissions-back">
          ← All submissions
        </Link>
        <p className="card__error">{error}</p>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="main-area__inner main-area__stack">
        <Link to="/submissions" className="submissions-back">
          ← All submissions
        </Link>
        <p className="card__desc">Loading submission…</p>
      </div>
    );
  }

  const title = run.displayName ?? run.originalFileName ?? `Run ${run._id}`;
  const exportBlocked = run.status === "awaiting_user_decision" && run.awaitingUserDecision;

  return (
    <div className="main-area__inner main-area__stack submission-detail">
      <div className="submission-detail__toolbar">
        <Link to="/submissions" className="submissions-back">
          ← All submissions
        </Link>
        <div className="submission-detail__actions">
          <Link to={`/runs/${run._id}`} className="btn">
            Live progress
          </Link>
          {run.status === "running" || run.status === "queued" ? (
            <button
              type="button"
              className="btn"
              disabled={controlBusy !== null}
              onClick={() => void handleStop()}
            >
              {controlBusy === "stop" ? "Stopping…" : "Stop"}
            </button>
          ) : null}
          {run.status === "paused" ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={controlBusy !== null}
                onClick={() => void handleResume()}
              >
                {controlBusy === "resume" ? "Resuming…" : "Resume"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={controlBusy !== null}
                onClick={() => void handleDiscardRun()}
              >
                {controlBusy === "discard" ? "Discarding…" : "Discard"}
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={exporting || exportBlocked}
            title={
              exportBlocked
                ? "Save or discard the provisional merge before exporting DOCX."
                : undefined
            }
            onClick={() => void handleExportDocx()}
          >
            {exporting ? "Preparing DOCX…" : "Download DOCX"}
          </button>
        </div>
      </div>

      {liveDisconnected ? (
        <p className="card__error">Live updates disconnected. Showing last known status.</p>
      ) : null}
      {error ? <p className="card__error">{error}</p> : null}

      <header className="submission-detail__header">
        <h1 className="submission-detail__title">{title}</h1>
        <p className="submission-detail__meta">
          <span className={`submission-status submission-status--${run.status}`}>{run.status}</span>
          <span className="submission-detail__meta-sep">·</span>
          <span>Created {new Date(run.createdAt).toLocaleString()}</span>
          {run.completedAt ? (
            <>
              <span className="submission-detail__meta-sep">·</span>
              <span>Completed {new Date(run.completedAt).toLocaleString()}</span>
            </>
          ) : null}
        </p>
      </header>

      <p className="submission-detail__lead">
        Generated outputs below match the Word export (DOCX): metadata, pipeline stages, developer and PM sections, and
        merged report.
      </p>

      <PipelineTracker
        fetchStatus={run.stages.fetch}
        devStatus={run.stages.dev}
        pmStatus={run.stages.pm}
        reviewStatus={run.stages.review}
        mergeStatus={run.stages.merge}
        mergeAwaitingUser={run.status === "awaiting_user_decision" && !!run.awaitingUserDecision}
        inputSizeClass={run.inputSizeClass}
        chunkCount={run.chunkCount}
        runLabel={run.displayName ?? run.originalFileName ?? run._id}
      />
      <AgentOutputsGrid
        devStatus={run.stages.dev}
        pmStatus={run.stages.pm}
        devOutput={run.devOutput}
        pmOutput={run.pmOutput}
      />
      <ReviewerSummaryCard run={run} />
      <MergedReportCard
        mergeStatus={run.stages.merge}
        mergedReport={run.mergedReport}
        awaitingUserDecision={run.status === "awaiting_user_decision" && !!run.awaitingUserDecision}
        mergeSource={run.mergeSource}
      />
      {run.status === "awaiting_user_decision" && run.awaitingUserDecision ? (
        <div className="merge-decision-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={decisionBusy}
            onClick={() => void handleMergeDecision("save")}
          >
            {decisionBusy ? "Saving…" : "Save merge"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={decisionBusy}
            onClick={() => void handleMergeDecision("discard")}
          >
            Discard merge
          </button>
        </div>
      ) : null}
    </div>
  );
}

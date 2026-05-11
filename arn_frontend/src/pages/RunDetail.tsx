import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { deleteRun, getRun, postRunControl, postRunDecision } from "../api/brs";
import type { BrsRun } from "../api/brs";
import { PipelineTracker } from "../components/PipelineTracker";
import { AgentOutputsGrid } from "../components/AgentOutputsGrid";
import { MergedReportCard } from "../components/MergedReportCard";
import { ReviewerSummaryCard } from "../components/ReviewerSummaryCard";

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

export function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<BrsRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveDisconnected, setLiveDisconnected] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [controlBusy, setControlBusy] = useState<"stop" | "resume" | "discard" | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!id) return;

    setError(null);
    setLiveDisconnected(false);

    if (sourceRef.current) sourceRef.current.close();

    const source = new EventSource(`${BASE_URL}/api/brs/runs/${encodeURIComponent(id)}/stream`);
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
        const data = await getRun(id);
        setRun(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load run.");
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
      navigate("/", {
        state: {
          snackbar: {
            variant: "success",
            message: action === "save" ? "Merge saved successfully." : "Merge discarded.",
          },
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decision request failed.");
    } finally {
      setDecisionBusy(false);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stop request failed.");
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resume request failed.");
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
      navigate("/", {
        state: {
          snackbar: { variant: "success", message: "Run discarded." },
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Discard failed.");
    } finally {
      setControlBusy(null);
    }
  }

  if (!run) {
    return (
      <div className="main-area__inner">
        {error ? <p className="card__error">Error: {error}</p> : <p className="card__desc">Loading run…</p>}
      </div>
    );
  }

  return (
    <div className="main-area__inner">
      {liveDisconnected ? (
        <p className="card__error">Live updates disconnected. Showing last known status.</p>
      ) : null}
      {error ? <p className="card__error">{error}</p> : null}
      {run.status === "running" || run.status === "queued" ? (
        <div className="merge-decision-actions" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className="btn"
            disabled={controlBusy !== null}
            onClick={() => void handleStop()}
          >
            {controlBusy === "stop" ? "Stopping…" : "Stop"}
          </button>
        </div>
      ) : null}
      {run.status === "paused" ? (
        <div className="merge-decision-actions" style={{ marginBottom: 12 }}>
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
        </div>
      ) : null}
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

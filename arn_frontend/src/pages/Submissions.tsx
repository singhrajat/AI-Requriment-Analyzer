import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { deleteRun, getRuns } from "../api/brs";
import type { BrsRun } from "../api/brs";
import { Snackbar } from "../components/Snackbar";

type NavState = {
  snackbar?: { variant: "success" | "error"; message: string };
};

function statusClass(status: string): string {
  if (status === "done") return "submission-status submission-status--done";
  if (status === "running" || status === "queued") return "submission-status submission-status--running";
  if (status === "error") return "submission-status submission-status--error";
  if (status === "needs_human_review" || status === "awaiting_user_decision") {
    return `submission-status submission-status--${status}`;
  }
  return "submission-status";
}

export function Submissions() {
  const navigate = useNavigate();
  const location = useLocation();
  const [runs, setRuns] = useState<BrsRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [snack, setSnack] = useState<NavState["snackbar"] | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const { runs: list } = await getRuns();
      setRuns(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load submissions.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const navSnack = (location.state as NavState | null)?.snackbar ?? null;
    if (!navSnack) return;
    setSnack(navSnack);
    // Clear one-time nav state so refresh/back doesn't re-toast.
    navigate(".", { replace: true, state: {} });
    // Ensure list is refreshed immediately after merge decision.
    void load();
  }, [location.state, navigate, load]);

  async function handleDelete(run: BrsRun) {
    const label = run.displayName ?? run.originalFileName ?? run._id;
    const ok = window.confirm(`Delete submission “${label}”? This cannot be undone.`);
    if (!ok) return;
    setDeletingId(run._id);
    setError(null);
    try {
      await deleteRun(run._id);
      setRuns((prev) => prev.filter((r) => r._id !== run._id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="main-area__inner main-area__stack submissions-page">
      <Snackbar
        open={!!snack}
        variant={snack?.variant ?? "success"}
        message={snack?.message ?? ""}
        onClose={() => setSnack(null)}
      />
      <div className="submissions-page__intro">
        <h1 className="submission-page-title">All submissions</h1>
        <p className="card__desc">
          Every BRS upload and pipeline run. Use <strong>Show</strong> to review outputs and download a formatted
          DOCX report. Use <strong>Delete</strong> to remove a run permanently.
        </p>
      </div>

      {error ? <p className="card__error">{error}</p> : null}

      {loading ? (
        <p className="card__desc">Loading submissions…</p>
      ) : runs.length === 0 ? (
        <div className="output-card submissions-empty">
          <p className="submit-title">No submissions yet</p>
          <p className="submit-sub">Upload a BRS from the dashboard or Submit page to see it listed here.</p>
          <Link to="/submit" className="btn btn-primary submissions-empty__cta">
            Submit BRS
          </Link>
        </div>
      ) : (
        <div className="submissions-table-wrap">
          <table className="submissions-table">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Status</th>
                <th scope="col">Pipeline</th>
                <th scope="col">Created</th>
                <th scope="col" className="submissions-table__actions">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run._id}>
                  <td>
                    <span className="submissions-file">{run.displayName ?? run.originalFileName ?? "—"}</span>
                    <div className="submissions-id">{run._id}</div>
                  </td>
                  <td>
                    <span className={statusClass(run.status)}>{run.status}</span>
                  </td>
                  <td
                    title={`Fetch ${run.stages.fetch}, Dev ${run.stages.dev}, PM ${run.stages.pm}, Merge ${run.stages.merge}`}
                  >
                    <span className="submissions-stages">
                      fetch {run.stages.fetch} · dev {run.stages.dev} · pm {run.stages.pm} · merge {run.stages.merge}
                    </span>
                  </td>
                  <td>
                    <time className="submissions-date" dateTime={run.createdAt}>
                      {new Date(run.createdAt).toLocaleString()}
                    </time>
                  </td>
                  <td className="submissions-table__actions">
                    <div className="submissions-actions">
                      <button type="button" className="btn" onClick={() => navigate(`/submissions/${run._id}`)}>
                        Show
                      </button>
                      <button
                        type="button"
                        className="btn submissions-btn-delete"
                        disabled={deletingId === run._id}
                        onClick={() => handleDelete(run)}
                      >
                        {deletingId === run._id ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

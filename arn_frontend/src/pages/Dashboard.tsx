import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { StatsRow } from "../components/StatsRow";
import { SubmitCard } from "../components/SubmitCard";
import { PipelineTracker } from "../components/PipelineTracker";
import { AgentOutputsGrid } from "../components/AgentOutputsGrid";
import { MergedReportCard } from "../components/MergedReportCard";
import { Snackbar } from "../components/Snackbar";
import { submitBrs } from "../api/brs";
import type { Stats } from "../api/brs";

type NavState = {
  snackbar?: { variant: "success" | "error"; message: string };
};

export function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const [stats, setStats] = useState<Stats | null>(null);
  const [snack, setSnack] = useState<NavState["snackbar"] | null>(null);
  const [liveDisconnected, setLiveDisconnected] = useState(false);

  const navSnack = useMemo(() => (location.state as NavState | null)?.snackbar ?? null, [location.state]);

  useEffect(() => {
    const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";
    setLiveDisconnected(false);
    const source = new EventSource(`${BASE_URL}/api/brs/stream`);

    source.addEventListener("dashboard", (evt) => {
      try {
        const parsed = JSON.parse((evt as MessageEvent).data) as { stats?: Stats };
        if (parsed.stats) setStats(parsed.stats);
        setLiveDisconnected(false);
      } catch {
        // non-critical
      }
    });

    source.onerror = () => {
      setLiveDisconnected(true);
      source.close();
    };

    return () => {
      source.close();
    };
  }, []);

  useEffect(() => {
    if (!navSnack) return;
    setSnack(navSnack);
    // Clear one-time nav state so refresh/back doesn't re-toast.
    navigate(".", { replace: true, state: {} });
  }, [navSnack, navigate]);

  async function handleSubmit(file: File) {
    const { runId } = await submitBrs(file);
    navigate(`/runs/${runId}`);
  }

  return (
    <div className="main-area__inner main-area__stack">
      <Snackbar
        open={!!snack}
        variant={snack?.variant ?? "success"}
        message={snack?.message ?? ""}
        onClose={() => setSnack(null)}
      />
      {liveDisconnected ? (
        <p className="card__error">Live updates disconnected. Stats may be stale.</p>
      ) : null}
      <StatsRow
        total={stats?.total}
        inPipeline={stats?.inPipeline}
        reportsReady={stats?.reportsReady}
        avgDurationMs={stats?.avgDuration}
      />
      <SubmitCard onSubmit={handleSubmit} />
      <PipelineTracker />
      <AgentOutputsGrid />
      <MergedReportCard />
    </div>
  );
}

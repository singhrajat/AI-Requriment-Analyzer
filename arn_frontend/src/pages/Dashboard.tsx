import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { StatsRow } from "../components/StatsRow";
import { SubmitCard } from "../components/SubmitCard";
import { PipelineTracker } from "../components/PipelineTracker";
import { AgentOutputsGrid } from "../components/AgentOutputsGrid";
import { MergedReportCard } from "../components/MergedReportCard";
import { Snackbar } from "../components/Snackbar";
import { submitBrs, getRuns } from "../api/brs";
import type { Stats } from "../api/brs";

type NavState = {
  snackbar?: { variant: "success" | "error"; message: string };
};

export function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const [stats, setStats] = useState<Stats | null>(null);
  const [snack, setSnack] = useState<NavState["snackbar"] | null>(null);

  const navSnack = useMemo(() => (location.state as NavState | null)?.snackbar ?? null, [location.state]);

  useEffect(() => {
    let active = true;

    async function fetchStats() {
      try {
        const { stats: s } = await getRuns();
        if (active) setStats(s);
      } catch {
        // stats fetch failure is non-critical; silently skip
      }
    }

    fetchStats();
    const timer = setInterval(fetchStats, 10_000);
    return () => {
      active = false;
      clearInterval(timer);
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

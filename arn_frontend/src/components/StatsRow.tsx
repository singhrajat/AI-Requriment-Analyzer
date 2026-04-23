interface StatCardProps {
  title: string;
  value: string;
  label: string;
}

function StatCard({ title, value, label }: StatCardProps) {
  return (
    <div className="stat">
      <div className="stat-label">{title}</div>
      <div className="stat-val">{value}</div>
      <div className="stat-sub">{label}</div>
    </div>
  );
}

export interface StatsRowProps {
  total?: number;
  inPipeline?: number;
  reportsReady?: number;
  avgDurationMs?: number;
}

function formatDuration(ms: number): string {
  if (ms === 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

export function StatsRow({ total = 0, inPipeline = 0, reportsReady = 0, avgDurationMs = 0 }: StatsRowProps) {
  return (
    <section className="stats-row" aria-label="Summary stats">
      <StatCard title="Total BRS" value={String(total)} label="this month" />
      <StatCard title="In pipeline" value={String(inPipeline)} label="processing now" />
      <StatCard title="Reports ready" value={String(reportsReady)} label="merged output" />
      <StatCard title="Avg time" value={formatDuration(avgDurationMs)} label="end to end" />
    </section>
  );
}

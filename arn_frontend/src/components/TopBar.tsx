import type { ReactNode } from "react";

function LogoMark() {
  return (
    <div className="topbar-logo" aria-hidden>
      <svg viewBox="0 0 12 12" fill="none">
        <rect x="1" y="1" width="4" height="4" rx="1" fill="#EEEDFE" />
        <rect x="7" y="1" width="4" height="4" rx="1" fill="#EEEDFE" />
        <rect x="1" y="7" width="4" height="4" rx="1" fill="#EEEDFE" />
        <rect x="7" y="7" width="4" height="4" rx="1" fill="#AFA9EC" />
      </svg>
    </div>
  );
}

function Badge({ children, tone }: { children: ReactNode; tone: "green" | "purple" }) {
  return <span className={`topbar-badge topbar-badge--${tone}`}>{children}</span>;
}

interface TopBarProps {
  agentStatusBadge?: ReactNode;
}

export function TopBar({ agentStatusBadge }: TopBarProps) {
  return (
    <header className="top-bar">
      <div className="top-bar__brand">
        <LogoMark />
        <span className="top-bar__title">BRS Agent Panel</span>
      </div>
      <div className="top-bar__meta">
        {agentStatusBadge ?? <Badge tone="green">2 agents running</Badge>}
        <Badge tone="purple">v1.0</Badge>
        <div className="topbar-avatar" aria-label="User AK">
          AK
        </div>
      </div>
    </header>
  );
}

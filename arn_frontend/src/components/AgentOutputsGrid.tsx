import type { StageStatus } from "../api/brs";
import { StructuredOutputView } from "./StructuredOutputView";

function CheckRow({ done, label }: { done: boolean; label: string }) {
  return (
    <div className="check-item">
      <div className={`check-box${done ? " check-box--done" : ""}`} aria-hidden>
        {done ? (
          <svg viewBox="0 0 8 8" fill="none">
            <path
              d="M1.5 4l2 2 3-3"
              stroke="#1D9E75"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </div>
      <span>{label}</span>
    </div>
  );
}

export interface AgentOutputsGridProps {
  devStatus?: StageStatus;
  pmStatus?: StageStatus;
  devOutput?: string;
  pmOutput?: string;
}

const DEV_STEPS = ["Validations", "Error handling", "Security review", "Edge cases"];
const PM_STEPS = ["What could go wrong?", "Where can it fail?", "Timeline risks", "Escalation paths"];

export function AgentOutputsGrid({
  devStatus = "pending",
  pmStatus = "pending",
  devOutput,
  pmOutput,
}: AgentOutputsGridProps) {
  const devBadgeClass =
    devStatus === "running" ? "teal" : devStatus === "error" ? "coral" : "gray";
  const pmBadgeClass =
    pmStatus === "running" ? "coral" : pmStatus === "error" ? "coral" : "gray";

  return (
    <section className="section-block">
      <h3 className="section-label">
        Agent outputs <span className="section-label__suffix">— live</span>
      </h3>
      <div className="parallel-grid">
        <article className="agent-card">
          <div className="agent-header">
            <div className="agent-title">Developer agent</div>
            <span className={`agent-badge agent-badge--${devBadgeClass}`}>{devStatus}</span>
          </div>
          {devOutput ? (
            <StructuredOutputView raw={devOutput} className="agent-output agent-output--structured" />
          ) : (
            <div className="checklist">
              {DEV_STEPS.map((label, i) => (
                <CheckRow
                  key={label}
                  done={devStatus === "done" || (devStatus === "running" && i < 2)}
                  label={label}
                />
              ))}
            </div>
          )}
        </article>

        <article className="agent-card">
          <div className="agent-header">
            <div className="agent-title">Project manager agent</div>
            <span className={`agent-badge agent-badge--${pmBadgeClass}`}>{pmStatus}</span>
          </div>
          {pmOutput ? (
            <StructuredOutputView raw={pmOutput} className="agent-output agent-output--structured" />
          ) : (
            <div className="checklist">
              {PM_STEPS.map((label, i) => (
                <CheckRow
                  key={label}
                  done={pmStatus === "done" || (pmStatus === "running" && i < 2)}
                  label={label}
                />
              ))}
            </div>
          )}
        </article>
      </div>
    </section>
  );
}

import { useNavigate } from "react-router-dom";
import { SubmitCard } from "../components/SubmitCard";
import { submitBrs } from "../api/brs";

export function SubmitPage() {
  const navigate = useNavigate();

  async function handleSubmit(file: File, displayName?: string) {
    const { runId } = await submitBrs(file, displayName);
    navigate(`/runs/${runId}`);
  }

  return (
    <div className="main-area__inner">
      <SubmitCard onSubmit={handleSubmit} />
    </div>
  );
}

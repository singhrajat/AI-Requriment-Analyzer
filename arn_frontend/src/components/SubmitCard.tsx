import { useRef, useState } from "react";

export interface SubmitCardProps {
  onSubmit?: (file: File, displayName?: string) => Promise<void>;
}

function defaultDisplayNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^/.]+$/i, "").trim();
  return base.length > 0 ? base : fileName;
}

export function SubmitCard({ onSubmit }: SubmitCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setSelectedFile(f);
    setDisplayName(f ? defaultDisplayNameFromFile(f.name) : "");
    setError(null);
  }

  async function handleSubmit() {
    if (!selectedFile) {
      setError("Please select a file first.");
      return;
    }
    if (!onSubmit) return;
    setLoading(true);
    setError(null);
    try {
      await onSubmit(selectedFile, displayName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="submit-card" aria-label="New BRS submission">
      <div className="submit-left">
        <div className="submit-title">New BRS submission</div>
        <div className="submit-sub">
          {selectedFile ? `Selected: ${selectedFile.name}` : "Upload a requirements document to start the pipeline"}
        </div>
        {selectedFile ? (
          <label className="submit-name">
            <span className="submit-name__label">Name</span>
            <input
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Payments BRS (v2)"
              disabled={loading}
            />
          </label>
        ) : null}
        {error && <p className="card__error">{error}</p>}
      </div>
      <div className="submit-actions">
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.txt,.doc,.docx"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
        <button type="button" className="btn" onClick={() => inputRef.current?.click()} disabled={loading}>
          {selectedFile ? "Change file" : "Upload file"}
        </button>
        <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={loading || !selectedFile}>
          {loading ? "Submitting…" : "Submit BRS ↗"}
        </button>
      </div>
    </section>
  );
}

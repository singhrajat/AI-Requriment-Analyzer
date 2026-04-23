import { useEffect } from "react";

export type SnackbarVariant = "success" | "error";

export interface SnackbarProps {
  open: boolean;
  message: string;
  variant?: SnackbarVariant;
  autoHideMs?: number;
  onClose: () => void;
}

export function Snackbar({
  open,
  message,
  variant = "success",
  autoHideMs = 3500,
  onClose,
}: SnackbarProps) {
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(onClose, autoHideMs);
    return () => window.clearTimeout(t);
  }, [open, autoHideMs, onClose]);

  if (!open) return null;

  return (
    <div className="snackbar-wrap" role="status" aria-live="polite">
      <div className={`snackbar snackbar--${variant}`}>
        <div className="snackbar__msg">{message}</div>
        <button type="button" className="snackbar__close" onClick={onClose} aria-label="Dismiss">
          ×
        </button>
      </div>
    </div>
  );
}


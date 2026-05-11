import { EventEmitter } from "node:events";

/**
 * In-process event bus for BRS run updates.
 *
 * Note: This only broadcasts within a single Node process. For multi-instance
 * deployments, migrate to a shared pub/sub (Redis, NATS, etc.).
 */
class BrsRunEventBus extends EventEmitter {}

const bus = new BrsRunEventBus();

export type BrsRunChangedEvent = {
  runId: string;
  /** Optional hint for what changed (best-effort). */
  fields?: string[];
  at: number;
};

export function emitBrsRunChanged(runId: string, fields?: string[]): void {
  bus.emit("brsRunChanged", { runId, fields, at: Date.now() } satisfies BrsRunChangedEvent);
}

export function onBrsRunChanged(listener: (evt: BrsRunChangedEvent) => void): () => void {
  bus.on("brsRunChanged", listener);
  return () => bus.off("brsRunChanged", listener);
}


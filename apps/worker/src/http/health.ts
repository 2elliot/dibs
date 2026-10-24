// Shared, mutable health state. The worker loop updates it; /health/status reads it. Kept tiny and
// synchronous so a Maincloud blip can't make the status endpoint hang.

export type DbState = "connected" | "disconnected" | "unknown";

export interface StatusReport {
  db: DbState;
  /** Age of the oldest unleased queued job, or null if none / unknown. */
  queueAgeSec: number | null;
  lastAnalysisLatencyMs: number | null;
  anthropicErrors: number;
  uptimeSec: number;
}

export class HealthState {
  private readonly startedMs = Date.now();
  private db: DbState = "unknown";
  private queueOldestMs: number | null = null;
  private lastLatencyMs: number | null = null;
  private anthropicErrors = 0;

  setDb(state: DbState): void {
    this.db = state;
  }

  /** Pass the enqueue time (ms) of the oldest queued job, or null when the queue is empty. */
  setQueueOldest(ms: number | null): void {
    this.queueOldestMs = ms;
  }

  recordAnalysisLatency(ms: number): void {
    this.lastLatencyMs = ms;
  }

  recordAnthropicError(): void {
    this.anthropicErrors += 1;
  }

  report(nowMs: number = Date.now()): StatusReport {
    return {
      db: this.db,
      queueAgeSec:
        this.queueOldestMs === null
          ? null
          : Math.max(0, Math.round((nowMs - this.queueOldestMs) / 1000)),
      lastAnalysisLatencyMs: this.lastLatencyMs,
      anthropicErrors: this.anthropicErrors,
      uptimeSec: Math.round((nowMs - this.startedMs) / 1000),
    };
  }
}

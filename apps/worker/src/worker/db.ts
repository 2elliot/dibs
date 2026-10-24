// The slice of the module the worker needs, behind an interface. Phase A tests use an in-memory
// fake; Phase B (after issue 1 ships [module-ready]) wires a real implementation over @dibs/client
// that subscribes to the tables and calls the reducers in docs/API.md "Worker".
import type { AnalysisInput, Findings, JobKind } from "@dibs/protocol";

export interface LeasableJob {
  jobId: number;
  lobbyId: number;
  kind: JobKind;
  inputKey: string;
  /** When this job was first enqueued (ms), for /health/status queue age. */
  enqueuedAtMs: number;
}

/** A job row that was just inserted or updated into `queued`. */
export interface QueuedJob {
  jobId: number;
  lobbyId: number;
}

export interface DibsDb {
  /**
   * Call `listener` whenever a job row is inserted or updated into `queued`, so the loop can lease
   * it on sight instead of waiting for the rescan. Returns a function that removes the listener.
   */
  onJobQueued(listener: (job: QueuedJob) => void): () => void;
  /** A `queued` job, or a `leased` job whose lease has expired, or null. One per lobby in flight. */
  nextLeasableJob(
    excludedLobbyIds?: ReadonlySet<number>,
  ): Promise<LeasableJob | null>;
  /** Build the model input for a job from the lobby's current rows. */
  buildAnalysisInput(jobId: number): Promise<AnalysisInput>;
  /** The lobby's fallbackAtUs (microseconds), for the retry budget. */
  lobbyFallbackAtUs(lobbyId: number): Promise<number>;

  // Reducers (docs/API.md "Worker").
  /** Lease a job with the worker's fresh token; false if it is no longer leasable. */
  leaseJob(jobId: number, leaseToken: string): Promise<boolean>;
  submitAnalysis(
    jobId: number,
    leaseToken: string,
    inputKey: string,
    findings: Findings,
  ): Promise<void>;
  failJob(jobId: number, leaseToken: string, error: string): Promise<void>;
  heartbeat(name: string, detail: Record<string, unknown>): Promise<void>;

  /** Oldest queued job's enqueue time (ms) or null, for the health report. */
  oldestQueuedAtMs(): Promise<number | null>;
}

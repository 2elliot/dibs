// In-memory DibsDb for Phase A tests. It records reducer calls and lets a test stage leasable jobs
// and inputs. It does NOT reimplement the module's reducer logic (proposals, aligned contracts,
// rule checks) — that behavior is verified in Phase B against the real local module. Here we check
// the loop's control flow: lease -> analyze -> submit/fail, one-per-lobby, and re-lease of expired.
import type { AnalysisInput, Findings } from "@dibs/protocol";
import type { DibsDb, LeasableJob } from "./db.ts";

export interface SubmitCall {
  jobId: number;
  leaseToken: string;
  inputKey: string;
  findings: Findings;
}
export interface FailCall {
  jobId: number;
  leaseToken: string;
  error: string;
}

export class FakeDb implements DibsDb {
  private jobs: LeasableJob[] = [];
  private inputs = new Map<number, AnalysisInput>();
  private fallbacks = new Map<number, number>();
  /** jobIds that leaseJob should refuse (e.g. taken by another worker / stale). */
  unleasable = new Set<number>();

  readonly leaseCalls: { jobId: number; leaseToken: string }[] = [];
  readonly submitCalls: SubmitCall[] = [];
  readonly failCalls: FailCall[] = [];
  readonly heartbeats: { name: string; detail: Record<string, unknown> }[] = [];

  /** Stage a job the loop will pick up once. */
  stage(job: LeasableJob, input: AnalysisInput, fallbackAtUs: number): void {
    this.jobs.push(job);
    this.inputs.set(job.jobId, input);
    this.fallbacks.set(job.lobbyId, fallbackAtUs);
  }

  async nextLeasableJob(): Promise<LeasableJob | null> {
    return this.jobs.shift() ?? null;
  }
  async buildAnalysisInput(jobId: number): Promise<AnalysisInput> {
    const input = this.inputs.get(jobId);
    if (!input) throw new Error(`no staged input for job ${jobId}`);
    return input;
  }
  async lobbyFallbackAtUs(lobbyId: number): Promise<number> {
    return this.fallbacks.get(lobbyId) ?? 0;
  }
  async leaseJob(jobId: number, leaseToken: string): Promise<boolean> {
    this.leaseCalls.push({ jobId, leaseToken });
    return !this.unleasable.has(jobId);
  }
  async submitAnalysis(
    jobId: number,
    leaseToken: string,
    inputKey: string,
    findings: Findings,
  ): Promise<void> {
    this.submitCalls.push({ jobId, leaseToken, inputKey, findings });
  }
  async failJob(
    jobId: number,
    leaseToken: string,
    error: string,
  ): Promise<void> {
    this.failCalls.push({ jobId, leaseToken, error });
  }
  async heartbeat(
    name: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    this.heartbeats.push({ name, detail });
  }
  async oldestQueuedAtMs(): Promise<number | null> {
    return this.jobs.length
      ? Math.min(...this.jobs.map((j) => j.enqueuedAtMs))
      : null;
  }
}

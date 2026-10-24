// The worker loop: find a leasable job, lease it with a fresh token, analyze, submit or fail.
// One analysis in flight per lobby. The lease rescan (every TIMING.leaseRescanSec) is handled by
// the DB's nextLeasableJob(), which also returns leased-but-expired jobs so a crashed worker's job
// is retried. The analysis cap per lobby is enforced by the module (lease_job), not here.
import { randomUUID } from "node:crypto";
import { TIMING } from "@dibs/protocol";
import type { ModelClient } from "../model/types.ts";
import type { HealthState } from "../http/health.ts";
import { runAnalysisWithRetry } from "../analysis/analyze.ts";
import type { DibsDb } from "./db.ts";

// Leave enough time for a 5 s reducer call before the frozen 60 s lease expires.
export const LEASE_RESERVE_MS = TIMING.bridgeCallTimeoutSec * 1000 + 1000;

export interface LoopOptions {
  db: DibsDb;
  model: ModelClient;
  health: HealthState;
  /** How often to poll for a leasable job (ms). Default TIMING.leaseRescanSec. */
  pollMs?: number;
  /** How often to heartbeat (ms). Default 15 s. */
  heartbeatMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Logger; defaults to console.error (stderr only — stdout is reserved for MCP elsewhere). */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class WorkerLoop {
  private readonly db: DibsDb;
  private readonly model: ModelClient;
  private readonly health: HealthState;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;

  private running = false;
  private readonly inFlight = new Set<number>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(opts: LoopOptions) {
    this.db = opts.db;
    this.model = opts.model;
    this.health = opts.health;
    this.pollMs = opts.pollMs ?? TIMING.leaseRescanSec * 1000;
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
    this.now = opts.now ?? Date.now;
    this.log =
      opts.log ??
      ((msg, extra) =>
        console.error(`[worker] ${msg}`, extra ? JSON.stringify(extra) : ""));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => void this.tick(), this.pollMs);
    this.heartbeatTimer = setInterval(() => void this.beat(), this.heartbeatMs);
    void this.beat();
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  /** One scan. Public so tests can drive it deterministically without timers. */
  async tick(): Promise<void> {
    let job;
    try {
      job = await this.db.nextLeasableJob(this.inFlight);
      this.health.setDb("connected");
      this.health.setQueueOldest(await this.db.oldestQueuedAtMs());
    } catch (e) {
      this.health.setDb("disconnected");
      this.log("scan failed", { error: String(e) });
      return;
    }
    if (!job) return;
    if (this.inFlight.has(job.lobbyId)) return; // one call per lobby

    this.inFlight.add(job.lobbyId);
    try {
      await this.process(job.jobId, job.lobbyId);
    } catch (e) {
      this.log("job processing failed", { jobId: job.jobId, error: String(e) });
    } finally {
      this.inFlight.delete(job.lobbyId);
    }
  }

  private async process(jobId: number, lobbyId: number): Promise<void> {
    const leaseToken = randomUUID();
    const deadlineMs = this.now() + TIMING.leaseSec * 1000 - LEASE_RESERVE_MS;
    const leased = await this.db.leaseJob(jobId, leaseToken);
    if (!leased) {
      this.log("job no longer leasable", { jobId });
      return;
    }

    const input = await this.db.buildAnalysisInput(jobId);
    const fallbackAtUs = await this.db.lobbyFallbackAtUs(lobbyId);

    let outcome;
    try {
      outcome = await runAnalysisWithRetry(
        input,
        this.model,
        {
          now: this.now,
          fallbackAtUs,
        },
        { deadlineMs },
      );
    } catch (e) {
      this.health.recordAnthropicError();
      this.log("analysis failed; failing job", { jobId, error: String(e) });
      await this.db.failJob(jobId, leaseToken, String(e));
      return;
    }

    this.health.recordAnalysisLatency(outcome.latencyMs);
    this.log("analysis complete", {
      jobId,
      inputKey: input.inputKey,
      kept: outcome.kept.length,
      dropped: outcome.dropped.length,
      attempts: outcome.attempts,
      latencyMs: outcome.latencyMs,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      model: outcome.model,
    });
    for (const d of outcome.dropped) {
      this.log("dropped finding", {
        jobId,
        key: d.finding.key,
        reason: d.reason,
      });
    }

    await this.db.submitAnalysis(jobId, leaseToken, input.inputKey, {
      findings: outcome.kept,
    });
  }

  private async beat(): Promise<void> {
    try {
      const status = this.health.report(this.now());
      await this.db.heartbeat(
        "worker",
        status as unknown as Record<string, unknown>,
      );
    } catch (e) {
      this.log("heartbeat failed", { error: String(e) });
    }
  }
}

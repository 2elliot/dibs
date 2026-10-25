// The worker loop: find a leasable job, lease it with a fresh token, analyze, submit or fail.
// One analysis in flight per lobby. A job the DB reports as queued is leased on sight (plan §6.1).
// The rescan every TIMING.leaseRescanSec catches what no row change announces: the DB's
// nextLeasableJob() also returns leased-but-expired jobs, so a crashed worker's job is retried.
// The analysis cap per lobby is enforced by the module (lease_job), not here.
import { randomUUID } from "node:crypto";
import { TIMING } from "@dibs/protocol";
import type { ModelClient } from "../model/types.ts";
import type { HealthState } from "../http/health.ts";
import { runAnalysisWithRetry } from "../analysis/analyze.ts";
import { InvalidFindingsError } from "../analysis/validate.ts";
import type { DibsDb, LeasableJob, QueuedJob } from "./db.ts";

// Leave enough time for a 5 s reducer call before the frozen 60 s lease expires.
export const LEASE_RESERVE_MS = TIMING.bridgeCallTimeoutSec * 1000 + 1000;

export interface LoopOptions {
  db: DibsDb;
  model: ModelClient;
  health: HealthState;
  /** How often to rescan for a leasable job (ms). Default TIMING.leaseRescanSec. */
  pollMs?: number;
  maxConcurrent?: number;
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
  private readonly maxConcurrent: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;

  private running = false;
  private readonly inFlight = new Set<number>();
  /** Failed/no-op leases must wait for the normal poll, not spin via kick(). */
  private readonly retryAfter = new Map<number, number>();
  /** Lobbies whose job was re-queued while their analysis was in flight; rescanned when it ends. */
  private readonly requeued = new Set<number>();
  private scanning?: Promise<Promise<void>[]>;
  private rescan = false;
  private kickPending = false;
  private unsubscribe?: () => void;
  private pollTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(opts: LoopOptions) {
    this.db = opts.db;
    this.model = opts.model;
    this.health = opts.health;
    this.pollMs = opts.pollMs ?? TIMING.leaseRescanSec * 1000;
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1)
      throw new Error("maxConcurrent must be a positive integer");
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
    this.unsubscribe = this.db.onJobQueued((job) => this.onJobQueued(job));
    this.pollTimer = setInterval(() => void this.tick(), this.pollMs);
    this.heartbeatTimer = setInterval(() => void this.beat(), this.heartbeatMs);
    void this.beat();
    void this.tick();
  }

  stop(): void {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  /**
   * One scan, then wait for the analyses it started. Public so tests can drive it deterministically
   * without timers. A call that arrives mid-scan joins that scan and adds one more pass instead of
   * scanning alongside it.
   */
  async tick(): Promise<void> {
    await Promise.all(await this.scan());
  }

  private scan(): Promise<Promise<void>[]> {
    if (this.scanning) {
      this.rescan = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      const started: Promise<void>[] = [];
      try {
        do {
          this.rescan = false;
          started.push(...(await this.scanOnce()));
        } while (this.rescan);
      } finally {
        this.scanning = undefined;
      }
      return started;
    })();
    return this.scanning;
  }

  /** Start an analysis for each leasable job whose lobby has none in flight. */
  private async scanOnce(): Promise<Promise<void>[]> {
    const started: Promise<void>[] = [];
    // Lobbies in flight or already picked this pass: one call per lobby, and a job whose lease
    // fails fast is not picked again until the next pass.
    const seen = new Set(this.inFlight);
    for (const [lobbyId, until] of this.retryAfter) {
      if (until > this.now()) seen.add(lobbyId);
      else this.retryAfter.delete(lobbyId);
    }
    try {
      for (;;) {
        if (this.inFlight.size >= this.maxConcurrent) break;
        const job = await this.db.nextLeasableJob(seen);
        if (!job || seen.has(job.lobbyId)) break;
        seen.add(job.lobbyId);
        started.push(this.run(job));
      }
      this.health.setDb("connected");
      this.health.setQueueOldest(await this.db.oldestQueuedAtMs());
    } catch (e) {
      this.health.setDb("disconnected");
      this.log("scan failed", { error: String(e) });
    }
    return started;
  }

  private async run(job: LeasableJob): Promise<void> {
    this.inFlight.add(job.lobbyId);
    try {
      await this.process(job.jobId, job.lobbyId);
    } catch (e) {
      this.retryAfter.set(job.lobbyId, this.now() + this.pollMs);
      this.log("job processing failed", { jobId: job.jobId, error: String(e) });
    } finally {
      this.inFlight.delete(job.lobbyId);
      this.requeued.delete(job.lobbyId);
      this.kick();
    }
  }

  private onJobQueued(job: QueuedJob): void {
    // The module can re-queue a lobby's job while we hold its lease (it replaces a stale lease).
    // Scans skip that lobby until our call ends, so rescan then rather than at the next timer.
    if (this.inFlight.has(job.lobbyId)) this.requeued.add(job.lobbyId);
    else {
      this.retryAfter.delete(job.lobbyId);
      this.kick();
    }
  }

  /** Scan on the next microtask, so the row callbacks of one transaction start one scan. */
  private kick(): void {
    if (!this.running || this.kickPending) return;
    this.kickPending = true;
    queueMicrotask(() => {
      this.kickPending = false;
      if (this.running) void this.tick();
    });
  }

  private async process(jobId: number, lobbyId: number): Promise<void> {
    const leaseToken = randomUUID();
    const deadlineMs = this.now() + TIMING.leaseSec * 1000 - LEASE_RESERVE_MS;
    const leased = await this.db.leaseJob(jobId, leaseToken);
    if (!leased) {
      this.retryAfter.set(lobbyId, this.now() + this.pollMs);
      this.log("job no longer leasable", { jobId });
      return;
    }
    this.retryAfter.delete(lobbyId);

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
      // Unusable model output is not an API failure; /health/status counts only the latter.
      if (!(e instanceof InvalidFindingsError))
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
    for (const r of outcome.repaired) {
      this.log("removed invalid citations", {
        jobId,
        key: r.key,
        removedIds: r.removedIds,
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

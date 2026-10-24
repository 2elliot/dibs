// The real DibsDb, backed by @dibs/client over SpacetimeDB. It subscribes to the worker-relevant
// tables across ALL lobbies (the worker is global, unlike the per-lobby bridge), reads the row cache
// to pick leasable jobs and assemble AnalysisInput, and calls the worker reducers. Row -> input
// mapping lives in mapping.ts (unit-tested); this file only wires it to the live connection.
//
// The opt-in live suite exercises this adapter against the real local module (see VERIFY.md).
import { call, connect, DbConnection, tables } from "@dibs/client";
import type { Findings } from "@dibs/protocol";
import type { AnalysisInput } from "@dibs/protocol";
import type { DibsDb, LeasableJob } from "./db.ts";
import {
  assembleAnalysisInput,
  pickLeasableJob,
  type LobbyRows,
  type RowContract,
  type RowJob,
  type RowLobby,
  type RowParticipant,
  type RowPlan,
  type RowPlanItem,
  type RowProposal,
  type RowResponse,
} from "./mapping.ts";

const WORKER_TABLES = [
  tables.job,
  tables.lobby,
  tables.plan,
  tables.planItem,
  tables.participant,
  tables.contract,
  tables.proposal,
  tables.response,
] as const;

function nowUs(): bigint {
  return BigInt(Date.now()) * 1000n;
}

export interface SpacetimeConnectOptions {
  uri: string;
  dbName: string;
  token: string;
  timeoutMs?: number;
}

export class SpacetimeDibsDb implements DibsDb {
  private constructor(private readonly conn: DbConnection) {}

  disconnect(): void {
    this.conn.disconnect();
  }

  static async connect(
    opts: SpacetimeConnectOptions,
  ): Promise<SpacetimeDibsDb> {
    const { conn } = await connect(opts);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("worker subscription timed out")),
          10_000,
        );
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timer);
            resolve();
          })
          .onError((ctx) => {
            clearTimeout(timer);
            reject(ctx.event);
          })
          .subscribe(WORKER_TABLES.map((q) => q));
      });
    } catch (error) {
      conn.disconnect();
      throw error;
    }
    return new SpacetimeDibsDb(conn);
  }

  private rows(): LobbyRows {
    this.requireActive();
    const db = this.conn.db;
    return {
      job: Array.from(db.job.iter()) as unknown as RowJob[],
      lobby: Array.from(db.lobby.iter()) as unknown as RowLobby[],
      plan: Array.from(db.plan.iter()) as unknown as RowPlan[],
      planItem: Array.from(db.planItem.iter()) as unknown as RowPlanItem[],
      participant: Array.from(
        db.participant.iter(),
      ) as unknown as RowParticipant[],
      contract: Array.from(db.contract.iter()) as unknown as RowContract[],
      proposal: Array.from(db.proposal.iter()) as unknown as RowProposal[],
      response: Array.from(db.response.iter()) as unknown as RowResponse[],
    };
  }

  private requireActive(): void {
    if (!this.conn.isActive) throw new Error("database disconnected");
  }

  async nextLeasableJob(
    excludedLobbyIds?: ReadonlySet<number>,
  ): Promise<LeasableJob | null> {
    this.requireActive();
    const jobs = Array.from(this.conn.db.job.iter()) as unknown as RowJob[];
    const running = new Set(
      Array.from(this.conn.db.lobby.iter())
        .filter((l) => l.state === "running")
        .map((l) => l.id),
    );
    const job = pickLeasableJob(
      jobs.filter(
        (j) => running.has(j.lobbyId) && !excludedLobbyIds?.has(j.lobbyId),
      ),
      nowUs(),
    );
    if (!job) return null;
    return {
      jobId: job.id,
      lobbyId: job.lobbyId,
      kind: job.kind as LeasableJob["kind"],
      inputKey: job.inputKey,
      enqueuedAtMs: Number(job.updatedAtUs / 1000n),
    };
  }

  async buildAnalysisInput(jobId: number): Promise<AnalysisInput> {
    return assembleAnalysisInput(jobId, this.rows());
  }

  async lobbyFallbackAtUs(lobbyId: number): Promise<number> {
    const lobby = (
      Array.from(this.conn.db.lobby.iter()) as unknown as RowLobby[]
    ).find((l) => l.id === lobbyId);
    return lobby ? Number(lobby.fallbackAtUs) : 0;
  }

  async leaseJob(jobId: number, leaseToken: string): Promise<boolean> {
    const res = await call(this.conn, "leaseJob", { jobId, leaseToken });
    if (res.status !== "ok") {
      console.error(
        `[worker] leaseJob ${jobId} -> ${res.status}: ${res.error ?? ""}`,
      );
    }
    return res.status === "ok";
  }

  async submitAnalysis(
    jobId: number,
    leaseToken: string,
    inputKey: string,
    findings: Findings,
  ): Promise<void> {
    const res = await call(this.conn, "submitAnalysis", {
      jobId,
      leaseToken,
      inputKey,
      findingsJson: JSON.stringify(findings),
    });
    if (res.status !== "ok") {
      throw new Error(
        `submitAnalysis ${jobId} -> ${res.status}: ${res.error ?? ""}`,
      );
    }
  }

  async failJob(
    jobId: number,
    leaseToken: string,
    error: string,
  ): Promise<void> {
    const res = await call(this.conn, "failJob", { jobId, leaseToken, error });
    if (res.status !== "ok") {
      throw new Error(`failJob ${jobId} -> ${res.status}: ${res.error ?? ""}`);
    }
  }

  async heartbeat(
    name: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const res = await call(this.conn, "heartbeat", {
      name,
      detailJson: JSON.stringify(detail),
    });
    if (res.status !== "ok")
      throw new Error(`heartbeat -> ${res.status}: ${res.error ?? ""}`);
  }

  async oldestQueuedAtMs(): Promise<number | null> {
    this.requireActive();
    const queued = (
      Array.from(this.conn.db.job.iter()) as unknown as RowJob[]
    ).filter((j) => j.state === "queued");
    if (queued.length === 0) return null;
    return Math.min(...queued.map((j) => Number(j.updatedAtUs / 1000n)));
  }
}

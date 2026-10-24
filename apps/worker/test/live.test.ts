import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, type DbConnection } from "@dibs/client";
import { TIMING, type AnalysisInput, type Findings } from "@dibs/protocol";
import { all, waitFor } from "../../../packages/cli/src/commands/common.ts";
import { FakeModelClient } from "../src/model/fake.ts";
import type { ModelClient } from "../src/model/types.ts";
import { WorkerLoop } from "../src/worker/loop.ts";
import { SpacetimeDibsDb } from "../src/worker/spacetime-db.ts";
import { HealthState } from "../src/http/health.ts";

// Opt-in: creates only fresh dibs-i3-* databases on a loopback server. No real model is called.
const uri = process.env.DIBS_WORKER_LIVE_URI;
describe.skipIf(!uri)("live SpacetimeDB worker", () => {
  const connections: DbConnection[] = [];
  let dbName: string;
  let admin: DbConnection;
  let agents: DbConnection[];
  let worker: SpacetimeDibsDb;
  let workerToken: string;
  let lobbyId: number;
  function cli(args: string[]) {
    const executable =
      process.env.SPACETIME_BIN ||
      (process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "SpacetimeDB", "spacetime.exe")
        : "spacetime");
    return execFileSync(executable, args, {
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  async function claim(code: string) {
    const session = await connect({ uri: uri!, dbName });
    connections.push(session.conn);
    await session.conn.reducers.claimInvite({ code });
    await all(session.conn);
    return session;
  }
  async function participant(name: string, role: string) {
    const code = randomUUID();
    await admin.reducers.createInvite({
      code,
      name,
      provider: name === "codex" ? "codex" : "claude",
      role,
    });
    return claim(code);
  }
  async function publishPlans(compatible = false) {
    const before = new Set([...admin.db.lobby.iter()].map((l) => l.id));
    await admin.reducers.createLobby({
      scenario: "worker-regression",
      mode: "dibs",
      baseSha: "a".repeat(40),
      vocabularyJson: JSON.stringify([
        { key: "auth.session", description: "transport" },
      ]),
      charter: "Use one transport",
      buildHash: "worker-test",
    });
    const lobby = await waitFor(() =>
      [...admin.db.lobby.iter()].find((l) => !before.has(l.id)),
    );
    lobbyId = lobby.id;
    for (const agent of agents)
      await agent.reducers.joinLobby({ lobbyId, buildHash: "worker-test" });
    await admin.reducers.startLobby({ lobbyId });
    for (const [index, agent] of agents.entries()) {
      const item = {
        key: "auth.session",
        text: index === 0 || compatible ? "bearer" : "cookie",
      };
      await agent.reducers.publishPlan({
        requestId: randomUUID(),
        goal: "session",
        produces: index === 0 ? [item] : [],
        requires: index === 0 ? [] : [item],
        notes: "",
      });
    }
  }
  async function planned(compatible = false) {
    await publishPlans(compatible);
    return waitFor(() =>
      [...admin.db.job.iter()].find(
        (j) => j.lobbyId === lobbyId && j.state === "queued",
      ),
    );
  }
  function findings(input: AnalysisInput, relation = "conflict"): Findings {
    return {
      findings: [
        {
          key: "auth.session",
          relation: relation as "conflict" | "compatible",
          citedItemIds: input.items.map((i) => i.id),
          explanation: "Live worker regression",
          contractText:
            "POST /api/login returns {token}; use Authorization: Bearer token.",
        },
      ],
    };
  }
  async function leasable() {
    const deadline = Date.now() + 10000;
    do {
      const job = await worker.nextLeasableJob();
      if (job) return job;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    throw new Error("timed out waiting for leasable job");
  }
  async function analyze(relation = "conflict") {
    const job = await leasable();
    const input = await worker.buildAnalysisInput(job.jobId);
    await new WorkerLoop({
      db: worker,
      model: new FakeModelClient({ resolver: () => findings(input, relation) }),
      health: new HealthState(),
      log: () => {},
    }).tick();
    return waitFor(() =>
      [...admin.db.job.iter()].find(
        (j) => j.id === job.jobId && j.state === "done",
      ),
    );
  }
  beforeAll(async () => {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(uri!).hostname))
      throw new Error("loopback server required");
    dbName = `dibs-i3-test-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const modulePath = fileURLToPath(
      new URL("../.live-module/", import.meta.url),
    );
    await mkdir(modulePath, { recursive: true });
    await cp(
      fileURLToPath(new URL("../../../spacetime/src/", import.meta.url)),
      join(modulePath, "src"),
      { recursive: true },
    );
    // Shorten only the private test copy's debounce/lease; production TIMING is untouched.
    await writeFile(
      join(modulePath, "src/timing.ts"),
      `export const timing = ${JSON.stringify({ ...TIMING, debounceSec: 0.1, leaseSec: 2 })};\n`,
    );
    await writeFile(
      join(modulePath, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { spacetimedb: "^2.13.0" },
      }),
    );
    await writeFile(
      join(modulePath, "tsconfig.json"),
      JSON.stringify({
        extends: "../../../tsconfig.base.json",
        include: ["src"],
      }),
    );
    cli([
      "publish",
      "--server",
      uri!,
      "--module-path",
      modulePath,
      "--yes",
      dbName,
    ]);
    const rows = JSON.parse(
      cli([
        "sql",
        "--server",
        uri!,
        "--format",
        "json",
        dbName,
        "SELECT code FROM invite WHERE name = 'admin' AND used = false",
      ]),
    );
    admin = (await claim(String(rows[0].rows[0][0]))).conn;
    agents = [
      (await participant("claude", "agent")).conn,
      (await participant("codex", "agent")).conn,
    ];
    workerToken = (await participant("worker", "worker")).token;
    worker = await SpacetimeDibsDb.connect({
      uri: uri!,
      dbName,
      token: workerToken,
    });
  }, 120_000);
  afterEach(async () => {
    if (lobbyId) await admin.reducers.stopLobby({ lobbyId });
    lobbyId = 0;
  });
  afterAll(() => {
    worker?.disconnect();
    for (const connection of connections) connection.disconnect();
  });

  it("submits a proposal with real citations and frozen required parties", async () => {
    await planned();
    await analyze();
    const proposal = await waitFor(() =>
      [...admin.db.proposal.iter()].find((p) => p.lobbyId === lobbyId),
    );
    expect(proposal.citedItemIds).toHaveLength(2);
    expect(proposal.requiredPartyIds).toHaveLength(2);
    expect(
      [...admin.db.delivery.iter()].filter(
        (d) => d.kind === "proposal" && d.lobbyId === lobbyId,
      ),
    ).toHaveLength(2);
  });
  it("writes an aligned contract without a proposal", async () => {
    await planned(true);
    await analyze("compatible");
    const contract = await waitFor(() =>
      [...admin.db.contract.iter()].find((c) => c.lobbyId === lobbyId),
    );
    expect(contract.source).toBe("aligned");
    expect(
      [...admin.db.proposal.iter()].filter((p) => p.lobbyId === lobbyId),
    ).toHaveLength(0);
  });
  it("rejects a stale inputKey and re-leases the same expired job", async () => {
    const job = await planned();
    await leasable();
    const token = randomUUID();
    expect(await worker.leaseJob(job.id, token)).toBe(true);
    const input = await worker.buildAnalysisInput(job.id);
    await expect(
      worker.submitAnalysis(
        job.id,
        token,
        input.inputKey + ":stale",
        findings(input),
      ),
    ).rejects.toThrow("stale inputKey");
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect((await analyze()).attempts).toBe(2);
  });
  it("recovers an expired lease in a new worker connection", async () => {
    const job = await planned();
    await leasable();
    expect(await worker.leaseJob(job.id, randomUUID())).toBe(true);
    worker.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 2200));
    worker = await SpacetimeDibsDb.connect({
      uri: uri!,
      dbName,
      token: workerToken,
    });
    expect((await analyze()).attempts).toBe(2);
  });
  it("leases a queued job on sight, with no rescan, and heartbeats its own name", async () => {
    const model: ModelClient = {
      name: "live-fake",
      analyze: async () => {
        const job = await waitFor(() =>
          [...admin.db.job.iter()].find((j) => j.lobbyId === lobbyId),
        );
        return {
          findings: findings(await worker.buildAnalysisInput(job.id)),
          usage: { inputTokens: 0, outputTokens: 0 },
          latencyMs: 0,
          model: "live-fake",
        };
      },
    };
    // The rescan never fires during the test, so only the job row's update can start the lease.
    const logs: [string, Record<string, unknown> | undefined][] = [];
    const loop = new WorkerLoop({
      db: worker,
      model,
      health: new HealthState(),
      log: (msg, extra) => logs.push([msg, extra]),
      pollMs: 3_600_000,
      heartbeatMs: 3_600_000,
    });
    loop.start();
    try {
      await publishPlans();
      const job = await waitFor(() =>
        [...admin.db.job.iter()].find(
          (j) => j.lobbyId === lobbyId && j.state === "done",
        ),
      );
      const events = [...admin.db.event.iter()].filter(
        (e) => e.lobbyId === lobbyId && e.subjectId === job.id,
      );
      const leasedUs = events.find((e) => e.type === "job_leased")!.atUs;
      const queuedUs = events
        .filter((e) => e.type === "job_queued" && e.atUs <= leasedUs)
        .reduce((last, e) => (e.atUs > last ? e.atUs : last), 0n);
      expect(queuedUs).toBeGreaterThan(0n);
      expect(Number(leasedUs - queuedUs) / 1000).toBeLessThan(2000);
      const beat = await waitFor(() => admin.db.service.name.find("worker"));
      expect(beat.lastBeatUs).toBeGreaterThan(0n);
      // Today's module refuses the `analysis` alias (own name only); the worker must recognise
      // that refusal to back off instead of logging a module ERROR every beat.
      const refused = logs.find(
        ([msg, extra]) =>
          msg === "heartbeat failed" && extra?.name === "analysis",
      );
      if (refused) expect(String(refused[1]?.error)).toContain("own name");
    } finally {
      loop.stop();
    }
  });
  it("records deterministic notices when model citations are invalid", async () => {
    const job = await planned();
    await leasable();
    const input = await worker.buildAnalysisInput(job.id);
    const invalid = findings(input);
    invalid.findings[0].citedItemIds = [99999];
    await new WorkerLoop({
      db: worker,
      model: new FakeModelClient({ resolver: () => invalid }),
      health: new HealthState(),
      log: () => {},
    }).tick();
    await waitFor(() =>
      [...admin.db.job.iter()].find(
        (j) => j.id === job.id && j.state === "failed",
      ),
    );
    expect(
      [...admin.db.proposal.iter()].filter((p) => p.lobbyId === lobbyId),
    ).toHaveLength(0);
    expect(
      [...admin.db.delivery.iter()].filter(
        (d) => d.lobbyId === lobbyId && d.kind === "notice",
      ),
    ).toHaveLength(2);
  });
  it("reports a disconnected database instead of trusting cached rows", async () => {
    const health = new HealthState();
    worker.disconnect();
    await new WorkerLoop({
      db: worker,
      model: new FakeModelClient(),
      health,
      log: () => {},
    }).tick();
    expect(health.report().db).toBe("disconnected");
    worker = await SpacetimeDibsDb.connect({
      uri: uri!,
      dbName,
      token: workerToken,
    });
  });
});

import { cp, mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { connect, subscribeLobby, type DbConnection } from "@dibs/client";
import {
  ownerSql,
  publishLocal,
} from "../../packages/cli/src/commands/local.ts";
import { all, waitFor } from "../../packages/cli/src/commands/common.ts";
import { PROVIDERS, type Provider } from "@dibs/protocol";
import { setGlobalLogLevel } from "spacetimedb";
setGlobalLogLevel("warn");
export const uri = process.env.DIBS_TEST_URI || "http://127.0.0.1:3000";
export const buildHash = "test-v1";
export const testTiming = {
  debounceSec: 0.15,
  analyzeAnywaySec: 2,
  fallbackSec: 4,
  endSec: 12,
  leaseSec: 1,
};
export async function prepare() {
  try {
    await fetch(uri, { signal: AbortSignal.timeout(2000) });
  } catch {
    throw new Error(
      `Local test server is unavailable at ${uri}; start it or set DIBS_TEST_URI to a local instance.`,
    );
  }
  const source = fileURLToPath(new URL("../src/", import.meta.url));
  const path = fileURLToPath(new URL("../.test-module/", import.meta.url));
  await mkdir(path, { recursive: true });
  await cp(source, join(path, "src"), { recursive: true });
  await writeFile(
    join(path, "src/timing.ts"),
    `export const timing = ${JSON.stringify(testTiming)};\n`,
  );
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { spacetimedb: "^2.13.0" },
    }),
  );
  await writeFile(
    join(path, "tsconfig.json"),
    JSON.stringify({ extends: "../../tsconfig.base.json", include: ["src"] }),
  );
  process.env.DIBS_HOME = await mkdtemp(join(tmpdir(), "dibs-state-test-"));
  return path;
}
export async function fresh(modulePath: string) {
  const dbName = `dibs-i1-test-${Date.now()}-${randomUUID().slice(0, 6)}`;
  publishLocal(uri, dbName, modulePath);
  const code = String(ownerSql(uri, dbName, "SELECT code FROM invite")[0][0]);
  const connections: DbConnection[] = [];
  async function claim(code: string) {
    const session = await connect({ uri, dbName });
    connections.push(session.conn);
    await session.conn.reducers.claimInvite({ code });
    await all(session.conn);
    return session;
  }
  const adminSession = await claim(code),
    admin = adminSession.conn;
  const peer = {} as Record<Provider | "worker" | "verifier", DbConnection>;
  const tokens: Record<string, string> = { admin: adminSession.token };
  for (const name of [...PROVIDERS, "worker", "verifier"] as const) {
    const invite = randomUUID();
    await admin.reducers.createInvite({
      code: invite,
      name,
      provider: PROVIDERS.includes(name as Provider) ? name : "claude",
      role: name === "worker" || name === "verifier" ? name : "agent",
    });
    const session = await claim(invite);
    peer[name] = session.conn;
    tokens[name] = session.token;
  }
  async function lobby(
    mode = "dibs",
    join = [...PROVIDERS] as Provider[],
    start = true,
  ) {
    const before = new Set([...admin.db.lobby.iter()].map((l) => l.id));
    await admin.reducers.createLobby({
      scenario: "test",
      mode,
      baseSha: "a".repeat(40),
      vocabularyJson: JSON.stringify([
        { key: "auth.session", description: "Session format" },
        { key: "events.registration", description: "Registration format" },
      ]),
      charter: "Integration test",
      buildHash,
    });
    const l = await waitFor(() =>
      [...admin.db.lobby.iter()].find((l) => !before.has(l.id)),
    );
    for (const name of join)
      await peer[name].reducers.joinLobby({ lobbyId: l.id, buildHash });
    if (start) await admin.reducers.startLobby({ lobbyId: l.id });
    return l.id;
  }
  const plan = async (
    name: Provider,
    value = name === "claude" ? "bearer" : "cookie",
    requestId = randomUUID(),
  ) => {
    await peer[name].reducers.publishPlan({
      requestId,
      goal: name,
      produces: name === "claude" ? [{ key: "auth.session", text: value }] : [],
      requires: name !== "claude" ? [{ key: "auth.session", text: value }] : [],
      notes: "",
    });
    await waitFor(() =>
      [...admin.db.plan.iter()].some((p) => p.requestId === requestId),
    );
    await waitFor(() =>
      [...peer.worker.db.plan.iter()].some((p) => p.requestId === requestId),
    );
    return requestId;
  };
  async function planned(mode = "dibs") {
    const lobbyId = await lobby(mode);
    for (const p of PROVIDERS) await plan(p);
    await waitFor(
      () =>
        [...admin.db.plan.iter()].filter(
          (p) => p.lobbyId === lobbyId && p.current,
        ).length === 3,
    );
    return lobbyId;
  }
  async function job(lobbyId: number) {
    return waitFor(
      () =>
        [...peer.worker.db.job.iter()].find(
          (j) => j.lobbyId === lobbyId && j.state === "queued",
        ),
      5000,
    );
  }
  async function lease(lobbyId: number) {
    const j = await job(lobbyId),
      leaseToken = randomUUID();
    await peer.worker.reducers.leaseJob({ jobId: j.id, leaseToken });
    return { jobId: j.id, leaseToken, inputKey: j.inputKey };
  }
  async function analyze(
    lobbyId: number,
    relation = "conflict",
    contractText = "cookie",
    citedItemIds?: number[],
  ) {
    const args = await lease(lobbyId);
    const ids =
      citedItemIds ??
      [...peer.worker.db.planItem.iter()]
        .filter(
          (i) => i.current && i.lobbyId === lobbyId && i.key === "auth.session",
        )
        .map((i) => i.id);
    await peer.worker.reducers.submitAnalysis({
      ...args,
      findingsJson: JSON.stringify({
        findings: [
          {
            key: "auth.session",
            relation,
            citedItemIds: ids,
            explanation: "test basis",
            contractText,
          },
        ],
      }),
    });
    await waitFor(() => admin.db.job.id.find(args.jobId)?.state === "done");
  }
  async function proposal(lobbyId: number) {
    return waitFor(() =>
      [...admin.db.proposal.iter()].find(
        (p) => p.lobbyId === lobbyId && p.state === "proposed",
      ),
    );
  }
  async function vote(
    name: Provider,
    p: { id: number; revision: number },
    decision = "accept",
  ) {
    return peer[name].reducers.respond({
      requestId: randomUUID(),
      proposalId: p.id,
      revision: p.revision,
      decision,
      reason: decision === "reject" ? "I disagree" : "",
    });
  }
  async function agreed() {
    const lobbyId = await planned();
    await analyze(lobbyId);
    const p = await proposal(lobbyId);
    for (const name of PROVIDERS) await vote(name, p);
    await waitFor(() =>
      [...admin.db.contract.iter()].find(
        (c) => c.lobbyId === lobbyId && c.current,
      ),
    );
    return lobbyId;
  }
  return {
    dbName,
    admin,
    peer,
    tokens,
    connections,
    lobby,
    plan,
    planned,
    job,
    lease,
    analyze,
    proposal,
    vote,
    agreed,
    close() {
      for (const c of connections) c.disconnect();
    },
    async stranger() {
      const session = await connect({ uri, dbName });
      connections.push(session.conn);
      return session.conn;
    },
  };
}
export type Harness = Awaited<ReturnType<typeof fresh>>;

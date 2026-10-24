import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, subscribeLobby, type DbConnection } from "@dibs/client";
import {
  saveConfig,
  saveToken,
  dibsHome,
  participantDir,
} from "@dibs/client/node";
import { PROVIDERS, type Provider } from "@dibs/protocol";
import { options, waitFor, all } from "./common.ts";
import { publishLocal, ownerSql, spacetime, localOnly } from "./local.ts";
import { snapshot } from "./export.ts";

const plans = JSON.parse(
  await readFile(new URL("./fixtures/plans.json", import.meta.url), "utf8"),
);
const findings = JSON.parse(
  await readFile(new URL("./fixtures/findings.json", import.meta.url), "utf8"),
);
export async function main(args: string[]) {
  const { values, positionals } = options(args, [
    "db",
    "uri",
    "worker",
    "agents",
    "stop-after",
    "scenario",
    "out",
  ]);
  if (positionals.length) throw new Error("sim accepts options only");
  const uri =
    typeof values.uri === "string" ? values.uri : "http://127.0.0.1:3000";
  const dbName = typeof values.db === "string" ? values.db : "dibs-i1-sim";
  const worker = values.worker ?? "fake",
    agentMode = values.agents ?? "fake",
    stop = values["stop-after"] ?? "verified",
    scenario = values.scenario ?? "s2";
  if (
    !["fake", "none"].includes(String(worker)) ||
    !["fake", "none"].includes(String(agentMode)) ||
    !["plans", "proposal", "agreed", "verified"].includes(String(stop)) ||
    !["s2", "aligned", "escalate"].includes(String(scenario))
  )
    throw new Error("invalid simulator option");
  if (scenario === "aligned" && stop === "proposal")
    throw new Error("aligned creates a contract without a proposal");
  localOnly(uri, dbName);
  const originalHome = process.env.DIBS_HOME;
  if (!originalHome)
    process.env.DIBS_HOME = await mkdtemp(join(tmpdir(), "dibs-sim-"));
  const home = dibsHome();
  const connections: DbConnection[] = [];
  let observer: DbConnection | undefined,
    lobbyId = 0;
  const run = randomUUID().slice(0, 8);
  try {
    await mkdir(home, { recursive: true });
    publishLocal(uri, dbName);
    await saveConfig({ dbUri: uri, dbName });
    let adminName = `admin-${run}`;
    // Read the initial admin invite as the publishing owner. On repeated runs, create
    // a fresh admin invite through the same owner's authenticated CLI identity.
    const codes = ownerSql(
      uri,
      dbName,
      "SELECT code FROM invite WHERE name = 'admin' AND used = false",
    );
    let adminCode: string;
    if (codes.length) {
      adminCode = String(codes[0][0]);
      adminName = "admin";
    } else {
      adminCode = randomUUID();
      spacetime([
        "call",
        "--server",
        uri,
        dbName,
        "create_invite",
        JSON.stringify(adminCode),
        JSON.stringify(adminName),
        '"claude"',
        '"admin"',
      ]);
    }
    async function claim(name: string, code: string) {
      const session = await connect({ uri, dbName });
      connections.push(session.conn);
      await session.conn.reducers.claimInvite({ code });
      await saveToken(name, session.token);
      return session.conn;
    }
    observer = await claim(adminName, adminCode);
    await all(observer);
    const admin = observer;
    const peers = {} as Record<Provider | "worker" | "verifier", DbConnection>;
    const names: Record<string, string> = {};
    for (const name of [...PROVIDERS, "worker", "verifier"] as const) {
      const code = randomUUID(),
        uniqueName = `${name}-${run}`;
      names[name] = uniqueName;
      await admin.reducers.createInvite({
        code,
        name: uniqueName,
        provider: PROVIDERS.includes(name as Provider) ? name : "claude",
        role: name === "worker" || name === "verifier" ? name : "agent",
      });
      peers[name] = await claim(uniqueName, code);
    }
    await admin.reducers.createLobby({
      scenario: `SIMULATION-${scenario}-${run}`,
      mode: "dibs",
      baseSha: "0".repeat(40),
      vocabularyJson: JSON.stringify([
        {
          key: "auth.session",
          description: "Authentication session transport",
        },
      ]),
      charter:
        "SIMULATION ONLY: canned agents, canned analysis and synthetic verification. This run is not benchmark or test evidence.",
      buildHash: "sim-v1",
    });
    const l = await waitFor(() =>
      [...admin.db.lobby.iter()].find(
        (l) => l.scenario === `SIMULATION-${scenario}-${run}`,
      ),
    );
    lobbyId = l.id;
    for (const name of PROVIDERS) {
      await peers[name].reducers.joinLobby({ lobbyId, buildHash: "sim-v1" });
      await subscribeLobby(peers[name], lobbyId);
    }
    await subscribeLobby(peers.worker, lobbyId);
    await subscribeLobby(peers.verifier, lobbyId);
    await admin.reducers.startLobby({ lobbyId });
    await waitFor(() => admin.db.lobby.id.find(lobbyId)?.state === "running");
    for (const name of PROVIDERS) {
      const session = {
        participant: names[name],
        provider: name,
        lobbyId,
        mode: "dibs",
        clonePath: process.cwd(),
        baseSha: l.baseSha,
        startedAtUs: Number(admin.db.lobby.id.find(lobbyId)!.startedAtUs),
        fallbackAtUs: Number(admin.db.lobby.id.find(lobbyId)!.fallbackAtUs),
        endsAtUs: Number(admin.db.lobby.id.find(lobbyId)!.endsAtUs),
      };
      await writeFile(
        join(participantDir(names[name]), "session.json"),
        JSON.stringify(session, null, 2),
      );
    }
    await writeFile(
      join(home, `sim-${lobbyId}.json`),
      JSON.stringify(
        { lobbyId, admin: adminName, participants: names },
        null,
        2,
      ),
    );
    if (agentMode === "none") return;
    for (const name of PROVIDERS)
      await peers[name].reducers.publishPlan({
        requestId: randomUUID(),
        ...plans[scenario === "aligned" ? "aligned" : "s2"][name],
      });
    await waitFor(
      () =>
        [...admin.db.job.iter()].find(
          (j) => j.lobbyId === lobbyId && j.state === "queued",
        ),
      15000,
    );
    if (stop === "plans" || worker === "none") return;
    async function analyze(template: string) {
      const j = await waitFor(() =>
        [...peers.worker.db.job.iter()].find(
          (j) => j.lobbyId === lobbyId && j.state === "queued",
        ),
      );
      const leaseToken = randomUUID();
      await peers.worker.reducers.leaseJob({ jobId: j.id, leaseToken });
      await peers.worker.reducers.submitAnalysis({
        jobId: j.id,
        leaseToken,
        inputKey: j.inputKey,
        findingsJson: JSON.stringify({
          findings: [
            {
              ...findings[template],
              citedItemIds: [...peers.worker.db.planItem.iter()]
                .filter((i) => i.lobbyId === lobbyId && i.current)
                .map((i) => i.id),
            },
          ],
        }),
      });
    }
    await analyze(scenario === "aligned" ? "aligned" : "s2");
    if (scenario !== "aligned") {
      let proposal = await waitFor(() =>
        [...admin.db.proposal.iter()].find(
          (p) => p.lobbyId === lobbyId && p.state === "proposed",
        ),
      );
      if (stop === "proposal") return;
      if (scenario === "escalate") {
        await peers.claude.reducers.respond({
          requestId: randomUUID(),
          proposalId: proposal.id,
          revision: proposal.revision,
          decision: "reject",
          reason: "SIMULATION: first rejection",
        });
        await analyze("revised");
        proposal = await waitFor(() =>
          [...admin.db.proposal.iter()].find(
            (p) =>
              p.lobbyId === lobbyId &&
              p.state === "proposed" &&
              p.revision === 2,
          ),
        );
        await peers.codex.reducers.respond({
          requestId: randomUUID(),
          proposalId: proposal.id,
          revision: proposal.revision,
          decision: "reject",
          reason: "SIMULATION: second rejection",
        });
        await waitFor(
          () => admin.db.proposal.id.find(proposal.id)?.state === "escalated",
        );
        return;
      }
      for (const name of PROVIDERS)
        await peers[name].reducers.respond({
          requestId: randomUUID(),
          proposalId: proposal.id,
          revision: proposal.revision,
          decision: "accept",
          reason: "",
        });
    }
    await waitFor(() =>
      [...admin.db.contract.iter()].find(
        (c) => c.lobbyId === lobbyId && c.current,
      ),
    );
    if (stop === "agreed") return;
    for (const [i, name] of PROVIDERS.entries())
      await peers[name].reducers.reportHead({
        lobbyId,
        sha: String(i + 1).repeat(40),
        outOfAreaFiles: [],
      });
    const hash = "f".repeat(64);
    await peers.verifier.reducers.recordVerification({
      lobbyId,
      assembledFrom: JSON.stringify(
        Object.fromEntries(
          PROVIDERS.map((p, i) => [p, String(i + 1).repeat(40)]),
        ),
      ),
      treeHash: hash,
      mergeTreeClean: true,
      oracleHash: hash,
      exitCode: 0,
      passed: 1,
      total: 1,
      reportHash: hash,
    });
    const v = await waitFor(() =>
      [...peers.verifier.db.verification.iter()].find(
        (v) => v.lobbyId === lobbyId,
      ),
    );
    await peers.verifier.reducers.recordReview({
      lobbyId,
      verificationId: v.id,
      kind: "conformance",
      summary: "SIMULATION: synthetic review; no model was called.",
      findingsJson: JSON.stringify({
        summary: "SIMULATION",
        clauses: [],
        rootCause: null,
      }),
      model: "fake",
      sessionId: `sim-${run}`,
    });
    await peers.verifier.reducers.markVerified({ lobbyId });
    await waitFor(() => admin.db.lobby.id.find(lobbyId)?.state === "verified");
  } finally {
    try {
      if (observer && lobbyId) {
        const data = snapshot(
          observer,
          lobbyId,
          `SIMULATION / ${String(scenario)} / canned agents and worker`,
        );
        // Allow the observer's subscription to receive final transactions before export.
        await new Promise((resolve) => setTimeout(resolve, 75));
        const final = snapshot(observer, lobbyId, data.label);
        const path =
          typeof values.out === "string"
            ? values.out
            : join(home, `sim-${lobbyId}-events.json`);
        await mkdir(dirname(resolve(path)), { recursive: true });
        await writeFile(path, JSON.stringify(final, null, 2) + "\n");
        const proposals = final.tables.proposal,
          contracts = final.tables.contract;
        console.log(
          `SIMULATION — synthetic data, not benchmark evidence\nDatabase: ${dbName}\nLobby: ${lobbyId}\nState: ${final.tables.lobby[0]?.state}\nJob: ${final.tables.job[0]?.state ?? "none"}\nProposals: ${proposals.map((p) => `P${p.id}/r${p.revision}:${p.state}`).join(", ") || "none"}\nContracts: ${contracts.map((c) => c.source).join(", ") || "none"}\nDIBS_HOME: ${home}\nExport: ${path}`,
        );
      }
    } finally {
      for (const c of connections) c.disconnect();
      if (originalHome === undefined) delete process.env.DIBS_HOME;
      else process.env.DIBS_HOME = originalHome;
    }
  }
}

// This is a scripted CI smoke with a REAL hosted worker/model. It is not a
// claim that native Claude/Codex launch/trust was tested on two user laptops.
import fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { connect, tables } from "../../packages/client/src/index.ts";
const url = process.env.DIBS_DEPLOY_URL!,
  uri = process.env.SPACETIME_URI!,
  dbName = process.env.SPACETIME_DB!;
if (!url || !uri || !dbName)
  throw new Error("Deployment coordinates are missing.");
const deadline = Date.now() + 180_000;
async function wait<T>(read: () => Promise<T | undefined>): Promise<T> {
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    "Deployed worker did not satisfy the readiness/coordination check within three minutes.",
  );
}
async function json(route: string) {
  const response = await fetch(url + route, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(`Deployed ${route} returned HTTP ${response.status}`);
  return response.json() as Promise<Record<string, any>>;
}
const config = await wait(async () => {
  try {
    const value = await json("/config.json");
    const health = await json("/health/status");
    return value.buildSha === process.env.GITHUB_SHA &&
      health.db === "connected"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
});
if (
  config.dbName !== dbName ||
  config.dbUri !== uri ||
  config.projectProtocol !== "project-v1"
)
  throw new Error(
    "Deployed config does not match this schema/database/protocol.",
  );
const page = await fetch(url, { signal: AbortSignal.timeout(5000) });
if (!page.ok || !(await page.text()).includes("<html"))
  throw new Error("Dashboard HTML is unavailable.");
const sessions: Awaited<ReturnType<typeof connect>>[] = [];
let lobbyId: number | undefined;
async function open() {
  const session = await connect({ uri, dbName });
  sessions.push(session);
  await new Promise<void>((resolve, reject) =>
    session.conn
      .subscriptionBuilder()
      .onApplied(() => resolve())
      .onError((ctx) => reject(ctx.event))
      .subscribe([
        tables.participant,
        tables.lobby,
        tables.job,
        tables.proposal,
        tables.contract,
        tables.service,
      ]),
  );
  return session;
}
try {
  const claude = await open(),
    codex = await open();
  const code = randomBytes(24).toString("hex");
  await claude.conn.reducers.createProject({
    code,
    provider: "claude",
    brief:
      "Deployment smoke: backend and frontend must agree on a greeting API route and response JSON.",
    vocabularyJson:
      '[{"key":"project.interface","description":"The greeting endpoint route and JSON fields"}]',
    protocol: "project-v1",
  });
  const me = await wait(async () =>
    [...claude.conn.db.participant.iter()].find((p) =>
      p.identity.isEqual(claude.identity),
    ),
  );
  lobbyId = me.currentLobbyId;
  if (!lobbyId) throw new Error("Smoke project was not created.");
  await codex.conn.reducers.joinProject({
    code,
    provider: "codex",
    protocol: "project-v1",
  });
  const heartbeat =
    claude.conn.db.service.name.find("worker")?.lastBeatUs ?? 0n;
  await claude.conn.reducers.publishPlan({
    requestId: randomUUID(),
    goal: "Provide the greeting API",
    produces: [
      {
        key: "project.interface",
        text: "Prefer GET /api/greeting with JSON {message:string}. This is negotiable.",
      },
    ],
    requires: [],
    notes: "CI deployment smoke",
  });
  await codex.conn.reducers.publishPlan({
    requestId: randomUUID(),
    goal: "Consume the greeting API",
    produces: [],
    requires: [
      {
        key: "project.interface",
        text: "Prefer GET /api/hello with JSON {text:string}. This is negotiable.",
      },
    ],
    notes: "CI deployment smoke",
  });
  await wait(async () =>
    [...claude.conn.db.job.iter()].find(
      (j) => j.lobbyId === lobbyId && j.state === "done",
    ),
  );
  const proposal = await wait(async () =>
    [...claude.conn.db.proposal.iter()].find(
      (p) => p.lobbyId === lobbyId && p.state === "proposed",
    ),
  );
  if (proposal.requiredPartyIds.length !== 2)
    throw new Error(
      "The real analysis did not identify both required parties.",
    );
  for (const peer of [claude, codex])
    await peer.conn.reducers.respond({
      requestId: randomUUID(),
      proposalId: proposal.id,
      revision: proposal.revision,
      decision: "accept",
      reason: "",
    });
  const contract = await wait(async () =>
    [...claude.conn.db.contract.iter()].find(
      (c) => c.lobbyId === lobbyId && c.source === "agreed",
    ),
  );
  await wait(async () => {
    const next = claude.conn.db.service.name.find("worker")?.lastBeatUs;
    return next && next > heartbeat ? true : undefined;
  });
  const health = await json("/health/status");
  fs.mkdirSync("release", { recursive: true });
  fs.writeFileSync(
    "release/deployment.json",
    JSON.stringify(
      {
        sha: process.env.GITHUB_SHA,
        image: process.env.DIBS_IMAGE,
        tag: process.env.DIBS_IMAGE_TAG,
        url,
        database: dbName,
        protocol: "project-v1",
        smoke: "scripted clients / real cloud analysis",
        lobbyId,
        contractId: contract.id,
        analysisLatencyMs: health.lastAnalysisLatencyMs,
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    "Verified deployed SHA, database, dashboard, worker heartbeat and a real two-party analysis/agreement.",
  );
} finally {
  try {
    if (lobbyId && sessions[0])
      await sessions[0].conn.reducers.closeProject({ lobbyId });
  } finally {
    for (const session of sessions) session.conn.disconnect();
  }
}

// Issue 2's "loop on the local DB", with real agents on Windows: headless Claude Code and
// `codex exec` join one dibs-mode lobby as `claude` and `codex` through the generated provider
// configs, publish plans with dibs_plan, see the proposal through the hook or dibs_status, and
// answer it with dibs_respond. Droid and the worker are canned. Spends API credit on both CLIs.
//
//   npm run build -w @dibs/bridge
//   node node_modules/tsx/dist/cli.mjs packages/bridge/scripts/agents-loop.mts \
//     [--uri http://127.0.0.1:4120] [--db dibs-i2-agents] [--codex-hooks]
//
// Codex runs with the user's own login (CODEX_HOME untouched); trust for the temp clone is
// passed with -c for this run only. Codex runs hooks only after their trust is accepted in its
// TUI, which a headless run can't do, so by default Codex is checked through MCP alone.
// --codex-hooks adds --dangerously-bypass-hook-trust (plan Appendix A) for this run; use it only
// if you accept that flag.

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { connect, type DbConnection } from "@dibs/client";
import { all, waitFor } from "../../cli/src/commands/common.ts";
import { localBuildHash } from "../src/build-hash.ts";
import { git } from "../src/git.ts";
import { killTree, resolveCommand, resolveExe } from "../src/proc.ts";
import { launchFiles, trustKey, writeProvider } from "../src/providers.ts";

const { values } = parseArgs({
  options: {
    uri: { type: "string", default: "http://127.0.0.1:4120" },
    db: { type: "string", default: "dibs-i2-agents" },
    "codex-hooks": { type: "boolean", default: false },
  },
});
const uri = values.uri;
const dbName = values.db;
if (
  !/^dibs-i2-/.test(dbName) ||
  !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri)
)
  throw new Error("use a loopback server and a dibs-i2-* database");

const KEY = "auth.session";
const CONTRACT =
  "POST /api/login sets an HttpOnly cookie `sid`; the browser sends it automatically with credentials: 'include'. No bearer token.";
const hash = localBuildHash();
// Long real paths: Codex trust and its Windows sandbox grants are keyed by the long path.
const tmp = fs.realpathSync.native(os.tmpdir());
const home = fs.mkdtempSync(path.join(tmp, "dibs-agents-"));
const codexHome = fs.mkdtempSync(path.join(tmp, "dibs-agents-codexhome-"));
const log = (...parts: unknown[]) => console.error("[loop]", ...parts);

spacetime([
  "publish",
  "--server",
  uri,
  "--module-path",
  "spacetime",
  "--yes",
  "--delete-data",
  dbName,
]);
const adminCode = JSON.parse(
  spacetime([
    "sql",
    "--server",
    uri,
    "--format",
    "json",
    dbName,
    "SELECT code FROM invite WHERE name = 'admin'",
  ]),
)[0].rows[0][0] as string;

const open: DbConnection[] = [];
const admin = (await claim(adminCode)).conn;
await all(admin);
const tokens: Record<string, string> = {};
const conns: Record<string, DbConnection> = {};
for (const [name, provider, role] of [
  ["claude", "claude", "agent"],
  ["codex", "codex", "agent"],
  ["droid", "droid", "agent"],
  ["worker", "claude", "worker"],
] as const) {
  const code = randomUUID();
  await admin.reducers.createInvite({ code, name, provider, role });
  const session = await claim(code);
  tokens[name] = session.token;
  conns[name] = session.conn;
}
await admin.reducers.createLobby({
  scenario: `agents-${randomUUID().slice(0, 8)}`,
  mode: "dibs",
  baseSha: "0".repeat(40),
  vocabularyJson: JSON.stringify([
    { key: KEY, description: "How the browser stays logged in after login" },
  ]),
  charter:
    "Issue 2 live loop: real Claude Code and Codex, canned Droid and worker.",
  buildHash: hash,
});
const lobby = await waitFor(() => [...admin.db.lobby.iter()].at(-1));
const lobbyId = lobby.id;
for (const name of ["claude", "codex", "droid"])
  await conns[name].reducers.joinLobby({ lobbyId, buildHash: hash });
await admin.reducers.startLobby({ lobbyId });
const running = await waitFor(() => {
  const row = admin.db.lobby.id.find(lobbyId);
  return row?.state === "running" && row;
});
// The bridges connect with these identities; close ours first so presence belongs to them.
conns.claude.disconnect();
conns.codex.disconnect();
const id = (name: string) =>
  [...admin.db.participant.iter()].find((p) => p.name === name)!.id;

fs.writeFileSync(
  path.join(home, "config.json"),
  JSON.stringify({ dbUri: uri, dbName }),
);
const clones: Record<string, string> = {};
for (const name of ["claude", "codex"] as const) {
  const clone = fs.mkdtempSync(path.join(tmp, `dibs-agents-${name}-`));
  await git(clone, ["init", "-b", "main"]);
  fs.writeFileSync(
    path.join(clone, "README.md"),
    "A tiny login demo. Backend in auth.js, browser code in client.js.\n",
  );
  await git(clone, ["add", "-A"]);
  await git(clone, [
    "-c",
    "user.name=dibs",
    "-c",
    "user.email=dibs@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  clones[name] = clone;
  const dir = path.join(home, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "token"), tokens[name]);
  fs.writeFileSync(
    path.join(dir, "session.json"),
    JSON.stringify({
      participant: name,
      provider: name,
      lobbyId,
      mode: "dibs",
      clonePath: clone,
      baseSha: running.baseSha,
      startedAtUs: Number(running.startedAtUs),
      fallbackAtUs: Number(running.fallbackAtUs),
      endsAtUs: Number(running.endsAtUs),
    }),
  );
  writeProvider({
    participant: name,
    provider: name,
    clonePath: clone,
    home,
    codexHome,
  });
}
log("lobby", lobbyId, "home", home);

const brief = (role: string, keyLine: string, file: string) =>
  [
    `You are the ${role} developer on a three-person team. Your teammates are other coding agents; you coordinate with them only through the dibs tools.`,
    `Before writing code, publish your plan with dibs_plan. ${keyLine} The shared key is ${KEY} (how the browser stays logged in after login).`,
    `Then call dibs_status with waitSec 45, repeating, until ${KEY} is agreed. If a proposal awaits your response, answer it with dibs_respond (accept unless it is unworkable for you).`,
    `Once ${KEY} is agreed, write ${file} (under 25 lines) following the agreed contract exactly, then stop. Don't start servers or install packages.`,
  ].join("\n");
const prompts = {
  claude: brief(
    "backend",
    `You produce ${KEY}: say how login keeps the user signed in.`,
    "auth.js",
  ),
  codex: brief(
    "frontend",
    `You require ${KEY}: say what the browser code needs from login.`,
    "client.js",
  ),
};

// Canned droid: requires the key, accepts every proposal it is party to.
await conns.droid.reducers.publishPlan({
  requestId: randomUUID(),
  goal: "Events page",
  produces: [],
  requires: [
    {
      key: KEY,
      text: "The events page only needs to know which user is logged in; any session format works.",
    },
  ],
  notes: "",
});

const claudeFiles = launchFiles("claude", home, "claude");
const claudeRun = launch(
  "claude",
  [
    resolveExe("claude"),
    "-p",
    prompts.claude,
    "--settings",
    claudeFiles.settings!,
    "--mcp-config",
    claudeFiles.mcp!,
    "--strict-mcp-config",
    "--permission-mode",
    "acceptEdits",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-hook-events",
    "--max-turns",
    "30",
    "--max-budget-usd",
    "2",
    "--model",
    "sonnet",
  ],
  clones.claude,
);
const codexRun = launch(
  "codex",
  [
    ...resolveCommand("codex"),
    "exec",
    "--json",
    "--ephemeral",
    "-C",
    clones.codex,
    "--sandbox",
    "workspace-write",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-c",
    "features.memories=false",
    "-c",
    `projects={'${trustKey(clones.codex)}'={trust_level="trusted"}}`,
    ...(values["codex-hooks"] ? ["--dangerously-bypass-hook-trust"] : []),
    prompts.codex,
  ],
  clones.codex,
);

let stop = false;
const canned = (async () => {
  const answered = new Set<string>();
  while (!stop) {
    const job = [...admin.db.job.iter()].find(
      (j) => j.lobbyId === lobbyId && j.state === "queued",
    );
    if (job) {
      const leaseToken = randomUUID();
      const items = [...admin.db.planItem.iter()].filter(
        (i) => i.lobbyId === lobbyId && i.current && i.key === KEY,
      );
      const settled = [...admin.db.contract.iter()].some(
        (c) => c.lobbyId === lobbyId && c.current && c.key === KEY,
      );
      const pending = [...admin.db.proposal.iter()].some(
        (p) => p.lobbyId === lobbyId && p.state === "proposed",
      );
      const findings =
        settled || pending || items.length < 3
          ? []
          : [
              {
                key: KEY,
                relation: "conflict",
                citedItemIds: items.map((i) => i.id),
                explanation: "The plans disagree on the session transport.",
                contractText: CONTRACT,
              },
            ];
      try {
        await conns.worker.reducers.leaseJob({ jobId: job.id, leaseToken });
        await conns.worker.reducers.submitAnalysis({
          jobId: job.id,
          leaseToken,
          inputKey: job.inputKey,
          findingsJson: JSON.stringify({ findings }),
        });
        log(
          `worker: job ${job.id} (${job.kind}) -> ${findings.length ? "conflict proposal" : "no finding"}`,
        );
      } catch (error) {
        log("worker:", (error as Error).message);
      }
    }
    for (const p of admin.db.proposal.iter()) {
      const tag = `${p.id}/${p.revision}`;
      if (
        p.lobbyId !== lobbyId ||
        p.state !== "proposed" ||
        answered.has(tag) ||
        !p.requiredPartyIds.includes(id("droid"))
      )
        continue;
      answered.add(tag);
      await conns.droid.reducers.respond({
        requestId: randomUUID(),
        proposalId: p.id,
        revision: p.revision,
        decision: "accept",
        reason: "",
      });
      log(`droid: accepted proposal ${tag}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
})();

const agreed = await waitFor(
  () =>
    [...admin.db.contract.iter()].find(
      (c) => c.lobbyId === lobbyId && c.current && c.source === "agreed",
    ),
  10 * 60_000,
).catch(() => undefined);
log(
  agreed
    ? `contract agreed: ${agreed.text}`
    : "no agreed contract within 10 minutes",
);
// Let both agents write their file, then stop whatever is still running.
await Promise.race([
  Promise.all([claudeRun.exited, codexRun.exited]),
  new Promise((r) => setTimeout(r, 4 * 60_000)),
]);
for (const run of [claudeRun, codexRun])
  await killTree(run.pid).catch(() => undefined);
stop = true;
await canned;

const name = (pid: number) =>
  [...admin.db.participant.iter()].find((p) => p.id === pid)?.name ??
  String(pid);
const events = [...admin.db.event.iter()].filter((e) => e.lobbyId === lobbyId);
const report = {
  lobbyId,
  contract: spacetime([
    "sql",
    "--server",
    uri,
    dbName,
    `SELECT key, revision, source, text FROM contract WHERE lobby_id = ${lobbyId}`,
  ]),
  plans: [...admin.db.plan.iter()]
    .filter((p) => p.lobbyId === lobbyId)
    .map((p) => `${name(p.participantId)} rev ${p.revision}`),
  responses: [...admin.db.response.iter()]
    .filter((r) => r.lobbyId === lobbyId)
    .map(
      (r) =>
        `${name(r.participantId)} ${r.decision} P${r.proposalId} rev ${r.revision}`,
    ),
  proposalDeliveries: [...admin.db.delivery.iter()]
    .filter((d) => d.lobbyId === lobbyId && d.kind === "proposal")
    .map((d) => `${name(d.targetId)}: ${d.stage}`),
  eventTypes: [...new Set(events.map((e) => e.type))].join(", "),
  claude: evidence(claudeRun.logPath),
  codex: evidence(codexRun.logPath),
  files: Object.fromEntries(
    Object.entries({ claude: "auth.js", codex: "client.js" }).map(
      ([who, file]) => {
        const full = path.join(clones[who], file);
        return [
          who,
          fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "(missing)",
        ];
      },
    ),
  ),
};
console.log(JSON.stringify(report, null, 2));
for (const conn of open) conn.disconnect();
process.exit(agreed ? 0 : 1);

async function claim(code: string) {
  const session = await connect({ uri, dbName });
  open.push(session.conn);
  await session.conn.reducers.claimInvite({ code });
  return session;
}

function launch(who: string, command: string[], cwd: string) {
  const logPath = path.join(home, `${who}.log`);
  const out = fs.openSync(logPath, "w");
  const [bin, ...args] = command;
  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, DIBS_HOME: home },
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  fs.closeSync(out);
  const exited = new Promise<number>((resolve) => {
    child.once("error", (error) => {
      log(`${who}: ${error.message}`);
      resolve(1);
    });
    child.once("exit", (code) => {
      log(`${who}: exited ${code}`);
      resolve(code ?? 1);
    });
  });
  log(`${who}: pid ${child.pid}, log ${logPath}`);
  return { pid: child.pid!, exited, logPath };
}

/** Which dibs tools the agent called and whether a dibs update reached it through a hook. */
function evidence(logPath: string) {
  const raw = fs.readFileSync(logPath, "utf8");
  const tools = [...raw.matchAll(/dibs_(plan|status|respond|message)/g)].map(
    (m) => m[0],
  );
  const counts = Object.fromEntries(
    [...new Set(tools)].map((t) => [t, tools.filter((x) => x === t).length]),
  );
  const hookLines = raw
    .split(/\r?\n/)
    .filter((line) => /hook/i.test(line) && /dibs:/.test(line));
  return {
    toolMentions: counts,
    hookDeliveries: hookLines.length,
    proposalViaHook: hookLines.some((line) => /proposal/i.test(line)),
    bytes: raw.length,
  };
}

function spacetime(args: string[]): string {
  const exe = path.join(
    process.env.LOCALAPPDATA ?? "",
    "SpacetimeDB",
    "spacetime.exe",
  );
  return execFileSync(fs.existsSync(exe) ? exe : "spacetime", args, {
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

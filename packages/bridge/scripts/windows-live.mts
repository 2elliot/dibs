// Windows stand-in for the issue's Mac Codex check and the Claude Code check.
// Both CLIs run on this laptop against the live Maincloud database dibs-ch13-dev.
// The issue assigned Codex to a Mac and Droid to another Windows machine; Droid is skipped.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, subscribeLobby } from "@dibs/client";
import { connectSession, loadDbBuilder } from "../src/spacetime.ts";
import { writeProvider } from "../src/providers.ts";
import { resolveExe } from "../src/proc.ts";

const uri = "https://maincloud.spacetimedb.com";
const dbName = "dibs-ch13-dev";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-win-"));
const clone = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-win-clone-"));
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-win-codex-"));
fs.mkdirSync(clone, { recursive: true });
fs.writeFileSync(
  path.join(home, "config.json"),
  JSON.stringify({ dbUri: uri, dbName }),
);

const summary = await connect({ uri, dbName, timeoutMs: 20000 });
console.log("anon-connect", summary.identity.toHexString());
await subscribeLobby(summary.conn, 0, ["participant", "lobby"]);
const names = [...summary.conn.db.participant.iter()].map((row) => row.name);
console.log("visible-participants", names.join(",") || "(none yet)");
summary.conn.disconnect();

for (const provider of ["claude", "codex"] as const) {
  const minted = await connect({ uri, dbName, timeoutMs: 20000 });
  const dir = path.join(home, provider);
  fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
  fs.writeFileSync(path.join(dir, "token"), minted.token);
  minted.conn.disconnect();
  fs.writeFileSync(
    path.join(dir, "session.json"),
    JSON.stringify({
      participant: provider,
      provider,
      lobbyId: 0,
      mode: "chat",
      clonePath: clone,
      baseSha: "0".repeat(40),
      startedAtUs: 1,
      fallbackAtUs: 0,
      endsAtUs: 0,
    }),
  );
  fs.writeFileSync(
    path.join(dir, "inbox", "1.json"),
    JSON.stringify({
      deliveryId: 1,
      lobbyId: 0,
      kind: "notice",
      refId: 1,
      summary: `windows check: this session is aimed at the live database ${dbName}. Call dibs_status with waitSec 0 and quote the status field.`,
      queuedAtUs: 1,
    }),
  );
  writeProvider({
    participant: provider,
    provider,
    clonePath: clone,
    home,
    codexHome,
  });
  const session = await connectSession({
    builder: await loadDbBuilder(),
    uri,
    database: dbName,
    token: minted.token,
    participant: provider,
    provider,
    lobbyId: 0,
    buildHash: "0",
    join: false,
    log: (message) => console.log(`preflight-${provider}`, message),
  });
  console.log(
    `preflight-${provider}`,
    JSON.stringify({
      online: session.world().online,
      lobby: session.world().lobby?.id ?? null,
    }),
  );
  session.close();
}

const prompt =
  "A dibs hook update is in your context. Call the dibs_status tool once with waitSec 0. Quote the JSON status field. Do not edit files and do not call any other tools.";

const claudeLog = await run(
  resolveExe("claude"),
  [
    "-p",
    prompt,
    "--settings",
    path.join(home, "claude", "claude.settings.json"),
    "--mcp-config",
    path.join(home, "claude", "claude.mcp.json"),
    "--strict-mcp-config",
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-hook-events",
    "--max-turns",
    "3",
    "--max-budget-usd",
    "0.8",
    "--model",
    "sonnet",
  ],
  { DIBS_HOME: home },
);
report("claude", claudeLog);

const codexJs = path.join(
  process.env.APPDATA ?? "",
  "npm",
  "node_modules",
  "@openai",
  "codex",
  "bin",
  "codex.js",
);
const codexLog = await run(
  process.execPath,
  [
    codexJs,
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    clone,
    "-s",
    "read-only",
    prompt,
  ],
  { DIBS_HOME: home },
);
report("codex", codexLog);

function report(name: string, raw: string): void {
  const hook = raw.includes("windows check") && raw.includes(dbName);
  const status = /dibs_status/.test(raw);
  const live = raw.includes('"status":"ok"') || raw.includes('"status": "ok"');
  console.log(
    JSON.stringify({
      name,
      hook,
      mentionedStatusTool: status,
      sawOkStatus: live,
      chars: raw.length,
    }),
  );
  fs.writeFileSync(path.join(home, `${name}.log`), raw);
  console.log("log", path.join(home, `${name}.log`));
}

function run(
  command: string,
  args: string[],
  extra: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: clone,
      env: { ...process.env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let raw = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(raw);
    }, 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(raw);
    });
  });
}

// `dibs session`: prepare a clone, launch one agent, and push its final commit.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DIBS_FILES,
  MODES,
  PROVIDERS,
  TIMING,
  type DibsConfig,
  type FixtureManifest,
  type Mode,
  type Provider,
  type SessionFile,
} from "@dibs/protocol";
import { parseArgs } from "./args.ts";
import { localBuildHash, packageRoot } from "./build-hash.ts";
import { git } from "./git.ts";
import { filesOutsideArea } from "./glob.ts";
import {
  canonicalPath,
  configPath,
  isInside,
  participantDir,
  readJson,
  resolveHome,
  tokenPath,
  writeJsonAtomic,
} from "./home.ts";
import { killTree, resolveExe, spawnAgent } from "./proc.ts";
import { launchFiles, providerCommand, writeProvider } from "./providers.ts";
import { connectSession, loadDbBuilder, RemoteStore } from "./spacetime.ts";

export interface HeadReport {
  lobbyId: number;
  sha: string;
  outOfAreaFiles: string[];
  reported: boolean;
}

export interface PrepOptions {
  home: string;
  participant: string;
  provider: Provider;
  lobbyId: number;
  clonePath: string;
  lobbiesUrl: string;
  offline: boolean;
  codexHome: string;
  mode?: Mode;
  baseSha?: string;
  buildHash?: string;
  fallbackAtUs?: number;
  endsAtUs?: number;
  startedAtUs?: number;
  prompt: string;
}

interface Meta {
  mode: Mode;
  baseSha: string;
  buildHash: string;
  fallbackAtUs: number;
  endsAtUs: number;
  startedAtUs: number;
}

interface MachineFile {
  lobbiesUrl: string;
}

export async function prep(options: PrepOptions): Promise<void> {
  const clone = assertSafeClone(options.clonePath);
  const top = await git(clone, ["rev-parse", "--show-toplevel"]);
  if (canonicalPath(top) !== canonicalPath(clone))
    throw new Error("clone path is not the git work tree root");
  const meta = await resolveMeta(options);
  const local = localBuildHash();
  if (meta.buildHash !== local) {
    throw new Error(
      `build hash mismatch: this machine is ${local}, lobby wants ${meta.buildHash}`,
    );
  }
  if (!options.prompt.trim()) throw new Error("prep needs a prompt");
  await git(clone, ["reset", "--hard", meta.baseSha]);
  await git(clone, [
    "clean",
    "-ffdx",
    "-e",
    ".claude/",
    "-e",
    ".codex/",
    "-e",
    ".factory/",
    "-e",
    "node_modules/",
  ]);
  const current = await git(clone, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const refs = await git(clone, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/lobby",
  ]);
  for (const name of refs.split(/\r?\n/).filter(Boolean)) {
    if (name === current) continue;
    await git(clone, ["branch", "-D", name]);
  }
  const dir = participantDir(options.home, options.participant);
  fs.mkdirSync(dir, { recursive: true });
  const session: SessionFile = {
    participant: options.participant,
    provider: options.provider,
    lobbyId: options.lobbyId,
    mode: meta.mode,
    clonePath: path.resolve(clone),
    baseSha: meta.baseSha,
    startedAtUs: meta.startedAtUs,
    fallbackAtUs: meta.fallbackAtUs,
    endsAtUs: meta.endsAtUs,
  };
  writeJsonAtomic(path.join(dir, DIBS_FILES.session), session);
  writeJsonAtomic(path.join(dir, "machine.json"), {
    lobbiesUrl: options.lobbiesUrl,
  } satisfies MachineFile);
  writeJsonAtomic(path.join(dir, DIBS_FILES.stopBlocks), {
    lobbyId: options.lobbyId,
    count: 0,
    proposalIds: [],
  });
  fs.writeFileSync(
    path.join(dir, "prompt.txt"),
    options.prompt.endsWith("\n") ? options.prompt : `${options.prompt}\n`,
  );
  for (const name of [
    DIBS_FILES.hookAlive,
    "hook-state.json",
    "seen-messages.json",
    "last-head.json",
    "finalize.lock",
  ]) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
  for (const folder of [
    DIBS_FILES.inbox,
    DIBS_FILES.claimed,
    DIBS_FILES.shown,
  ]) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true });
  }
  writeProvider({
    participant: options.participant,
    provider: options.provider,
    clonePath: clone,
    home: options.home,
    codexHome: options.codexHome,
  });
}

export async function startSession(options: {
  home: string;
  participant: string;
  codexHome?: string;
  agentCommand?: string[];
  hookTimeoutMs?: number;
  onReady?: (info: { pid: number }) => Promise<void> | void;
}): Promise<HeadReport> {
  const loaded = loadPrepared(options.home, options.participant);
  if (databaseReady(options.home, loaded.dir))
    await waitUntilRunning(options.home, loaded.dir, loaded.session);
  const prompt = fs
    .readFileSync(path.join(loaded.dir, "prompt.txt"), "utf8")
    .trim();
  const command =
    options.agentCommand ??
    agentOverride() ??
    builtInCommand(loaded.session, options.home, prompt);
  const child = spawnAgent(command, {
    cwd: loaded.session.clonePath,
    env: {
      ...process.env,
      DIBS_HOME: options.home,
      DIBS_PARTICIPANT: options.participant,
      DIBS_LOBBY_ID: String(loaded.session.lobbyId),
      DIBS_CLONE: loaded.session.clonePath,
    },
    logPath: path.join(loaded.dir, "agent.log"),
  });
  fs.writeFileSync(path.join(loaded.dir, "agent.pid"), String(child.pid));
  let gone = false;
  void child.exited.then(() => {
    gone = true;
  });
  try {
    await waitForHookAlive(
      loaded.dir,
      loaded.session.lobbyId,
      options.hookTimeoutMs ?? TIMING.hookAliveTimeoutSec * 1000,
      () => gone,
    );
  } catch (error) {
    await killTree(child.pid);
    throw error;
  }
  if (options.onReady) await options.onReady({ pid: child.pid });
  const deadline =
    loaded.session.endsAtUs > 0
      ? loaded.session.endsAtUs / 1000
      : Date.now() + 24 * 60 * 60 * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
  });
  await Promise.race([
    child.exited,
    ended.then(async () => {
      await killTree(child.pid);
      await child.exited;
    }),
  ]);
  if (timer) clearTimeout(timer);
  return finalize(options.home, options.participant);
}

export async function stopSession(options: {
  home: string;
  participant: string;
}): Promise<HeadReport> {
  const dir = participantDir(options.home, options.participant);
  const pid = Number(fs.readFileSync(path.join(dir, "agent.pid"), "utf8"));
  if (Number.isInteger(pid)) await killTree(pid);
  return finalize(options.home, options.participant);
}

export async function waitForHookAlive(
  dir: string,
  lobbyId: number,
  timeoutMs: number,
  isGone: () => boolean = () => false,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const file = path.join(dir, DIBS_FILES.hookAlive);
  while (Date.now() < deadline) {
    const parsed = readJson(file) as { lobbyId?: number } | undefined;
    if (parsed?.lobbyId === lobbyId) return;
    if (isGone()) break;
    await sleep(50);
  }
  throw new Error(
    isGone()
      ? "the agent exited before the SessionStart hook wrote hook-alive.json"
      : `hook-alive.json for lobby ${lobbyId} did not appear within ${timeoutMs} ms`,
  );
}

export async function finalize(
  home: string,
  participant: string,
): Promise<HeadReport> {
  const { dir, session, machine } = loadPrepared(home, participant);
  return withLock(dir, async () => {
    await git(session.clonePath, ["add", "-A"]);
    await git(session.clonePath, [
      "-c",
      "user.name=dibs",
      "-c",
      "user.email=dibs@localhost",
      "commit",
      "--allow-empty",
      "-m",
      `lobby ${session.lobbyId} ${session.provider} final`,
    ]);
    const sha = await git(session.clonePath, ["rev-parse", "HEAD"]);
    const names = await git(session.clonePath, [
      "diff",
      "--name-only",
      session.baseSha,
      "HEAD",
    ]);
    const changed = names.split(/\r?\n/).filter(Boolean);
    const manifest = readManifest(session.clonePath);
    const outOfAreaFiles = filesOutsideArea(
      changed,
      manifest?.areas[session.provider] ?? [],
      manifest?.frozen ?? [],
    );
    await git(session.clonePath, [
      "push",
      machine.lobbiesUrl,
      `HEAD:refs/heads/lobby/${session.lobbyId}/${session.provider}`,
    ]);
    const reported = await report(home, dir, session, sha, outOfAreaFiles);
    const reportBody: HeadReport = {
      lobbyId: session.lobbyId,
      sha,
      outOfAreaFiles,
      reported,
    };
    writeJsonAtomic(path.join(dir, "last-head.json"), reportBody);
    return reportBody;
  });
}

export async function main(args: string[]): Promise<void> {
  try {
    const parsed = parseArgs(args);
    const command = parsed.rest[0];
    const home = resolveHome(parsed.get("home"));
    const participant =
      parsed.get("participant") || process.env.DIBS_PARTICIPANT;
    const codexHome =
      process.env.DIBS_CODEX_HOME || path.join(os.homedir(), ".codex");
    if (!participant) throw new Error("pass --participant <name>");
    if (command === "prep") {
      const lobbyId = Number(parsed.rest[1]);
      if (!Number.isInteger(lobbyId)) throw new Error(usage());
      const provider = parsed.get("provider") || participant;
      if (!isProvider(provider))
        throw new Error("pass --provider claude|codex|droid");
      const clonePath = parsed.get("clone");
      const lobbiesUrl = parsed.get("lobbies");
      if (!clonePath || !lobbiesUrl) throw new Error(usage());
      const mode = parsed.get("mode");
      if (mode !== undefined && !isMode(mode))
        throw new Error("invalid --mode");
      let prompt = parsed.get("prompt") ?? "";
      const promptFile = parsed.get("prompt-file");
      if (promptFile) prompt = fs.readFileSync(promptFile, "utf8");
      await prep({
        home,
        participant,
        provider,
        lobbyId,
        clonePath,
        lobbiesUrl,
        offline: parsed.has("offline"),
        codexHome,
        mode: mode as Mode | undefined,
        baseSha: parsed.get("base"),
        buildHash: parsed.get("build-hash"),
        fallbackAtUs: integer(parsed, "fallback-at-us"),
        endsAtUs: integer(parsed, "ends-at-us"),
        startedAtUs: integer(parsed, "started-at-us") ?? Date.now() * 1000,
        prompt,
      });
      process.stdout.write(
        `dibs session prep: lobby ${lobbyId} participant ${participant}\n`,
      );
      return;
    }
    if (command === "start") {
      const report = await startSession({ home, participant, codexHome });
      process.stdout.write(
        `dibs session start: ${report.sha} out-of-area ${report.outOfAreaFiles.length}\n`,
      );
      return;
    }
    if (command === "stop") {
      const report = await stopSession({ home, participant });
      process.stdout.write(
        `dibs session stop: ${report.sha} out-of-area ${report.outOfAreaFiles.length}\n`,
      );
      return;
    }
    throw new Error(usage());
  } catch (error) {
    process.stderr.write(
      `dibs session: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

function usage(): string {
  return [
    "usage: dibs session prep <lobbyId> --participant <name> --provider <claude|codex|droid> --clone <path> --lobbies <url> --prompt <text> [--offline --mode <mode> --base <sha> --build-hash <hex> --fallback-at-us <n> --ends-at-us <n>]",
    "       dibs session start --participant <name>",
    "       dibs session stop --participant <name>",
  ].join("\n");
}

function loadPrepared(
  home: string,
  participant: string,
): { dir: string; session: SessionFile; machine: MachineFile } {
  const dir = participantDir(home, participant);
  const session = readJson(path.join(dir, DIBS_FILES.session)) as
    SessionFile | undefined;
  const machine = readJson(path.join(dir, "machine.json")) as
    MachineFile | undefined;
  if (
    !session ||
    typeof session.clonePath !== "string" ||
    typeof session.lobbyId !== "number"
  ) {
    throw new Error("session.json is missing; run dibs session prep");
  }
  if (!machine?.lobbiesUrl)
    throw new Error("machine.json is missing; run dibs session prep");
  return { dir, session, machine };
}

async function resolveMeta(options: PrepOptions): Promise<Meta> {
  const dir = participantDir(options.home, options.participant);
  if (!options.offline && databaseReady(options.home, dir)) {
    return readLobby(
      options.home,
      dir,
      options.participant,
      options.provider,
      options.lobbyId,
    );
  }
  const mode = options.mode;
  const baseSha = options.baseSha;
  const buildHash = options.buildHash;
  const fallbackAtUs = options.fallbackAtUs;
  const endsAtUs = options.endsAtUs;
  if (
    !mode ||
    !baseSha ||
    !buildHash ||
    fallbackAtUs === undefined ||
    endsAtUs === undefined
  ) {
    throw new Error(
      "offline prep needs --mode, --base, --build-hash, --fallback-at-us and --ends-at-us (or a database token)",
    );
  }
  return {
    mode,
    baseSha,
    buildHash,
    fallbackAtUs,
    endsAtUs,
    startedAtUs: options.startedAtUs ?? Date.now() * 1000,
  };
}

function databaseReady(home: string, dir: string): boolean {
  return fs.existsSync(configPath(home)) && fs.existsSync(tokenPath(dir));
}

async function readLobby(
  home: string,
  dir: string,
  participant: string,
  provider: Provider,
  lobbyId: number,
): Promise<Meta> {
  const config = readJson(configPath(home)) as DibsConfig | undefined;
  const token = fs.readFileSync(tokenPath(dir), "utf8").trim();
  if (!config?.dbUri || !config.dbName || !token)
    throw new Error("config.json or token is unreadable");
  const remote = await connectSession({
    builder: await loadDbBuilder(),
    uri: config.dbUri,
    database: config.dbName,
    token,
    participant,
    provider,
    lobbyId,
    buildHash: localBuildHash(),
    join: false,
    log: (message) => process.stderr.write(`dibs session: ${message}\n`),
  });
  try {
    const lobby = remote.world().lobby;
    if (!lobby) throw new Error(`lobby ${lobbyId} was not found`);
    return {
      mode: lobby.mode,
      baseSha: lobby.baseSha,
      buildHash: lobby.buildHash,
      fallbackAtUs: lobby.fallbackAtUs,
      endsAtUs: lobby.endsAtUs,
      startedAtUs: lobby.startedAtUs,
    };
  } finally {
    remote.close();
  }
}

async function waitUntilRunning(
  home: string,
  dir: string,
  session: SessionFile,
): Promise<void> {
  const deadline =
    session.endsAtUs > 0 ? session.endsAtUs / 1000 : Date.now() + 120_000;
  let last = "setup";
  while (Date.now() < deadline) {
    const state = await withLobby(
      home,
      dir,
      session,
      (remote) => remote.world().lobby?.state ?? "missing",
    );
    last = state;
    if (state === "running" || state === "stopped" || state === "verified")
      return;
    await sleep(500);
  }
  throw new Error(`lobby did not start (last state: ${last})`);
}

async function withLobby<T>(
  home: string,
  dir: string,
  session: SessionFile,
  read: (remote: Awaited<ReturnType<typeof connectSession>>) => T,
): Promise<T> {
  const config = readJson(configPath(home)) as DibsConfig;
  const token = fs.readFileSync(tokenPath(dir), "utf8").trim();
  const remote = await connectSession({
    builder: await loadDbBuilder(),
    uri: config.dbUri,
    database: config.dbName,
    token,
    participant: session.participant,
    provider: session.provider,
    lobbyId: session.lobbyId,
    buildHash: localBuildHash(),
    join: false,
    log: (message) => process.stderr.write(`dibs session: ${message}\n`),
  });
  try {
    return read(remote);
  } finally {
    remote.close();
  }
}

function builtInCommand(
  session: SessionFile,
  home: string,
  prompt: string,
): string[] {
  const files = launchFiles(session.provider, home, session.participant);
  const command = providerCommand(session.provider, files, prompt);
  command[0] = resolveExe(command[0] ?? session.provider);
  return command;
}

function agentOverride(): string[] | undefined {
  const raw = process.env.DIBS_AGENT_COMMAND;
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((part) => typeof part === "string")
  ) {
    throw new Error("DIBS_AGENT_COMMAND must be a JSON array of strings");
  }
  return parsed;
}

async function report(
  home: string,
  dir: string,
  session: SessionFile,
  sha: string,
  outOfAreaFiles: string[],
): Promise<boolean> {
  if (!databaseReady(home, dir)) return false;
  try {
    const config = readJson(configPath(home)) as DibsConfig;
    const token = fs.readFileSync(tokenPath(dir), "utf8").trim();
    const remote = new RemoteStore(
      await connectSession({
        builder: await loadDbBuilder(),
        uri: config.dbUri,
        database: config.dbName,
        token,
        participant: session.participant,
        provider: session.provider,
        lobbyId: session.lobbyId,
        buildHash: localBuildHash(),
        join: false,
        log: (message) => process.stderr.write(`dibs session: ${message}\n`),
      }),
    );
    try {
      const result = await remote.reportHead(
        session.lobbyId,
        sha,
        outOfAreaFiles,
      );
      if (result.status !== "ok")
        process.stderr.write(`dibs session: report_head ${result.status}\n`);
      return result.status === "ok";
    } finally {
      remote.close();
    }
  } catch (error) {
    process.stderr.write(
      `dibs session: report_head skipped (${error instanceof Error ? error.message : String(error)})\n`,
    );
    return false;
  }
}

function readManifest(clone: string): FixtureManifest | undefined {
  const parsed = readJson(path.join(clone, "dibs.json"));
  if (!parsed || typeof parsed !== "object") return undefined;
  return parsed as FixtureManifest;
}

async function withLock(
  dir: string,
  run: () => Promise<HeadReport>,
): Promise<HeadReport> {
  const lock = path.join(dir, "finalize.lock");
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && fs.existsSync(lock)) await sleep(50);
    const existing = readJson(path.join(dir, "last-head.json")) as
      HeadReport | undefined;
    if (existing?.sha) return existing;
    throw new Error("another finalize is still running");
  }
  try {
    return await run();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function assertSafeClone(clone: string): string {
  const resolved = path.resolve(clone);
  const root = path.parse(resolved).root;
  if (canonicalPath(resolved) === canonicalPath(root))
    throw new Error("clone path is the filesystem root");
  const repo = path.resolve(packageRoot(), "../..");
  if (isInside(resolved, repo) || isInside(repo, resolved))
    throw new Error("refusing to reset the dibs checkout");
  return resolved;
}

function integer(
  args: { get(name: string): string | undefined },
  name: string,
): number | undefined {
  const value = args.get(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`invalid --${name}`);
  return parsed;
}

function isProvider(value: string): value is Provider {
  return PROVIDERS.includes(value as Provider);
}

function isMode(value: string): value is Mode {
  return MODES.includes(value as Mode);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

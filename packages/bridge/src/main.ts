// stdio MCP entry. Answers initialize before the database connects.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  DIBS_FILES,
  PROVIDERS,
  type DibsConfig,
  type Provider,
  type SessionFile,
} from "@dibs/protocol";
import { parseArgs } from "./args.ts";
import { localBuildHash } from "./build-hash.ts";
import {
  configPath,
  acquireLock,
  participantDir,
  readJson,
  resolveHome,
  tokenPath,
} from "./home.ts";
import { startSync } from "./inbox.ts";
import { log } from "./log.ts";
import { createBridge } from "./mcp.ts";
import { MemoryStore } from "./memory.ts";
import { connectSession, loadDbBuilder, RemoteStore } from "./spacetime.ts";
import { OfflineStore, SwitchingStore, type AgentStore } from "./store.ts";

export async function runBridge(argv: string[]): Promise<void> {
  console.log = (...parts: unknown[]) => {
    log(
      parts
        .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
        .join(" "),
    );
  };
  const args = parseArgs(argv);
  const participant = args.get("participant");
  const provider = args.get("provider");
  if (!participant || !isProvider(provider)) {
    log(
      "usage: node bridge.mjs --participant <name> --provider <claude|codex|droid> [--home <dir>] [--store memory|spacetime]",
    );
    process.exit(1);
  }
  const home = resolveHome(args.get("home"));
  const dir = participantDir(home, participant);
  fs.mkdirSync(dir, { recursive: true });
  const session = readJson(path.join(dir, DIBS_FILES.session)) as
    SessionFile | undefined;
  const mode = session?.mode ?? "none";
  if (session && session.provider !== provider)
    log(`session provider is ${session.provider}; this bridge is ${provider}`);
  const lock = acquireLock(dir, participant);
  const storeKind =
    args.get("store") || process.env.DIBS_BRIDGE_STORE || "spacetime";
  let stopDb: (() => void) | undefined;
  let store: AgentStore;
  if (!lock.ok) {
    log(
      `bridge already running for ${participant} (pid ${lock.holder}); tools will report offline`,
    );
    store = new OfflineStore(participant, provider);
  } else if (storeKind === "memory") {
    const memory = new MemoryStore({
      participant,
      provider,
      lobbyId: session?.lobbyId ?? 0,
      mode,
      fallbackAtUs: session?.fallbackAtUs,
      endsAtUs: session?.endsAtUs,
      startedAtUs: session?.startedAtUs,
      baseSha: session?.baseSha,
    });
    await memory.connect();
    store = memory;
    log(`memory store for ${participant} lobby ${session?.lobbyId ?? 0}`);
  } else {
    const switching = new SwitchingStore(
      new OfflineStore(participant, provider),
    );
    store = switching;
    stopDb = maintain(switching, { home, dir, participant, provider, session });
  }
  const stopSync = session && lock.ok ? startSync(dir, store) : undefined;
  const server = createBridge(store, { mode, dir });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`stdio ready (${mode})`);

  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    stopDb?.();
    try {
      stopSync?.();
    } catch {
      // The sweep already stopped.
    }
    if (lock.ok) lock.release();
    store.close();
    void server.close().finally(() => process.exit(0));
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (error) => log(error.stack ?? error.message));
  process.on("unhandledRejection", (error) =>
    log(error instanceof Error ? error.message : String(error)),
  );
}

function maintain(
  switching: SwitchingStore,
  options: {
    home: string;
    dir: string;
    participant: string;
    provider: Provider;
    session: SessionFile | undefined;
  },
): () => void {
  let stopped = false;
  void (async () => {
    let delay = 500;
    let announced = false;
    while (!stopped) {
      try {
        const config = readJson(configPath(options.home)) as
          DibsConfig | undefined;
        const token = readToken(tokenPath(options.dir));
        if (!config?.dbUri || !config.dbName || !token)
          throw new Error("config.json or token is missing");
        if (!options.session) throw new Error("session.json is missing");
        const session = options.session;
        const remote = new RemoteStore(
          await connectSession({
            builder: await loadDbBuilder(),
            uri: config.dbUri,
            database: config.dbName,
            token,
            participant: options.participant,
            provider: options.provider,
            lobbyId: session.lobbyId,
            buildHash: localBuildHash(),
            log,
          }),
        );
        if (stopped) {
          remote.close();
          return;
        }
        switching.use(remote);
        delay = 500;
        announced = false;
        log(`connected to ${config.dbName}`);
        await remote.closed;
      } catch (error) {
        if (!announced) {
          log(error instanceof Error ? error.message : String(error));
          announced = true;
        }
      }
      if (stopped) return;
      switching.use(new OfflineStore(options.participant, options.provider));
      await sleep(delay);
      delay = Math.min(delay * 2, 15_000);
    }
  })();
  return () => {
    stopped = true;
  };
}

function readToken(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function isProvider(value: string | undefined): value is Provider {
  return PROVIDERS.includes(value as Provider);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

const invoked = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const here = fileURLToPath(import.meta.url);
    const left = path.resolve(entry);
    const right = path.resolve(here);
    return process.platform === "win32"
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  } catch {
    return false;
  }
})();

if (invoked) void runBridge(process.argv.slice(2));

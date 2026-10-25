import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  connect,
  subscribeLobby,
  tables,
  type DbConnection,
} from "@dibs/client";
import { setGlobalLogLevel } from "spacetimedb";
import type { VocabularyEntry, SessionFile } from "@dibs/protocol";
import {
  connectSession,
  loadDbBuilder,
  RemoteStore,
} from "../../bridge/src/spacetime.ts";
import { computeStatus } from "../../bridge/src/world.ts";
import {
  planAttachment,
  applyAttachment,
  detachAttachment,
  asset,
  PROVIDERS,
  type Provider,
} from "./attach.ts";

const AGENT: Record<Provider, string> = {
  claude: "Claude Code (claude)",
  codex: "Codex (codex)",
  droid: "Droid (droid)",
};

export const PROTOCOL = "project-v1";
// SDK informational logging must not contaminate `status --json` output.
setGlobalLogLevel("error");
export const DEFAULT_SERVER: string | undefined =
  process.env.DIBS_DEFAULT_SERVER ||
  load<{ server?: string }>(asset("service.json"))?.server;
interface State {
  version: 1;
  project: string;
  provider: Provider;
  server: string;
  dbUri: string;
  dbName: string;
  code: string;
  token?: string;
  operation: "create" | "join";
  brief: string;
  vocabulary: VocabularyEntry[];
  lobbyId?: number;
  participant?: string;
  attached?: boolean;
}
export function projectHome(
  project: string,
  provider: Provider,
  base = process.env.DIBS_HOME || path.join(os.homedir(), ".dibs"),
) {
  const canonical = fs.realpathSync(project);
  const normalized =
    process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return path.join(
    base,
    "projects",
    createHash("sha256")
      .update(normalized + "\0" + provider)
      .digest("hex")
      .slice(0, 24),
  );
}
function save(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + randomUUID() + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}
function load<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
function validServer(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(
      "Use an HTTPS dibs server URL, or HTTP on localhost for development.",
    );
  return url.href.replace(/\/$/, "");
}
export function encodeJoin(server: string, code: string) {
  return (
    "dibs1_" +
    Buffer.from(JSON.stringify({ server: validServer(server), code })).toString(
      "base64url",
    )
  );
}
export function decodeJoin(value: string) {
  try {
    if (!value.startsWith("dibs1_") || value.length > 4096) throw new Error();
    const decoded = JSON.parse(
      Buffer.from(value.slice(6), "base64url").toString(),
    );
    if (
      typeof decoded.code !== "string" ||
      !/^[a-f0-9]{48}$/.test(decoded.code)
    )
      throw new Error();
    return {
      server: validServer(decoded.server),
      code: decoded.code as string,
    };
  } catch {
    throw new Error(
      "Invalid join code. Paste the full dibs1_… code from the project creator.",
    );
  }
}
async function configuration(server: string) {
  const response = await fetch(`${server}/config.json`, {
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(
      `dibs server configuration is unavailable (HTTP ${response.status}).`,
    );
  const value = (await response.json()) as Record<string, unknown>;
  const dbUri = value.dbUri ?? value.uri,
    dbName = value.dbName ?? value.db;
  if (typeof dbUri !== "string" || typeof dbName !== "string")
    throw new Error("The server returned invalid database configuration.");
  const url = new URL(dbUri);
  if (
    !["https:", "wss:"].includes(url.protocol) &&
    !(
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      ["http:", "ws:"].includes(url.protocol)
    )
  )
    throw new Error("The server returned an insecure database address.");
  return { dbUri, dbName };
}
async function subscription(conn: DbConnection) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Database subscription timed out.")),
      10000,
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
      .subscribe([tables.participant, tables.lobby]);
  });
}
async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(
    "Server result has not arrived. Retry the same command; the saved identity preserves your seat.",
  );
}
function vocabulary(values: string[] | undefined): VocabularyEntry[] {
  if (!values?.length)
    return [
      {
        key: "project.interface",
        description:
          "The shared API, data shapes, routes, exports and integration assumptions between teammates.",
      },
    ];
  return values.map((value) => {
    const i = value.indexOf("=");
    const key = i < 0 ? value : value.slice(0, i);
    if (!/^[a-z][a-z0-9_.-]{0,99}$/.test(key))
      throw new Error(
        "Interface keys use lowercase letters, numbers, dots, dashes or underscores.",
      );
    return { key, description: i < 0 ? key : value.slice(i + 1) };
  });
}
async function briefInput(value: string | undefined) {
  if (value?.trim()) return value.trim();
  if (!process.stdin.isTTY)
    throw new Error("Pass --brief when creating a project non-interactively.");
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const brief = (
      await input.question("What are you building together? ")
    ).trim();
    if (!brief) throw new Error("A project brief is required.");
    return brief;
  } finally {
    input.close();
  }
}
async function attach(
  state: State,
  home: string,
  stateFile: string,
  plan: ReturnType<typeof planAttachment>,
) {
  const session = await connect({
    uri: state.dbUri,
    dbName: state.dbName,
    token: state.token,
  });
  // Persist the issued credential BEFORE the mutating reducer. A timeout can
  // then be retried with the same identity rather than stranding a provider seat.
  state.token = session.token;
  save(stateFile, state);
  try {
    await subscription(session.conn);
    try {
      if (state.operation === "create")
        await session.conn.reducers.createProject({
          code: state.code,
          provider: state.provider,
          brief: state.brief,
          vocabularyJson: JSON.stringify(state.vocabulary),
          protocol: PROTOCOL,
        });
      else
        await session.conn.reducers.joinProject({
          code: state.code,
          provider: state.provider,
          protocol: PROTOCOL,
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such|unknown reducer|not found.*reducer/i.test(message))
        throw new Error(
          "This server does not support project onboarding yet. Deploy real_exp, then retry this command.",
        );
      throw error;
    }
    const me = await waitFor(() =>
      [...session.conn.db.participant.iter()].find(
        (p) =>
          p.identity.isEqual(session.identity) &&
          p.currentLobbyId !== undefined,
      ),
    );
    const lobby = await waitFor(
      () => session.conn.db.lobby.id.find(me.currentLobbyId!) ?? undefined,
    );
    state.lobbyId = lobby.id;
    state.participant = me.name;
    state.brief = lobby.charter;
    state.vocabulary = JSON.parse(lobby.vocabularyJson);
    save(stateFile, state);
    save(path.join(home, "config.json"), {
      dbUri: state.dbUri,
      dbName: state.dbName,
    });
    const dir = path.join(home, state.provider);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "token"), state.token + "\n", {
      mode: 0o600,
    });
    const local: SessionFile = {
      project: true,
      remoteParticipant: me.name,
      participant: state.provider,
      provider: state.provider,
      lobbyId: lobby.id,
      mode: "dibs",
      clonePath: state.project,
      baseSha: "unversioned",
      startedAtUs: Number(lobby.startedAtUs),
      fallbackAtUs: Number(lobby.fallbackAtUs),
      endsAtUs: Number(lobby.endsAtUs),
      brief: state.brief,
      vocabulary: state.vocabulary,
    };
    save(path.join(dir, "session.json"), local);
    const context = `dibs project ${lobby.id}. You are ${state.provider}. Before implementing shared work, call dibs_status, then publish your plan and assumptions with dibs_plan. Read proposals with dibs_status; accept or reject the exact revision with dibs_respond. Wait on unresolved shared interfaces and continue independent work. An escalated interface (rejected twice) is frozen for the developers: stop work on it until their decision arrives as its agreed contract, then follow it. Delivery is not agreement. If offline or analysis unavailable, tell the developer. Shared keys: ${state.vocabulary.map((v) => v.key).join(", ")}. Brief: ${state.brief.slice(0, 450)}`;
    fs.writeFileSync(path.join(dir, "project-context.txt"), context, {
      mode: 0o600,
    });
    applyAttachment(plan);
    state.attached = true;
    save(stateFile, state);
  } finally {
    session.conn.disconnect();
  }
}

export function operationLock(home: string): () => void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "operation.lock");
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        if (load<{ nonce: string }>(file)?.nonce === nonce) fs.unlinkSync(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const original = fs.readFileSync(file, "utf8");
      const stat = fs.statSync(file);
      let alive = Date.now() - stat.mtimeMs < 30_000;
      let holder: { pid?: number } | undefined;
      try {
        holder = JSON.parse(original);
      } catch {
        /* an interrupted write is recoverable after the freshness window */
      }
      if (Number.isSafeInteger(holder?.pid) && holder!.pid! > 0) {
        try {
          process.kill(holder!.pid!, 0);
          alive = true;
        } catch (check) {
          alive = (check as NodeJS.ErrnoException).code !== "ESRCH";
        }
      }
      if (alive)
        throw new Error(
          "Another dibs command is changing this directory/provider. Wait for it to finish.",
        );
      if (
        fs.readFileSync(file, "utf8") !== original ||
        fs.statSync(file).mtimeMs !== stat.mtimeMs
      )
        throw new Error(
          "Another dibs command acquired the attachment lock. Retry shortly.",
        );
      fs.unlinkSync(file);
    }
  }
  throw new Error(
    "Could not acquire the project attachment lock. Retry the command.",
  );
}
interface CommandOptions {
  server?: string;
  brief?: string;
  interface?: string[];
  local?: boolean;
  json?: boolean;
}

export async function main(argv: string[]) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      provider: { type: "string" },
      server: { type: "string" },
      brief: { type: "string" },
      interface: { type: "string", multiple: true },
      project: { type: "string" },
      local: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (!command || values.help || command === "help") {
    console.log(
      "dibs create --provider claude|codex|droid [--brief <text>] [--interface key=description]\ndibs join <code> --provider claude|codex|droid\ndibs status|doctor|leave|close --provider claude|codex|droid\ndibs decide [interface] [A|B] --provider <creator>  (settle an interface the agents rejected twice)\nOptions: --project <directory>, --server <HTTPS URL> (create), --local (leave), --json (status)",
    );
    return;
  }
  if (
    ![
      "create",
      "join",
      "status",
      "doctor",
      "leave",
      "close",
      "decide",
    ].includes(command)
  )
    throw new Error("Unknown command. Run dibs --help.");
  const provider = values.provider as Provider;
  if (!PROVIDERS.includes(provider))
    throw new Error("Choose --provider claude, codex or droid.");
  const project = fs.realpathSync(values.project ?? process.cwd());
  const home = projectHome(project, provider);
  const release = operationLock(home);
  try {
    return await runCommand(
      command,
      provider,
      project,
      home,
      values,
      positionals,
    );
  } finally {
    release();
  }
}

async function runCommand(
  command: string,
  provider: Provider,
  project: string,
  home: string,
  values: CommandOptions,
  positionals: string[],
) {
  const stateFile = path.join(home, "state.json");
  let state = load<State>(stateFile);
  if (command === "create" || command === "join") {
    if (state?.attached)
      throw new Error(
        "This directory/provider is already attached. Run dibs status, or dibs leave before changing rooms.",
      );
    const plan = planAttachment(project, provider, home);
    const joined =
      command === "join" ? decodeJoin(positionals[1] ?? "") : undefined;
    const endpoint =
      joined?.server ??
      values.server ??
      process.env.DIBS_SERVER ??
      DEFAULT_SERVER ??
      state?.server;
    if (!endpoint)
      throw new Error(
        "This development package has no hosted server configured. Use --server <URL> once, set DIBS_SERVER, or install the package artifact produced by the deployment pipeline.",
      );
    const server = validServer(endpoint);
    if (!state && joined && fs.existsSync(home)) {
      // Rejoining a room after detach reuses its original identity. Seats are
      // never handed to a fresh identity with stale votes or plans attached.
      for (const name of fs
        .readdirSync(home)
        .filter((n) => /^state-left-\d+\.json$/.test(n))
        .sort()
        .reverse()) {
        const previous = load<State>(path.join(home, name));
        if (previous?.code === joined.code && previous.server === server) {
          state = { ...previous, operation: "join", attached: false };
          save(stateFile, state);
          break;
        }
      }
    }
    if (
      state &&
      (state.operation !== command ||
        state.server !== server ||
        (joined && joined.code !== state.code))
    )
      throw new Error(
        "An unfinished attachment exists. Retry the original command or run dibs leave --local first.",
      );
    if (!state) {
      state = {
        version: 1,
        project,
        provider,
        server,
        ...(await configuration(server)),
        code: joined?.code ?? randomBytes(24).toString("hex"),
        operation: command,
        brief: command === "create" ? await briefInput(values.brief) : "",
        vocabulary: vocabulary(values.interface),
      };
      save(stateFile, state);
    }
    await attach(state, home, stateFile, plan);
    console.log(
      `Joined project ${state.lobbyId} as ${provider}. Open ${AGENT[provider]} normally in this directory and accept its native MCP/project/hook trust prompts.`,
    );
    console.log(
      `Dashboard: ${state.server}/?view=story&lobby=${state.lobbyId}`,
    );
    console.log(`Evidence view: ${state.server}/?lobby=${state.lobbyId}`);
    console.log(
      "Project lifetime: 24 hours; at most 30 analysis leases (model retries may use additional requests). Plans and messages are publicly readable in this demo database.",
    );
    if (command === "create")
      console.log(
        `Share this join code privately:\n${encodeJoin(state.server, state.code)}`,
      );
    return;
  }
  if (!state)
    throw new Error(
      "No dibs project attachment exists for this directory/provider.",
    );
  if (command === "leave" || command === "close") {
    if (command === "close" && (!state.token || !state.lobbyId))
      throw new Error(
        "Setup is incomplete. Retry the original create/join command before closing the project, or use dibs leave --local to detach locally.",
      );
    if (command === "close" && values.local)
      throw new Error(
        "Closing a project requires the server; --local only applies to leave.",
      );
    if (!values.local && state.token && state.lobbyId) {
      const session = await connect({
        uri: state.dbUri,
        dbName: state.dbName,
        token: state.token,
      });
      try {
        await session.conn.reducers[
          command === "close" ? "closeProject" : "leaveProject"
        ]({ lobbyId: state.lobbyId });
      } finally {
        session.conn.disconnect();
      }
    }
    for (const warning of detachAttachment(home)) console.error(warning);
    state.attached = false;
    // Keep credential/recovery history outside the project; never transfer a seat.
    fs.renameSync(stateFile, path.join(home, `state-left-${Date.now()}.json`));
    const localSession = path.join(home, provider, "session.json");
    if (fs.existsSync(localSession)) fs.unlinkSync(localSession);
    console.log(
      command === "close"
        ? "Project closed; this directory is detached."
        : "Directory detached. The provider seat remains bound to its original identity; saved credentials remain in local history.",
    );
    return;
  }
  if (!state.token || !state.lobbyId || !state.participant)
    throw new Error(
      "Attachment is incomplete. Retry its original create/join command.",
    );
  if (command === "decide") return decide(state, positionals.slice(1));
  const remote = await connectSession({
    builder: await loadDbBuilder(),
    uri: state.dbUri,
    database: state.dbName,
    token: state.token,
    participant: state.participant,
    provider,
    lobbyId: state.lobbyId,
    buildHash: PROTOCOL,
    project: true,
  });
  try {
    const store = new RemoteStore(remote);
    const status = computeStatus(store.world(), [], Date.now() * 1000);
    if (values.json) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(
        `Project ${state.lobbyId}: ${status.status}; ${status.roster.map((p) => `${p.provider} ${p.online ? "online" : "offline"}`).join(", ")}`,
      );
      console.log(
        `Expires ${new Date((status.project?.expiresAtUs ?? 0) / 1000).toISOString()}; ${status.project?.remainingLeases ?? 0} analysis leases remain.`,
      );
      if (status.project?.unavailable) console.log(status.project.unavailable);
      for (const key of status.keys) console.log(`${key.key}: ${key.status}`);
    }
    if (command === "doctor") {
      const dir = path.join(home, provider);
      const hook = load<{ lobbyId: number; atUs: number }>(
        path.join(dir, "hook-alive.json"),
      );
      const lock = load<{ pid: number }>(path.join(dir, "bridge.lock"));
      let running = false;
      try {
        if (lock) {
          process.kill(lock.pid, 0);
          running = true;
        }
      } catch {
        /* process absent */
      }
      console.log(
        `MCP bridge process: ${running ? "running" : "not observed; open the native agent and approve its dibs MCP server"}`,
      );
      console.log(
        `SessionStart hook: ${hook?.lobbyId === state.lobbyId ? `observed at ${new Date(hook.atUs / 1000).toISOString()}` : "not observed; review and trust the project hooks in the native agent"}`,
      );
      if (!running || hook?.lobbyId !== state.lobbyId) process.exitCode = 1;
    }
  } finally {
    remote.close();
  }
}

/** Escalated interfaces (rejected twice this round) and the rejected proposals to choose from. */
function frozenOptions(conn: DbConnection, lobbyId: number) {
  const proposals = [...conn.db.proposal.iter()].filter(
    (p) => p.lobbyId === lobbyId,
  );
  const contracts = [...conn.db.contract.iter()].filter(
    (c) => c.lobbyId === lobbyId,
  );
  const frozen = new Map<string, typeof proposals>();
  for (const key of new Set(proposals.map((p) => p.key))) {
    const since = contracts
      .filter((c) => c.key === key)
      .reduce((max, c) => (c.createdAtUs > max ? c.createdAtUs : max), 0n);
    const round = proposals
      .filter((p) => p.key === key && p.createdAtUs >= since)
      .sort((a, b) => a.revision - b.revision);
    if (round.some((p) => p.state === "escalated"))
      frozen.set(
        key,
        round.filter((p) => p.state === "rejected" || p.state === "escalated"),
      );
  }
  return frozen;
}

async function decide(state: State, [key, choice]: string[]) {
  if (state.operation !== "create")
    throw new Error(
      "Only the project creator can decide; run this where you ran dibs create.",
    );
  const session = await connect({
    uri: state.dbUri,
    dbName: state.dbName,
    token: state.token,
  });
  try {
    await subscribeLobby(session.conn, state.lobbyId!);
    const { conn } = session;
    const frozen = frozenOptions(conn, state.lobbyId!);
    const who = (id: number) => {
      const p = conn.db.participant.id.find(id);
      return p
        ? AGENT[p.provider as Provider].replace(/ \(.*\)$/, "")
        : `#${id}`;
    };
    if (!key) {
      if (!frozen.size) console.log("No interface is waiting for a decision.");
      for (const k of frozen.keys())
        console.log(
          `${k} is frozen: the agents rejected it twice. Run: dibs decide ${k}`,
        );
      return;
    }
    const options = frozen.get(key);
    if (!options)
      throw new Error(
        `${key} is not waiting for a decision. Run dibs decide to list frozen interfaces.`,
      );
    const letter = (i: number) => String.fromCharCode(65 + i);
    if (!choice) {
      console.log(
        `${key} is frozen: the agents rejected it twice. Choose one option.\n`,
      );
      options.forEach((p, i) => {
        const rejections = [...conn.db.response.iter()].filter(
          (r) => r.proposalId === p.id && r.decision === "reject",
        );
        console.log(
          `Option ${letter(i)} (proposal P${p.id}, revision ${p.revision})`,
        );
        console.log(p.contractText.replace(/^/gm, "    "));
        for (const r of rejections)
          console.log(
            `  Rejected by ${who(r.participantId)}: ${r.reason || "(no reason given)"}`,
          );
        console.log("");
      });
      console.log(
        `Decide with: dibs decide ${key} ${options.map((_, i) => letter(i)).join("|")} --provider ${state.provider}`,
      );
      return;
    }
    const index = choice.toUpperCase().charCodeAt(0) - 65;
    const chosen = options[index];
    if (!chosen || choice.length !== 1)
      throw new Error(
        `Choose ${options.map((_, i) => letter(i)).join(" or ")}.`,
      );
    await conn.reducers.decideProject({
      lobbyId: state.lobbyId!,
      key,
      proposalId: chosen.id,
    });
    console.log(
      `Decided ${key}: option ${letter(index)} (revision ${chosen.revision}) is now the agreed contract. Every agent on ${key} receives it and resumes.`,
    );
  } finally {
    session.conn.disconnect();
  }
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `dibs: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
// dibs-hook: puts unseen dibs updates into a coding agent's context at its checkpoints.
//
//   node <abs>/dibs-hook.mjs --participant <name> --provider <claude|codex|droid> [--home <dir>]
//
// The provider runs it for SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure
// (Claude only) and Stop, and passes the event as JSON on stdin (`hook_event_name`, `cwd`,
// `session_id`). The bridge (the agent's MCP server) writes one file per delivery into
// <DIBS_HOME>/<participant>/inbox/; this script claims files by atomic rename into claimed/,
// prints them, and moves them to shown/, where the bridge marks them `shown` in the database.
//
// Rules (docs/plan.md §5.4, docs/API.md "Local files"):
// - Zero dependencies, no network, never breaks the agent: every error exits 0 silently.
// - Silent unless stdin's cwd is inside session.json's clonePath, so development sessions and
//   the SDK reviewer are unaffected.
// - SessionStart, UserPromptSubmit and PostToolUse(Failure) print only the JSON below. Stop
//   prints only {"decision":"block","reason":"…"} or nothing, at most 8 times per lobby.
// - Text is facts, not commands, at most LIMITS.hookContextChars.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Mirrors DIBS_FILES, LIMITS and TIMING in packages/protocol (this script can't import TS).
// test/hook.test.ts checks they still match.
export const FILES = {
  config: "config.json",
  token: "token",
  session: "session.json",
  inbox: "inbox",
  claimed: "claimed",
  shown: "shown",
  bridgeLock: "bridge.lock",
  stopBlocks: "stopblocks.json",
  hookAlive: "hook-alive.json",
  // Bridge → hook snapshot of key status (not in the protocol; private to packages/bridge).
  hookStatus: "hook-status.json",
  // Hook's own memory: whether the offline notice was shown this lobby.
  hookState: "hook-state.json",
};
export const HOOK_CONTEXT_CHARS = 1500;
export const STOP_BLOCKS_MAX = 8;
const RENAME_RETRY_MS = 200;
const STDIN_TIMEOUT_MS = 5000;
export const OFFLINE_NOTICE =
  "dibs coordination is offline; dibs_status may be stale.";
const CONTEXT_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
]);
const ITEM_FILE = /^\d+\.json$/;

// ---------------------------------------------------------------------------------------------
// Small helpers

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--"))
      out[arg.slice(2)] = argv[++i];
    else out[arg.slice(2)] = "true";
  }
  return out;
}

/** @param {string | undefined} override */
export function resolveHome(override) {
  const raw =
    override || process.env.DIBS_HOME || path.join(os.homedir(), ".dibs");
  return path.resolve(
    raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw,
  );
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Write via a temp file and rename, so readers never see half a file. */
function writeJsonAtomic(
  /** @type {string} */ file,
  /** @type {unknown} */ value,
) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  if (!renameWithRetry(tmp, file)) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Already gone.
    }
  }
}

function sleepSync(/** @type {number} */ ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * fs.renameSync, retrying EPERM/EBUSY/EACCES for up to 200 ms: on Windows a rename fails while
 * another process (an antivirus scan, the bridge, a racing hook) has the file open.
 * Returns false when the source is gone (another hook won) or the retries run out.
 */
export function renameWithRetry(
  /** @type {string} */ from,
  /** @type {string} */ to,
) {
  const deadline = Date.now() + RENAME_RETRY_MS;
  for (;;) {
    try {
      fs.renameSync(from, to);
      return true;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (
        (code === "EPERM" || code === "EBUSY" || code === "EACCES") &&
        Date.now() < deadline
      ) {
        sleepSync(10);
        continue;
      }
      return false;
    }
  }
}

/** Resolved, real (symlinks followed) and, on Windows, lowercased, because Claude passes C:\…. */
function canonical(/** @type {string} */ p) {
  let resolved = path.resolve(p);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // A path that doesn't exist yet still compares by its resolved form.
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True when `cwd` is `root` or inside it. */
export function isInside(
  /** @type {string} */ cwd,
  /** @type {string} */ root,
) {
  if (!cwd || !root) return false;
  const rel = path.relative(canonical(root), canonical(cwd));
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

/** True when a process with this pid exists. */
export function pidAlive(/** @type {unknown} */ pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

const nowUs = () => Date.now() * 1000;

async function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    const done = () => resolve(raw);
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      done();
    });
  });
}

/** Write to stdout and wait until it's flushed, so we only move files to shown/ after a print. */
function print(/** @type {string} */ text) {
  return new Promise((resolve) => {
    process.stdout.write(text, () => resolve(undefined));
  });
}

// ---------------------------------------------------------------------------------------------
// The inbox

/**
 * @typedef {{ deliveryId: number, lobbyId: number, kind: string, refId: number, summary: string, queuedAtUs: number }} InboxItem
 * @typedef {{ name: string, item: InboxItem }} Claimed
 */

export class Inbox {
  /** @param {string} dir the participant's folder */
  constructor(dir) {
    this.dir = dir;
    this.inbox = path.join(dir, FILES.inbox);
    this.claimed = path.join(dir, FILES.claimed);
    this.shown = path.join(dir, FILES.shown);
  }

  ensureDirs() {
    for (const d of [this.inbox, this.claimed, this.shown])
      fs.mkdirSync(d, { recursive: true });
  }

  /** Item file names in inbox/, oldest delivery first. */
  pending() {
    let names = [];
    try {
      names = fs.readdirSync(this.inbox).filter((n) => ITEM_FILE.test(n));
    } catch {
      return [];
    }
    return names.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  }

  /**
   * Claim every inbox item for this lobby. Items another hook claimed first are skipped; items
   * from another lobby are deleted (they can't be delivered any more).
   * @param {number} lobbyId
   * @returns {Claimed[]}
   */
  claimAll(lobbyId) {
    this.ensureDirs();
    /** @type {Claimed[]} */
    const claimed = [];
    for (const name of this.pending()) {
      const source = path.join(this.inbox, name);
      const target = path.join(this.claimed, name);
      // A hard link fails if the destination already exists, so only one hook can claim the file.
      // Rename on Windows is not exclusive when two processes race.
      try {
        fs.linkSync(source, target);
        try {
          fs.unlinkSync(source);
        } catch {
          // The claimed link is the copy that matters.
        }
      } catch {
        if (!renameWithRetry(source, target)) continue;
      }
      // A rename keeps the old mtime; without this the bridge's 60 s sweep could return the file
      // to inbox/ while we print it.
      try {
        const now = new Date();
        fs.utimesSync(target, now, now);
      } catch {
        // Best effort.
      }
      const item = readJson(target);
      if (
        !item ||
        typeof item.summary !== "string" ||
        typeof item.deliveryId !== "number"
      ) {
        // Unreadable: park it where neither the sweep nor a later hook picks it up again.
        renameWithRetry(target, `${target}.bad`);
        continue;
      }
      if (item.lobbyId !== lobbyId) {
        try {
          fs.unlinkSync(target);
        } catch {
          // Already gone.
        }
        continue;
      }
      claimed.push({ name, item });
    }
    return claimed;
  }

  /** @param {Claimed[]} items */
  markShown(items) {
    for (const { name } of items)
      renameWithRetry(
        path.join(this.claimed, name),
        path.join(this.shown, name),
      );
  }

  /** Put claimed items back for the next checkpoint. @param {Claimed[]} items */
  release(items) {
    for (const { name } of items)
      renameWithRetry(
        path.join(this.claimed, name),
        path.join(this.inbox, name),
      );
  }
}

/** Proposals awaiting a response first, then everything else in delivery order. @param {Claimed[]} items */
export function orderItems(items) {
  const rank = (/** @type {Claimed} */ c) =>
    c.item.kind === "proposal" ? 0 : 1;
  return [...items].sort(
    (a, b) => rank(a) - rank(b) || a.item.deliveryId - b.item.deliveryId,
  );
}

/**
 * Fit items into the context budget. Returns what to print now and what to keep for later.
 * @param {Claimed[]} items ordered
 * @param {number} budget chars available
 * @param {string[]} [extra] lines that always go last (e.g. the offline notice); counted in the budget
 */
export function pack(items, budget, extra = []) {
  const extraLines = extra.map((line) => line.trim()).filter(Boolean);
  const extraBody = extraLines.join("\n");
  const sep = extraBody.length > 0 ? 1 : 0;
  let itemBudget = budget - extraBody.length - sep;
  /** @type {string[]} */
  const lines = [];
  /** @type {Claimed[]} */
  const printed = [];
  /** @type {Claimed[]} */
  const kept = [];
  for (const c of items) {
    if (itemBudget <= 1) {
      kept.push(c);
      continue;
    }
    let text = c.item.summary.trim();
    const gap = lines.length > 0 ? 1 : 0;
    if (text.length + gap > itemBudget) {
      if (lines.length > 0 || itemBudget <= 1) {
        kept.push(c);
        continue;
      }
      text = `${text.slice(0, itemBudget - 1)}…`;
    }
    lines.push(text);
    printed.push(c);
    itemBudget -= text.length + gap;
  }
  let text = [...lines, ...extraLines].filter(Boolean).join("\n");
  if (text.length > budget) text = `${text.slice(0, Math.max(0, budget - 1))}…`;
  return { text, printed, kept };
}

/** One visible line for the human. @param {Claimed[]} printed @param {boolean} offline */
export function systemLine(printed, offline) {
  if (printed.length === 0)
    return offline ? "dibs: coordination offline" : "dibs";
  const first = printed[0].item;
  if (printed.length === 1) {
    const brief = first.summary.replace(
      /^dibs( update from your team's coordination service)?:\s*/i,
      "",
    );
    const cut = brief.length > 110 ? `${brief.slice(0, 109)}…` : brief;
    return `dibs: ${cut}`;
  }
  /** @type {Record<string, number>} */
  const counts = {};
  for (const c of printed) counts[c.item.kind] = (counts[c.item.kind] ?? 0) + 1;
  const parts = Object.entries(counts).map(([kind, n]) =>
    n > 1 ? `${n} ${kind}s` : kind,
  );
  return `dibs: ${printed.length} updates (${parts.join(", ")})`;
}

// ---------------------------------------------------------------------------------------------
// The hook

/**
 * @typedef {{ participant: string, provider: string, lobbyId: number, mode: string, clonePath: string, fallbackAtUs: number }} Session
 * @typedef {{ lobbyId: number, online: boolean, offlineSinceUs?: number, phase?: string, pendingKeys?: string[], awaiting?: { proposalId: number, revision: number, key: string }[], fallbackAtUs?: number }} HookStatus
 */

/**
 * Run one hook invocation. Returns what was printed (for tests); never throws.
 * @param {{ argv: string[], input: Record<string, unknown>, now?: number }} options
 * @returns {Promise<string>}
 */
export async function runHook({ argv, input, now = nowUs() }) {
  const args = parseArgs(argv);
  const provider = args.provider;
  const participant = args.participant || provider;
  if (
    !provider ||
    !participant ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(participant)
  )
    return "";

  const home = resolveHome(args.home);
  const dir = path.join(home, participant);
  /** @type {Session | undefined} */
  const session = readJson(path.join(dir, FILES.session));
  if (
    !session ||
    typeof session.lobbyId !== "number" ||
    typeof session.clonePath !== "string"
  )
    return "";

  const event = String(input.hook_event_name ?? input.hookEventName ?? "");
  const cwd =
    typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  if (!isInside(cwd, session.clonePath)) return "";
  if (typeof session.provider === "string" && session.provider !== provider)
    return "";
  if (
    typeof session.participant === "string" &&
    session.participant !== participant
  )
    return "";

  const inbox = new Inbox(dir);
  if (event === "SessionStart") {
    writeJsonAtomic(path.join(dir, FILES.hookAlive), {
      lobbyId: session.lobbyId,
      provider,
      sessionId: String(input.session_id ?? input.sessionId ?? ""),
      atUs: now,
    });
  }

  if (CONTEXT_EVENTS.has(event))
    return contextEvent({ event, provider, dir, home, session, inbox, now });
  if (event === "Stop") return stopEvent({ dir, session, inbox, now });
  return "";
}

/** Is coordination offline as far as the hook can tell? */
function offlineReason(
  /** @type {string} */ home,
  /** @type {string} */ dir,
  /** @type {Session} */ session,
  /** @type {number} */ now,
) {
  if (!fs.existsSync(path.join(home, FILES.config))) return "config missing";
  const lock = readJson(path.join(dir, FILES.bridgeLock));
  if (!lock || !pidAlive(lock.pid)) return "bridge not running";
  /** @type {HookStatus | undefined} */
  const status = readJson(path.join(dir, FILES.hookStatus));
  // The bridge says it's disconnected and has been for a while (startup takes a few seconds).
  if (
    status &&
    status.lobbyId === session.lobbyId &&
    status.online === false &&
    typeof status.offlineSinceUs === "number" &&
    now - status.offlineSinceUs > 15_000_000
  )
    return "database unreachable";
  return undefined;
}

/**
 * @param {{ event: string, provider: string, dir: string, home: string, session: Session, inbox: Inbox, now: number }} o
 */
async function contextEvent({
  event,
  provider,
  dir,
  home,
  session,
  inbox,
  now,
}) {
  // The offline notice goes out once per outage. Not at SessionStart: the provider starts the
  // bridge and this hook at the same moment, so a missing lock there means nothing yet.
  const statePath = path.join(dir, FILES.hookState);
  const state = readJson(statePath);
  const notified =
    state?.lobbyId === session.lobbyId && state.offlineNotified === true;
  let showOffline = false;
  if (event !== "SessionStart") {
    const offline = offlineReason(home, dir, session, now) !== undefined;
    if (offline && !notified) showOffline = true;
    if (!offline && notified)
      writeJsonAtomic(statePath, {
        lobbyId: session.lobbyId,
        offlineNotified: false,
      });
  }

  const claimed = orderItems(inbox.claimAll(session.lobbyId));
  if (claimed.length === 0 && !showOffline) return "";

  const { text, printed, kept } = pack(
    claimed,
    HOOK_CONTEXT_CHARS,
    showOffline ? [OFFLINE_NOTICE] : [],
  );
  if (!text.trim()) {
    inbox.release(claimed);
    return "";
  }
  inbox.release(kept);

  /** @type {Record<string, unknown>} */
  const output = {
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  };
  // Droid isn't documented to accept systemMessage; leave it out unless Gate 0 shows it does.
  if (provider !== "droid")
    output.systemMessage = systemLine(printed, showOffline);
  const json = JSON.stringify(output);
  await print(`${json}\n`);
  inbox.markShown(printed);
  if (showOffline)
    writeJsonAtomic(statePath, {
      lobbyId: session.lobbyId,
      offlineNotified: true,
    });
  return json;
}

/**
 * Stop: block (at most once per proposal, at most 8 times per lobby) when a proposal awaits this
 * agent or its keys are still pending before the fallback. Never prints the offline notice.
 * @param {{ dir: string, session: Session, inbox: Inbox, now: number }} o
 */
async function stopEvent({ dir, session, inbox, now }) {
  const blocksPath = path.join(dir, FILES.stopBlocks);
  let blocks = readJson(blocksPath);
  if (
    !blocks ||
    blocks.lobbyId !== session.lobbyId ||
    !Array.isArray(blocks.proposalIds)
  )
    blocks = { lobbyId: session.lobbyId, count: 0, proposalIds: [] };
  if (blocks.count >= STOP_BLOCKS_MAX) return "";

  // The bridge's view of key status is trusted only while the bridge is alive.
  const lock = readJson(path.join(dir, FILES.bridgeLock));
  /** @type {HookStatus | undefined} */
  let status = readJson(path.join(dir, FILES.hookStatus));
  if (
    !status ||
    status.lobbyId !== session.lobbyId ||
    !lock ||
    !pidAlive(lock.pid)
  )
    status = undefined;

  const claimed = orderItems(inbox.claimAll(session.lobbyId));
  /** @type {Map<number, string>} proposal id → line for the reason */
  const awaiting = new Map();
  for (const c of claimed)
    if (c.item.kind === "proposal") awaiting.set(c.item.refId, "");
  for (const a of status?.awaiting ?? [])
    if (!awaiting.has(a.proposalId))
      awaiting.set(
        a.proposalId,
        `dibs: proposal P${a.proposalId} (rev ${a.revision}) for ${a.key} still awaits your response (dibs_respond).`,
      );
  const fresh = [...awaiting.keys()].filter(
    (id) => !blocks.proposalIds.includes(id),
  );

  const fallbackAtUs = status?.fallbackAtUs || session.fallbackAtUs || 0;
  const fallbackInSec =
    fallbackAtUs > 0 ? Math.max(0, Math.ceil((fallbackAtUs - now) / 1e6)) : 0;
  const pendingKeys = status?.pendingKeys ?? [];

  /** @type {string[]} */
  const extra = [];
  if (fresh.length > 0) {
    for (const id of fresh) {
      const line = awaiting.get(id);
      if (line) extra.push(line);
    }
  } else if (pendingKeys.length > 0 && fallbackInSec > 0) {
    extra.push(
      `dibs: your shared keys (${pendingKeys.join(", ")}) are still pending while dibs compares the team's plans; fallback in ${fallbackInSec} s. dibs_status with waitSec 45 returns as soon as they change.`,
    );
  } else {
    inbox.release(claimed);
    return "";
  }

  const { text, printed, kept } = pack(claimed, HOOK_CONTEXT_CHARS, extra);
  if (!text.trim()) {
    inbox.release(claimed);
    return "";
  }
  inbox.release(kept);
  const json = JSON.stringify({ decision: "block", reason: text });
  await print(`${json}\n`);
  inbox.markShown(printed);
  blocks.count += 1;
  for (const id of fresh)
    if (!blocks.proposalIds.includes(id)) blocks.proposalIds.push(id);
  writeJsonAtomic(blocksPath, blocks);
  return json;
}

// ---------------------------------------------------------------------------------------------
// Entry point

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const here = fileURLToPath(import.meta.url);
    const a = path.resolve(entry);
    const b = path.resolve(here);
    return process.platform === "win32"
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    const raw = await readStdin();
    /** @type {Record<string, unknown>} */
    let input = {};
    try {
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      input = {};
    }
    await runHook({ argv: process.argv.slice(2), input });
  } catch (error) {
    // Never break the agent. stderr is only shown in the provider's debug output.
    process.stderr.write(
      `dibs-hook: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  process.exitCode = 0;
}

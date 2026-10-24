// The decisions behind the enforcement hooks, independent of which coding agent asks.
// Claude Code's adapter is plugin/src/hooks; a Codex or Gemini CLI adapter calls the same
// three functions and only translates its own hook input and output.

import { isAbsolute, relative } from "node:path";
import type {
  Agent,
  CheckEditInput,
  DbConnection,
  EditDecision,
  Message,
  PendingContextInput,
  StartSessionInput,
  StartSessionResult,
} from "@dibs/shared";
import { loadConfig } from "./config";
import { db } from "./db";

// The client cache only offers find() on the primary key, so look sessions up by scanning.
function agentForSession(conn: DbConnection, sessionId: string): Agent | undefined {
  for (const agent of conn.db.agent.iter()) if (agent.sessionId === sessionId) return agent;
  return undefined;
}

/** Repo-relative, forward slashes, so intents written on Windows and macOS compare equal. */
export function normalizePath(path: string, cwd: string): string {
  const fromCwd = isAbsolute(path) ? relative(cwd, path) : path;
  return fromCwd.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Session start: register the agent, and tell it its id and what teammates are building. */
export async function startSession(input: StartSessionInput): Promise<StartSessionResult> {
  const { agentName } = loadConfig();
  const conn = await db();
  await conn.reducers.registerAgent({
    sessionId: input.sessionId,
    name: agentName,
    kind: input.kind,
    repo: input.repo ?? undefined,
  });
  const agent = agentForSession(conn, input.sessionId);
  if (!agent) throw new Error("dibs: registering this session failed");

  const lines = [
    `dibs is on. You're dibs agent ${agent.id} (${agent.name}); pass agent_id "${agent.id}" to every dibs tool.`,
    "Call publish_intent with what you're about to build before editing any file. Edits are blocked until you do.",
  ];
  const others = [...conn.db.intent.iter()].filter(
    (intent) => intent.status === "active" && intent.agentId !== agent.id,
  );
  if (others.length === 0) {
    lines.push("No other agent has called dibs on anything yet.");
  } else {
    lines.push("Teammates' agents have already called dibs on:");
    for (const intent of others) {
      const owner = conn.db.agent.id.find(intent.agentId)?.name ?? "another agent";
      const files = intent.files.length > 0 ? intent.files.join(", ") : "no files listed";
      lines.push(`- ${owner}: ${intent.title} (intent ${intent.id}; ${files})`);
    }
  }
  return { agent, context: lines.join("\n") };
}

/** Before a file edit: allowed only after this agent has called dibs, and never on another agent's files. */
export async function checkEdit({ sessionId, path, cwd }: CheckEditInput): Promise<EditDecision> {
  const conn = await db();
  const agent = agentForSession(conn, sessionId);
  // An unregistered session means dibs wasn't set up when it started. Stay out of the way.
  if (!agent) return { allow: true };

  const file = normalizePath(path, cwd);
  const active = [...conn.db.intent.iter()].filter((intent) => intent.status === "active");
  if (!active.some((intent) => intent.agentId === agent.id)) {
    return {
      allow: false,
      reason: `dibs: call publish_intent (agent_id "${agent.id}") with what you're about to build before editing ${file}.`,
    };
  }

  const owned = active.find(
    (intent) =>
      intent.agentId !== agent.id && intent.files.some((f) => normalizePath(f, cwd) === file),
  );
  if (owned) {
    const owner = conn.db.agent.id.find(owned.agentId)?.name ?? "another agent";
    return {
      allow: false,
      reason: `dibs: ${file} belongs to ${owner}'s intent "${owned.title}" (intent ${owned.id}). Don't edit it. Call request_feature with owner_intent_id "${owned.id}" and what you need instead.`,
    };
  }
  return { allow: true };
}

/** After any tool call: unread messages for this agent as context text, or null. Quiet by default. */
export async function pendingContext({ sessionId }: PendingContextInput): Promise<string | null> {
  const conn = await db();
  const agent = agentForSession(conn, sessionId);
  if (!agent) return null;
  const unread = await takeUnread(conn, agent.id);
  if (unread.length === 0) return null;
  return [
    "dibs: messages from your team's agents. Act on these before continuing.",
    ...unread.map((message) => `- [${message.kind}] ${message.body}`),
  ].join("\n");
}

/** Unread messages for an agent, oldest first, marked read as they're taken. */
export async function takeUnread(conn: DbConnection, agentId: bigint): Promise<Message[]> {
  const unread = [...conn.db.message.iter()]
    .filter((message) => message.toAgentId === agentId && !message.read)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  await Promise.all(unread.map((message) => conn.reducers.markRead({ messageId: message.id })));
  return unread;
}

// The dibs SpacetimeDB module: the shared state every agent and the dashboard sync against.
//
// Reducers run one at a time in transactions, so "whoever called dibs first owns it" is
// decided atomically here. Anything that calls the outside world (embeddings, the Claude
// judge) runs in packages/core on each laptop and reports back through a reducer.
//
// This file is the contract zone: after changing it, run `npm run generate` so
// packages/shared picks up the new types, and commit both in the same PR.
import { schema, table, t, SenderError } from "spacetimedb/server";

const AGENT_STATUS = ["active", "idle", "gone"] as const;
const VERDICTS = ["duplicate", "partial", "independent"] as const;

const agent = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.string().unique(),
    name: t.string(),
    repo: t.option(t.string()),
    status: t.string(),
    createdAt: t.timestamp(),
    lastSeenAt: t.timestamp(),
  },
);

const intent = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    agentId: t.u64().index(),
    title: t.string(),
    description: t.string(),
    interfaces: t.array(t.string()),
    files: t.array(t.string()),
    // Computed in packages/core. There's no vector index here; with tens of intents,
    // brute-force cosine similarity over the client cache is instant.
    embedding: t.array(t.f32()),
    status: t.string(),
    overlapsIntentId: t.option(t.u64()),
    verdict: t.option(t.string()),
    createdAt: t.timestamp(),
  },
);

const contract = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    ownerIntentId: t.u64().index(),
    consumerIntentId: t.u64().index(),
    interface: t.string(),
    requirements: t.array(t.string()),
    stubPath: t.option(t.string()),
    testPath: t.option(t.string()),
    status: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  },
);

const message = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    // undefined means the message came from dibs itself.
    fromAgentId: t.option(t.u64()),
    toAgentId: t.u64().index(),
    contractId: t.option(t.u64()),
    kind: t.string(),
    body: t.string(),
    read: t.bool(),
    createdAt: t.timestamp(),
  },
);

const spacetimedb = schema({ agent, intent, contract, message });
export default spacetimedb;

function oneOf<T extends string>(field: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new SenderError(`${field} must be one of ${allowed.join(", ")}, got "${value}"`);
  }
  return value as T;
}

/** SessionStart: create or refresh the agent for a Claude Code session. */
export const registerAgent = spacetimedb.reducer(
  { sessionId: t.string(), name: t.string(), repo: t.option(t.string()) },
  (ctx, { sessionId, name, repo }) => {
    const existing = ctx.db.agent.sessionId.find(sessionId);
    if (existing) {
      ctx.db.agent.id.update({ ...existing, status: "active", lastSeenAt: ctx.timestamp });
      return;
    }
    ctx.db.agent.insert({
      id: 0n,
      sessionId,
      name,
      repo,
      status: "active",
      createdAt: ctx.timestamp,
      lastSeenAt: ctx.timestamp,
    });
  },
);

export const setAgentStatus = spacetimedb.reducer(
  { agentId: t.u64(), status: t.string() },
  (ctx, { agentId, status }) => {
    const row = ctx.db.agent.id.find(agentId);
    if (!row) throw new SenderError(`No agent ${agentId}`);
    ctx.db.agent.id.update({
      ...row,
      status: oneOf("status", status, AGENT_STATUS),
      lastSeenAt: ctx.timestamp,
    });
  },
);

/** An agent calls dibs. The overlap check happens afterwards in core. */
export const publishIntent = spacetimedb.reducer(
  {
    agentId: t.u64(),
    title: t.string(),
    description: t.string(),
    interfaces: t.array(t.string()),
    files: t.array(t.string()),
    embedding: t.array(t.f32()),
  },
  (ctx, args) => {
    if (!ctx.db.agent.id.find(args.agentId)) throw new SenderError(`No agent ${args.agentId}`);
    ctx.db.intent.insert({
      id: 0n,
      ...args,
      status: "active",
      overlapsIntentId: undefined,
      verdict: undefined,
      createdAt: ctx.timestamp,
    });
  },
);

/** Core's judge found that `intentId` overlaps an earlier intent. The earlier one owns it. */
export const recordOverlap = spacetimedb.reducer(
  { intentId: t.u64(), overlapsIntentId: t.u64(), verdict: t.string(), reason: t.string() },
  (ctx, { intentId, overlapsIntentId, verdict, reason }) => {
    const later = ctx.db.intent.id.find(intentId);
    const earlier = ctx.db.intent.id.find(overlapsIntentId);
    if (!later || !earlier) throw new SenderError("Unknown intent");
    // Reducers commit in order and ids only go up, so a lower id called dibs first.
    if (earlier.id >= later.id) {
      throw new SenderError(
        `Intent ${overlapsIntentId} came after ${intentId}, so it can't own it`,
      );
    }
    const checked = oneOf("verdict", verdict, VERDICTS);
    ctx.db.intent.id.update({ ...later, overlapsIntentId: earlier.id, verdict: checked });
    if (checked === "independent") return;

    // Quiet by default: only the agent that has to change course hears about it.
    ctx.db.message.insert({
      id: 0n,
      fromAgentId: undefined,
      toAgentId: later.agentId,
      contractId: undefined,
      kind: "overlap",
      body: `"${later.title}" overlaps "${earlier.title}" (${checked}): ${reason}`,
      read: false,
      createdAt: ctx.timestamp,
    });
  },
);

/** The consumer asks the owner for what it needs. Opens a proposed contract. */
export const requestFeature = spacetimedb.reducer(
  { consumerIntentId: t.u64(), ownerIntentId: t.u64(), requirements: t.array(t.string()) },
  (ctx, { consumerIntentId, ownerIntentId, requirements }) => {
    const consumer = ctx.db.intent.id.find(consumerIntentId);
    const owner = ctx.db.intent.id.find(ownerIntentId);
    if (!consumer || !owner) throw new SenderError("Unknown intent");
    const row = ctx.db.contract.insert({
      id: 0n,
      ownerIntentId,
      consumerIntentId,
      interface: "",
      requirements,
      stubPath: undefined,
      testPath: undefined,
      status: "proposed",
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    ctx.db.message.insert({
      id: 0n,
      fromAgentId: consumer.agentId,
      toAgentId: owner.agentId,
      contractId: row.id,
      kind: "request",
      body: requirements.join("\n"),
      read: false,
      createdAt: ctx.timestamp,
    });
  },
);

export const markRead = spacetimedb.reducer({ messageId: t.u64() }, (ctx, { messageId }) => {
  const row = ctx.db.message.id.find(messageId);
  if (row) ctx.db.message.id.update({ ...row, read: true });
});

// TODO(core lane): proposeContract (store the agreed interface, stub and test paths) and
// markDelivered (status, ping the consumer). See docs/plan.md for the flow.

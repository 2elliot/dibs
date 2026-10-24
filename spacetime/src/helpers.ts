import { SenderError, type ReducerCtx } from "spacetimedb/server";
import { ScheduleAt } from "spacetimedb";
import { LIMITS, type EventType } from "@dibs/protocol";
import { db } from "./schema.ts";
import { timing } from "./timing.ts";

export type Ctx = ReducerCtx<typeof db.schemaType>;
export const now = (ctx: Ctx) => ctx.timestamp.microsSinceUnixEpoch;
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SenderError(message);
}
export function text(
  value: string,
  max: number,
  name: string,
  allowEmpty = false,
) {
  check(
    (allowEmpty || value.trim().length > 0) && value.length <= max,
    `invalid ${name}`,
  );
}
export function json(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new SenderError(`invalid ${name} JSON`);
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}
export function actor(ctx: Ctx) {
  return ctx.db.participant.identity.find(ctx.sender);
}
export function role(ctx: Ctx, expected: string) {
  const p = actor(ctx);
  check(p?.role === expected, `not ${expected}`);
  return p;
}
export function adminOnly(ctx: Ctx) {
  check(
    ctx.db.admin.identity.find(ctx.sender) || actor(ctx)?.role === "admin",
    "not admin",
  );
}
export function agentLobby(ctx: Ctx, running = true) {
  const p = role(ctx, "agent");
  check(p.currentLobbyId !== undefined, "not in a lobby");
  const l = ctx.db.lobby.id.find(p.currentLobbyId);
  check(l && (!running || l.state === "running"), "lobby not running");
  return { p, l };
}
export function emit(
  ctx: Ctx,
  lobbyId: number,
  type: EventType,
  subjectId = 0,
  detail: Record<string, unknown> = {},
) {
  ctx.db.event.insert({
    id: 0,
    lobbyId,
    atUs: now(ctx),
    actor: actor(ctx)?.name ?? "system",
    type,
    subjectId,
    detail: canonical(detail),
  });
}
export function once(
  ctx: Ctx,
  requestId: string,
  operation: string,
  args: unknown,
  lobbyId: number,
) {
  text(requestId, 200, "requestId");
  const payload = canonical({
    sender: ctx.sender.toHexString(),
    lobbyId,
    operation,
    args,
  });
  check(
    encodeURIComponent(payload).replace(/%[A-F\d]{2}/g, "_").length <=
      LIMITS.requestPayloadBytes,
    "request payload exceeds 4 KB",
  );
  const old = ctx.db.request.requestId.find(requestId);
  if (old) {
    check(old.payload === payload, "requestId reused with different payload");
    return false;
  }
  ctx.db.request.insert({ requestId, payload, atUs: now(ctx) });
  return true;
}
export const items = (ctx: Ctx, lobbyId: number) =>
  [...ctx.db.planItem.lobbyId.filter(lobbyId)].filter((i) => i.current);
export const agents = (ctx: Ctx, lobbyId: number) =>
  [...ctx.db.participant.iter()].filter(
    (p) => p.role === "agent" && p.currentLobbyId === lobbyId,
  );
/** When the key's current negotiation round began: its latest contract, or never (0). */
export function roundStartUs(ctx: Ctx, lobbyId: number, key: string) {
  return [...ctx.db.contract.lobbyId.filter(lobbyId)]
    .filter((c) => c.key === key)
    .reduce((max, c) => (c.createdAtUs > max ? c.createdAtUs : max), 0n);
}
export function unresolved(ctx: Ctx, lobbyId: number) {
  const proposals = [...ctx.db.proposal.lobbyId.filter(lobbyId)];
  // The next submitted analysis answers a rejection, whatever it concluded: a new revision,
  // an aligned contract, or no finding for the key at all.
  const answeredUs = [...ctx.db.event.lobbyId.filter(lobbyId)]
    .filter((e) => e.type === "analysis_submitted")
    .reduce((max, e) => (e.atUs > max ? e.atUs : max), -1n);
  return [...ctx.db.response.lobbyId.filter(lobbyId)].filter((r) => {
    if (r.decision !== "reject" || answeredUs > r.createdAtUs) return false;
    const p = proposals.find((p) => p.id === r.proposalId);
    return (
      p &&
      p.state !== "escalated" &&
      !proposals.some((q) => q.key === p.key && q.revision > r.revision)
    );
  });
}
export function inputKey(ctx: Ctx, lobbyId: number) {
  const p = [...ctx.db.plan.lobbyId.filter(lobbyId)]
    .filter((p) => p.current)
    .map((p) => p.id)
    .sort((a, b) => a - b);
  const r = unresolved(ctx, lobbyId)
    .map((r) => r.id)
    .sort((a, b) => a - b);
  return `p:${p.join(",")};r:${r.join(",")}`;
}
export function deliver(
  ctx: Ctx,
  lobbyId: number,
  targetId: number,
  kind: string,
  refId: number,
  summary: string,
) {
  return ctx.db.delivery.insert({
    id: 0,
    lobbyId,
    targetId,
    kind,
    refId,
    summary: summary.slice(0, LIMITS.hookContextChars),
    stage: "queued",
    queuedAtUs: now(ctx),
    receivedAtUs: 0n,
    shownAtUs: 0n,
    respondedAtUs: 0n,
  });
}
export function queue(ctx: Ctx, lobbyId: number, debounce: boolean) {
  const old = ctx.db.job.slot.find(String(lobbyId));
  const key = inputKey(ctx, lobbyId);
  const fields = {
    slot: String(lobbyId),
    lobbyId,
    kind: unresolved(ctx, lobbyId).length ? "revise" : "analyze",
    state: debounce ? "debouncing" : "queued",
    inputKey: key,
    leaseToken: "",
    leaseExpiresUs: 0n,
    attempts: 0,
    calls: old?.calls ?? 0,
    error: "",
    updatedAtUs: now(ctx),
  };
  const j = old
    ? { id: old.id, ...fields }
    : ctx.db.job.insert({ id: 0, ...fields });
  if (old) ctx.db.job.id.update(j);
  if (debounce)
    ctx.db.jobTimer.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(
        now(ctx) + BigInt(Math.round(timing.debounceSec * 1e6)),
      ),
      jobId: j.id,
      inputKey: key,
    });
  emit(ctx, lobbyId, debounce ? "job_debouncing" : "job_queued", j.id);
  return j;
}
export function promote(ctx: Ctx, jobId: number, key: string) {
  const j = ctx.db.job.id.find(jobId);
  const l = j && ctx.db.lobby.id.find(j.lobbyId);
  if (
    !j ||
    !l ||
    l.state !== "running" ||
    j.state !== "debouncing" ||
    j.inputKey !== key
  )
    return;
  const plans = [...ctx.db.plan.lobbyId.filter(l.id)].filter((p) => p.current);
  if (
    !l.analyzeAnywayFired &&
    !agents(ctx, l.id).every((p) => plans.some((q) => q.participantId === p.id))
  )
    return;
  ctx.db.job.id.update({ ...j, state: "queued", updatedAtUs: now(ctx) });
  emit(ctx, l.id, "job_queued", j.id);
}
export function schedulerOnly(ctx: Ctx) {
  check(
    ctx.connectionId === null && ctx.sender.isEqual(ctx.databaseIdentity),
    "scheduler only",
  );
}
export function closeProposal(ctx: Ctx, id: number, state: string) {
  const p = ctx.db.proposal.id.find(id)!;
  ctx.db.proposal.id.update({
    ...p,
    state,
    slot: `closed/${p.id}`,
    closedAtUs: now(ctx),
  });
}
/**
 * True when every current plan item on `key` already existed, word for word, at `sinceUs`.
 * Re-analysis runs over every key after any plan change, and a model may reword its output each
 * time, so "nothing to tell the agents" is decided by the plans themselves, not by the text.
 */
export function keyUnchangedSince(
  ctx: Ctx,
  lobbyId: number,
  key: string,
  sinceUs: bigint,
) {
  const onKey = [...ctx.db.planItem.lobbyId.filter(lobbyId)].filter(
    (i) => i.key === key,
  );
  const before = onKey.filter(
    (i) => (ctx.db.plan.id.find(i.planId)?.createdAtUs ?? 0n) <= sinceUs,
  );
  return onKey
    .filter((i) => i.current)
    .every((i) =>
      before.some(
        (b) =>
          b.participantId === i.participantId &&
          b.kind === i.kind &&
          b.text === i.text,
      ),
    );
}
export function writeContract(
  ctx: Ctx,
  lobbyId: number,
  key: string,
  value: string,
  source: "agreed" | "aligned",
  basisItemIds: number[],
  proposalId?: number,
) {
  const rows = [...ctx.db.contract.lobbyId.filter(lobbyId)].filter(
    (c) => c.key === key,
  );
  const current = rows.find((c) => c.current);
  if (current?.source === "agreed" && source === "aligned") return;
  if (
    current?.source === "aligned" &&
    source === "aligned" &&
    keyUnchangedSince(ctx, lobbyId, key, current.createdAtUs)
  )
    return;
  if (current) ctx.db.contract.id.update({ ...current, current: false });
  const c = ctx.db.contract.insert({
    id: 0,
    lobbyId,
    key,
    revision: Math.max(0, ...rows.map((c) => c.revision)) + 1,
    text: value,
    source,
    proposalId,
    basisItemIds,
    current: true,
    createdAtUs: now(ctx),
  });
  const parties = [
    ...new Set(
      items(ctx, lobbyId)
        .filter((i) => i.key === key)
        .map((i) => i.participantId),
    ),
  ];
  const voterCount =
    source === "agreed"
      ? ctx.db.proposal.id.find(proposalId!)!.requiredPartyIds.length
      : 0;
  const summary =
    source === "agreed"
      ? `dibs: the contract for ${key} is agreed (rev ${c.revision}, HANDSHAKE ${voterCount}/${voterCount}): ${value}`
      : `dibs: plans already agree on ${key}: ${value}`;
  for (const target of parties)
    deliver(
      ctx,
      lobbyId,
      target,
      source === "agreed" ? "contract" : "aligned",
      c.id,
      summary,
    );
  emit(
    ctx,
    lobbyId,
    source === "agreed" ? "contract_agreed" : "contract_aligned",
    c.id,
    { key },
  );
}

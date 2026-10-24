import { SenderError, t } from "spacetimedb/server";
import { ScheduleAt } from "spacetimedb";
import {
  DECISIONS,
  DELIVERY_KINDS,
  DELIVERY_STAGES,
  LIMITS,
  MESSAGE_TARGETS,
  MODES,
  PROVIDERS,
  RELATIONS,
  REVIEW_KINDS,
  ROLES,
  type Finding,
} from "@dibs/protocol";
import { db, jobTimer, lobbyTimer } from "./schema.ts";
import {
  actor,
  adminOnly,
  agentLobby,
  agents,
  canonical,
  check,
  closeProposal,
  deliver,
  emit,
  inputKey,
  items,
  json,
  now,
  once,
  promote,
  queue,
  role,
  schedulerOnly,
  text,
  writeContract,
  type Ctx,
} from "./helpers.ts";
import { timing } from "./timing.ts";
export default db;

export const init = db.init((ctx) => {
  ctx.db.admin.insert({ identity: ctx.sender });
  const code = Array.from({ length: 4 }, () =>
    ctx.random().toString(36).slice(2),
  ).join("");
  ctx.db.invite.insert({
    code,
    name: "admin",
    provider: "claude",
    role: "admin",
    used: false,
  });
  emit(ctx, 0, "invite_created", 0, { name: "admin", role: "admin" });
});
function presence(ctx: Ctx, online: boolean) {
  if (ctx.connectionId === null) return;
  const old = ctx.db.presenceConnection.connectionId.find(ctx.connectionId);
  if (online && !old)
    ctx.db.presenceConnection.insert({
      connectionId: ctx.connectionId,
      identity: ctx.sender,
    });
  if (!online && old)
    ctx.db.presenceConnection.connectionId.delete(ctx.connectionId);
  const p = actor(ctx);
  if (p)
    ctx.db.participant.id.update({
      ...p,
      online:
        [...ctx.db.presenceConnection.identity.filter(ctx.sender)].length > 0,
    });
}
export const onConnect = db.clientConnected((ctx) => presence(ctx, true));
export const onDisconnect = db.clientDisconnected((ctx) =>
  presence(ctx, false),
);

export const createInvite = db.reducer(
  {
    code: t.string(),
    name: t.string(),
    provider: t.string(),
    role: t.string(),
  },
  (ctx, a) => {
    adminOnly(ctx);
    text(a.code, 200, "code");
    text(a.name, 64, "name");
    check(/^[a-z][a-z0-9_-]*$/.test(a.name), "invalid participant name");
    check(
      PROVIDERS.includes(a.provider as never) &&
        ROLES.includes(a.role as never),
      "invalid provider or role",
    );
    check(!ctx.db.invite.code.find(a.code), "code already exists");
    check(
      !ctx.db.participant.name.find(a.name) &&
        ![...ctx.db.invite.iter()].some((i) => i.name === a.name && !i.used),
      "name already invited",
    );
    ctx.db.invite.insert({ ...a, used: false });
    emit(ctx, 0, "invite_created", 0, { name: a.name, role: a.role });
  },
);
export const claimInvite = db.reducer({ code: t.string() }, (ctx, { code }) => {
  const i = ctx.db.invite.code.find(code);
  check(i, "invalid invite");
  const p = ctx.db.participant.name.find(i.name);
  if (p) {
    check(p.identity.isEqual(ctx.sender), "name already bound");
    return;
  }
  check(!i.used, "invite already used");
  check(!actor(ctx), "identity already claimed");
  const row = ctx.db.participant.insert({
    id: 0,
    identity: ctx.sender,
    name: i.name,
    provider: i.provider,
    role: i.role,
    online: ctx.connectionId !== null,
    buildHash: "",
    currentLobbyId: undefined,
  });
  ctx.db.invite.code.update({ ...i, used: true });
  presence(ctx, true);
  emit(ctx, 0, "invite_claimed", row.id, { name: row.name });
});
export const createLobby = db.reducer(
  {
    scenario: t.string(),
    mode: t.string(),
    baseSha: t.string(),
    vocabularyJson: t.string(),
    charter: t.string(),
    buildHash: t.string(),
  },
  (ctx, a) => {
    adminOnly(ctx);
    check(MODES.includes(a.mode as never), "invalid mode");
    text(a.scenario, 100, "scenario");
    text(a.baseSha, 100, "baseSha");
    text(a.buildHash, 200, "buildHash");
    text(a.charter, 20000, "charter");
    const vocabulary = json(a.vocabularyJson, "vocabulary");
    check(
      Array.isArray(vocabulary) &&
        vocabulary.length > 0 &&
        vocabulary.length <= 100,
      "invalid vocabulary",
    );
    const keys: string[] = [];
    for (const v of vocabulary) {
      check(
        v && typeof v.key === "string" && typeof v.description === "string",
        "invalid vocabulary entry",
      );
      text(v.key, 100, "key");
      text(v.description, 1000, "description");
      check(!keys.includes(v.key), "duplicate vocabulary key");
      keys.push(v.key);
    }
    const l = ctx.db.lobby.insert({
      id: 0,
      ...a,
      vocabulary: keys,
      vocabularyJson: canonical(vocabulary),
      state: "setup",
      analyzeAnywayFired: false,
      createdAtUs: now(ctx),
      startedAtUs: 0n,
      fallbackAtUs: 0n,
      endsAtUs: 0n,
    });
    emit(ctx, l.id, "lobby_created", l.id, {
      mode: l.mode,
      scenario: l.scenario,
    });
  },
);
export const startLobby = db.reducer(
  { lobbyId: t.u32() },
  (ctx, { lobbyId }) => {
    adminOnly(ctx);
    const l = ctx.db.lobby.id.find(lobbyId);
    check(l?.state === "setup", "lobby not in setup");
    const at = now(ctx);
    const after = (sec: number) => at + BigInt(Math.round(sec * 1e6));
    ctx.db.lobby.id.update({
      ...l,
      state: "running",
      startedAtUs: at,
      fallbackAtUs: after(timing.fallbackSec),
      endsAtUs: after(timing.endSec),
    });
    for (const [action, sec] of [
      ["analyze_anyway", timing.analyzeAnywaySec],
      ["fallback", timing.fallbackSec],
      ["stop", timing.endSec],
    ] as const)
      ctx.db.lobbyTimer.insert({
        scheduledId: 0n,
        scheduledAt: ScheduleAt.time(after(sec)),
        lobbyId,
        action,
      });
    emit(ctx, lobbyId, "lobby_started", lobbyId);
  },
);
export const stopLobby = db.reducer(
  { lobbyId: t.u32() },
  (ctx, { lobbyId }) => {
    adminOnly(ctx);
    const l = ctx.db.lobby.id.find(lobbyId);
    check(
      l && (l.state === "running" || l.state === "setup"),
      "lobby not active",
    );
    ctx.db.lobby.id.update({ ...l, state: "stopped" });
    emit(ctx, lobbyId, "lobby_stopped", lobbyId);
  },
);
export const markVerified = db.reducer(
  { lobbyId: t.u32() },
  (ctx, { lobbyId }) => {
    role(ctx, "verifier");
    const l = ctx.db.lobby.id.find(lobbyId);
    check(l && l.state !== "setup", "lobby not started");
    check(
      [...ctx.db.verification.lobbyId.filter(lobbyId)].length > 0,
      "no verification evidence",
    );
    ctx.db.lobby.id.update({ ...l, state: "verified" });
    emit(ctx, lobbyId, "verification_recorded", lobbyId, { state: "verified" });
  },
);
export const debugDeliver = db.reducer(
  { targetId: t.u32(), kind: t.string(), summary: t.string() },
  (ctx, a) => {
    adminOnly(ctx);
    const p = ctx.db.participant.id.find(a.targetId);
    check(p, "unknown target");
    check(DELIVERY_KINDS.includes(a.kind as never), "invalid delivery kind");
    text(a.summary, LIMITS.hookContextChars, "summary");
    const d = deliver(ctx, p.currentLobbyId ?? 0, p.id, a.kind, 0, a.summary);
    emit(ctx, d.lobbyId, "notice_sent", d.id, { debug: true });
  },
);
export const joinLobby = db.reducer(
  { lobbyId: t.u32(), buildHash: t.string() },
  (ctx, a) => {
    const p = role(ctx, "agent");
    const l = ctx.db.lobby.id.find(a.lobbyId);
    check(
      l && (l.state === "setup" || l.state === "running"),
      "lobby not active",
    );
    check(a.buildHash === l.buildHash, "build mismatch");
    const old =
      p.currentLobbyId === undefined
        ? undefined
        : ctx.db.lobby.id.find(p.currentLobbyId);
    check(
      !old ||
        old.id === l.id ||
        old.state === "stopped" ||
        old.state === "verified",
      "already in an active lobby",
    );
    ctx.db.participant.id.update({
      ...p,
      currentLobbyId: l.id,
      buildHash: a.buildHash,
    });
    emit(ctx, l.id, "joined_lobby", p.id);
  },
);
const item = t.object("PlanInputItem", { key: t.string(), text: t.string() });
export const publishPlan = db.reducer(
  {
    requestId: t.string(),
    goal: t.string(),
    produces: t.array(item),
    requires: t.array(item),
    notes: t.string(),
  },
  (ctx, a) => {
    const { p, l } = agentLobby(ctx, false);
    if (!once(ctx, a.requestId, "publish_plan", a, l.id)) return;
    check(l.state === "running", "lobby not running");
    text(a.goal, LIMITS.goalChars, "goal");
    text(a.notes, LIMITS.notesChars, "notes", true);
    const incoming = [
      ...a.produces.map((i) => ({ ...i, kind: "produces" })),
      ...a.requires.map((i) => ({ ...i, kind: "requires" })),
    ];
    check(incoming.length <= LIMITS.planItems, "too many plan items");
    const seen = new Set<string>();
    for (const i of incoming) {
      check(l.vocabulary.includes(i.key), "unknown vocabulary key");
      text(i.text, LIMITS.textChars, "item text");
      check(!seen.has(`${i.kind}/${i.key}`), "duplicate plan item");
      seen.add(`${i.kind}/${i.key}`);
    }
    const oldItems = items(ctx, l.id).filter((i) => i.participantId === p.id);
    for (const proposal of ctx.db.proposal.lobbyId.filter(l.id)) {
      if (proposal.state !== "proposed") continue;
      const changed = proposal.citedItemIds.some((id) => {
        const basis = ctx.db.planItem.id.find(id);
        if (!basis || basis.participantId !== p.id) return false;
        return !incoming.some(
          (i) =>
            i.key === basis.key &&
            i.kind === basis.kind &&
            i.text === basis.text,
        );
      });
      if (changed) {
        closeProposal(ctx, proposal.id, "superseded");
        emit(ctx, l.id, "proposal_superseded", proposal.id, {
          key: proposal.key,
        });
      }
    }
    const old = [...ctx.db.plan.participantId.filter(p.id)].filter(
      (q) => q.lobbyId === l.id,
    );
    for (const q of old.filter((q) => q.current))
      ctx.db.plan.id.update({ ...q, current: false });
    for (const i of oldItems)
      ctx.db.planItem.id.update({ ...i, current: false });
    const q = ctx.db.plan.insert({
      id: 0,
      lobbyId: l.id,
      participantId: p.id,
      revision: Math.max(0, ...old.map((q) => q.revision)) + 1,
      goal: a.goal,
      notes: a.notes,
      requestId: a.requestId,
      current: true,
      createdAtUs: now(ctx),
    });
    for (const i of incoming)
      ctx.db.planItem.insert({
        id: 0,
        planId: q.id,
        lobbyId: l.id,
        participantId: p.id,
        ...i,
        current: true,
      });
    emit(ctx, l.id, "plan_published", q.id, {
      participantId: p.id,
      revision: q.revision,
    });
    if (l.mode === "dibs") queue(ctx, l.id, true);
  },
);
export const sendMessage = db.reducer(
  { requestId: t.string(), to: t.string(), text: t.string() },
  (ctx, a) => {
    const { p, l } = agentLobby(ctx, false);
    check(l.mode !== "none", "messages disabled in none mode");
    if (!once(ctx, a.requestId, "send_message", a, l.id)) return;
    check(l.state === "running", "lobby not running");
    check(MESSAGE_TARGETS.includes(a.to as never), "invalid recipient");
    text(a.text, LIMITS.messageChars, "message");
    const targets = agents(ctx, l.id).filter(
      (q) => q.id !== p.id && (a.to === "all" || q.provider === a.to),
    );
    check(targets.length > 0, "no recipient in lobby");
    const m = ctx.db.message.insert({
      id: 0,
      lobbyId: l.id,
      fromId: p.id,
      ...a,
      createdAtUs: now(ctx),
    });
    for (const q of targets)
      deliver(
        ctx,
        l.id,
        q.id,
        "message",
        m.id,
        `dibs: ${p.name} says ${a.text}`,
      );
    emit(ctx, l.id, "message_sent", m.id);
  },
);
export const markDelivery = db.reducer(
  { deliveryId: t.u32(), stage: t.string() },
  (ctx, a) => {
    const p = actor(ctx);
    const d = ctx.db.delivery.id.find(a.deliveryId);
    check(p && d && d.targetId === p.id, "not delivery target");
    const from = DELIVERY_STAGES.indexOf(d.stage as never),
      to = DELIVERY_STAGES.indexOf(a.stage as never);
    check(to >= 0 && to >= from, "delivery cannot move backward");
    if (to === from) return;
    ctx.db.delivery.id.update({
      ...d,
      stage: a.stage,
      receivedAtUs:
        to >= 1 && d.receivedAtUs === 0n ? now(ctx) : d.receivedAtUs,
      shownAtUs: to >= 2 && d.shownAtUs === 0n ? now(ctx) : d.shownAtUs,
      respondedAtUs:
        to >= 3 && d.respondedAtUs === 0n ? now(ctx) : d.respondedAtUs,
    });
    emit(ctx, d.lobbyId, "delivery_stage", d.id, { stage: a.stage });
  },
);
export const respond = db.reducer(
  {
    requestId: t.string(),
    proposalId: t.u32(),
    revision: t.u32(),
    decision: t.string(),
    reason: t.string(),
  },
  (ctx, a) => {
    const { p, l } = agentLobby(ctx, false);
    if (!once(ctx, a.requestId, "respond", a, l.id)) return;
    check(l.state === "running", "lobby not running");
    check(l.mode === "dibs", "proposals disabled");
    const proposal = ctx.db.proposal.id.find(a.proposalId);
    check(
      proposal &&
        proposal.lobbyId === l.id &&
        proposal.state === "proposed" &&
        proposal.revision === a.revision,
      "proposal not open at revision",
    );
    check(proposal.requiredPartyIds.includes(p.id), "not a required party");
    check(DECISIONS.includes(a.decision as never), "invalid decision");
    text(a.reason, LIMITS.notesChars, "reason", a.decision === "accept");
    check(
      ![...ctx.db.response.proposalId.filter(proposal.id)].some(
        (r) => r.participantId === p.id && r.revision === a.revision,
      ),
      "already responded",
    );
    ctx.db.response.insert({
      id: 0,
      lobbyId: l.id,
      participantId: p.id,
      ...a,
      createdAtUs: now(ctx),
    });
    for (const d of ctx.db.delivery.targetId.filter(p.id))
      if (d.kind === "proposal" && d.refId === proposal.id)
        ctx.db.delivery.id.update({
          ...d,
          stage: "responded",
          receivedAtUs: d.receivedAtUs || now(ctx),
          shownAtUs: d.shownAtUs || now(ctx),
          respondedAtUs: now(ctx),
        });
    emit(ctx, l.id, "response_recorded", proposal.id, {
      participantId: p.id,
      decision: a.decision,
      revision: a.revision,
    });
    if (a.decision === "reject") {
      const keyProposals = [...ctx.db.proposal.lobbyId.filter(l.id)]
        .filter((q) => q.key === proposal.key)
        .map((q) => q.id);
      const rejections = [...ctx.db.response.lobbyId.filter(l.id)].filter(
        (r) => r.decision === "reject" && keyProposals.includes(r.proposalId),
      );
      const escalated = rejections.length >= 2;
      closeProposal(ctx, proposal.id, escalated ? "escalated" : "rejected");
      emit(
        ctx,
        l.id,
        escalated ? "proposal_escalated" : "proposal_rejected",
        proposal.id,
        { key: proposal.key },
      );
      if (escalated) {
        for (const id of proposal.requiredPartyIds)
          deliver(
            ctx,
            l.id,
            id,
            "escalated",
            proposal.id,
            `dibs: proposal P${proposal.id} for ${proposal.key} was rejected twice and needs the developers.`,
          );
        const job = ctx.db.job.slot.find(String(l.id));
        // Another key can already be under analysis. Its snapshot changed too;
        // replace that lease rather than leave a permanently stale active job.
        if (job && ["debouncing", "queued", "leased"].includes(job.state))
          queue(ctx, l.id, false);
      } else queue(ctx, l.id, false);
    } else {
      const accepted = [
        ...ctx.db.response.proposalId.filter(proposal.id),
      ].filter((r) => r.revision === a.revision && r.decision === "accept");
      if (
        proposal.requiredPartyIds.every((id) =>
          accepted.some((r) => r.participantId === id),
        )
      ) {
        closeProposal(ctx, proposal.id, "accepted");
        emit(ctx, l.id, "proposal_accepted", proposal.id);
        writeContract(
          ctx,
          l.id,
          proposal.key,
          proposal.contractText,
          "agreed",
          proposal.citedItemIds,
          proposal.id,
        );
      }
    }
  },
);
export const reportHead = db.reducer(
  { lobbyId: t.u32(), sha: t.string(), outOfAreaFiles: t.array(t.string()) },
  (ctx, a) => {
    const { p, l } = agentLobby(ctx, false);
    check(l.id === a.lobbyId && l.state !== "setup", "wrong lobby");
    check(/^[a-f0-9]{40,64}$/.test(a.sha), "invalid head SHA");
    check(
      a.outOfAreaFiles.length <= 10000 &&
        a.outOfAreaFiles.every((f) => f.length <= 1000),
      "invalid file list",
    );
    const h = ctx.db.head.insert({
      id: 0,
      participantId: p.id,
      ...a,
      createdAtUs: now(ctx),
    });
    emit(ctx, l.id, "head_reported", h.id);
  },
);
export const promoteJob = db.reducer(
  { onSchedule: jobTimer },
  { arg: jobTimer.rowType },
  (ctx, { arg }) => {
    schedulerOnly(ctx);
    promote(ctx, arg.jobId, arg.inputKey);
  },
);
export const lobbyTick = db.reducer(
  { onSchedule: lobbyTimer },
  { arg: lobbyTimer.rowType },
  (ctx, { arg }) => {
    schedulerOnly(ctx);
    const l = ctx.db.lobby.id.find(arg.lobbyId);
    if (!l || l.state !== "running") return;
    if (arg.action === "analyze_anyway") {
      ctx.db.lobby.id.update({ ...l, analyzeAnywayFired: true });
      const j = ctx.db.job.slot.find(String(l.id));
      if (j) promote(ctx, j.id, j.inputKey);
    } else if (arg.action === "fallback") {
      const j = ctx.db.job.slot.find(String(l.id));
      for (const p of agents(ctx, l.id)) {
        const keys = [
          ...new Set(
            items(ctx, l.id)
              .filter((i) => i.participantId === p.id)
              .map((i) => i.key),
          ),
        ];
        const pending = keys.some((key) => {
          const contracts = [...ctx.db.contract.lobbyId.filter(l.id)];
          return (
            j?.state === "debouncing" ||
            j?.state === "queued" ||
            j?.state === "leased" ||
            (!contracts.some((c) => c.key === key && c.current) &&
              ctx.db.proposal.slot.find(`${l.id}/${key}`))
          );
        });
        if (pending)
          deliver(
            ctx,
            l.id,
            p.id,
            "fallback",
            l.id,
            "dibs: the coordination deadline was reached with unresolved dependencies; the developers need to decide.",
          );
      }
      emit(ctx, l.id, "fallback_reached", l.id);
    } else if (arg.action === "stop") {
      ctx.db.lobby.id.update({ ...l, state: "stopped" });
      emit(ctx, l.id, "lobby_stopped", l.id);
    }
  },
);
function leased(ctx: Ctx, jobId: number, leaseToken: string) {
  role(ctx, "worker");
  const j = ctx.db.job.id.find(jobId);
  check(
    j &&
      j.state === "leased" &&
      j.leaseToken === leaseToken &&
      j.leaseExpiresUs > now(ctx),
    "stale lease",
  );
  check(
    ctx.db.lobby.id.find(j.lobbyId)?.state === "running",
    "lobby not running",
  );
  return j;
}
export const leaseJob = db.reducer(
  { jobId: t.u32(), leaseToken: t.string() },
  (ctx, a) => {
    role(ctx, "worker");
    text(a.leaseToken, 200, "lease token");
    const j = ctx.db.job.id.find(a.jobId);
    check(
      j &&
        (j.state === "queued" ||
          (j.state === "leased" && j.leaseExpiresUs <= now(ctx))),
      "job not leasable",
    );
    check(
      ctx.db.lobby.id.find(j.lobbyId)?.state === "running",
      "lobby not running",
    );
    check(
      j.calls < LIMITS.analysisCallsPerLobby,
      "analysis call limit reached",
    );
    ctx.db.job.id.update({
      ...j,
      state: "leased",
      leaseToken: a.leaseToken,
      leaseExpiresUs: now(ctx) + BigInt(timing.leaseSec * 1e6),
      attempts: j.attempts + 1,
      calls: j.calls + 1,
      updatedAtUs: now(ctx),
    });
    emit(ctx, j.lobbyId, "job_leased", j.id);
  },
);
export const submitAnalysis = db.reducer(
  {
    jobId: t.u32(),
    leaseToken: t.string(),
    inputKey: t.string(),
    findingsJson: t.string(),
  },
  (ctx, a) => {
    const j = leased(ctx, a.jobId, a.leaseToken);
    check(
      a.inputKey === j.inputKey && a.inputKey === inputKey(ctx, j.lobbyId),
      "stale inputKey",
    );
    const l = ctx.db.lobby.id.find(j.lobbyId)!;
    check(l.mode === "dibs", "analysis disabled");
    check(a.findingsJson.length <= 100000, "findings too large");
    const result = json(a.findingsJson, "findings") as { findings?: unknown };
    check(
      result && Array.isArray(result.findings) && result.findings.length <= 100,
      "invalid findings",
    );
    const current = items(ctx, l.id);
    const seen = new Set<string>();
    for (const raw of result.findings) {
      check(raw && typeof raw === "object", "invalid finding");
      const f = raw as Finding;
      check(
        typeof f.key === "string" &&
          RELATIONS.includes(f.relation) &&
          Array.isArray(f.citedItemIds) &&
          f.citedItemIds.every((id) => Number.isSafeInteger(id) && id > 0) &&
          typeof f.explanation === "string" &&
          typeof f.contractText === "string",
        "invalid finding fields",
      );
      text(f.explanation, 4000, "explanation");
      text(f.contractText, 4000, "contractText", f.relation === "unowned");
      if (
        seen.has(f.key) ||
        !l.vocabulary.includes(f.key) ||
        f.citedItemIds.length === 0 ||
        f.citedItemIds.some(
          (id) => !current.some((i) => i.id === id && i.key === f.key),
        )
      )
        continue;
      seen.add(f.key);
      const cited = current.filter((i) => f.citedItemIds.includes(i.id));
      const existing = [...ctx.db.contract.lobbyId.filter(l.id)].find(
        (c) => c.current && c.key === f.key && c.source === "agreed",
      );
      if (existing) {
        if (f.relation === "compatible") continue;
        const changed = cited.some(
          (i) =>
            !existing.basisItemIds.includes(i.id) &&
            i.text !== existing.text &&
            !existing.basisItemIds.some((id) => {
              const b = ctx.db.planItem.id.find(id);
              return (
                b &&
                b.participantId === i.participantId &&
                b.kind === i.kind &&
                b.text === i.text
              );
            }),
        );
        if (!changed) continue;
      }
      const parties = [
        ...new Set(
          current.filter((i) => i.key === f.key).map((i) => i.participantId),
        ),
      ].sort((a, b) => a - b);
      if (f.relation === "unowned") {
        for (const p of agents(ctx, l.id))
          deliver(
            ctx,
            l.id,
            p.id,
            "notice",
            0,
            `dibs: ${f.key} has an unowned requirement: ${f.explanation}`,
          );
        emit(ctx, l.id, "notice_sent", 0, { key: f.key });
      } else if (f.relation === "compatible") {
        // A matching analysis must not silently close an existing handshake.
        if (!ctx.db.proposal.slot.find(`${l.id}/${f.key}`))
          writeContract(
            ctx,
            l.id,
            f.key,
            f.contractText,
            "aligned",
            f.citedItemIds,
          );
      } else {
        const open = ctx.db.proposal.slot.find(`${l.id}/${f.key}`);
        if (open) continue;
        const history = [...ctx.db.proposal.lobbyId.filter(l.id)].filter(
          (p) => p.key === f.key,
        );
        if (history.some((p) => p.state === "escalated")) continue;
        const p = ctx.db.proposal.insert({
          id: 0,
          slot: `${l.id}/${f.key}`,
          lobbyId: l.id,
          key: f.key,
          revision: Math.max(0, ...history.map((p) => p.revision)) + 1,
          relation: f.relation,
          contractText: f.contractText,
          rationale: f.explanation,
          citedItemIds: [...new Set(f.citedItemIds)],
          requiredPartyIds: parties,
          state: "proposed",
          inputKey: a.inputKey,
          createdAtUs: now(ctx),
          closedAtUs: 0n,
        });
        const basis = cited
          .map(
            (i) =>
              `${ctx.db.participant.id.find(i.participantId)?.name}'s plan says ${JSON.stringify(i.text)}`,
          )
          .join("; ");
        for (const id of parties)
          deliver(
            ctx,
            l.id,
            id,
            "proposal",
            p.id,
            `dibs update from your team's coordination service: proposal P${p.id} (rev ${p.revision}) for ${p.key} awaits your response. Proposed contract: ${p.contractText} Basis: ${basis}.`,
          );
        emit(ctx, l.id, "proposal_created", p.id, {
          key: p.key,
          revision: p.revision,
        });
      }
    }
    ctx.db.job.id.update({
      ...j,
      state: "done",
      leaseToken: "",
      leaseExpiresUs: 0n,
      updatedAtUs: now(ctx),
    });
    emit(ctx, l.id, "analysis_submitted", j.id);
  },
);
export const failJob = db.reducer(
  { jobId: t.u32(), leaseToken: t.string(), error: t.string() },
  (ctx, a) => {
    const j = leased(ctx, a.jobId, a.leaseToken);
    text(a.error, 2000, "error");
    ctx.db.job.id.update({
      ...j,
      state: "failed",
      error: a.error,
      leaseToken: "",
      leaseExpiresUs: 0n,
      updatedAtUs: now(ctx),
    });
    const current = items(ctx, j.lobbyId);
    for (const key of [...new Set(current.map((i) => i.key))]) {
      const onKey = current.filter((i) => i.key === key);
      const produces = onKey.filter((i) => i.kind === "produces"),
        requires = onKey.filter((i) => i.kind === "requires");
      if (!produces.length || !requires.length) continue;
      const names = (ids: number[]) =>
        [...new Set(ids)]
          .map((id) => ctx.db.participant.id.find(id)?.name)
          .join(", ");
      for (const id of [...new Set(onKey.map((i) => i.participantId))])
        deliver(
          ctx,
          j.lobbyId,
          id,
          "notice",
          j.id,
          `dibs: ${key}: ${names(produces.map((i) => i.participantId))} produces, ${names(requires.map((i) => i.participantId))} requires. The plans overlap and analysis is unavailable.`,
        );
    }
    emit(ctx, j.lobbyId, "job_failed", j.id);
  },
);
export const heartbeat = db.reducer(
  { name: t.string(), detailJson: t.string() },
  (ctx, a) => {
    const p = role(ctx, "worker");
    check(a.name === p.name, "heartbeat must use own name");
    check(a.detailJson.length <= 4000, "heartbeat too large");
    const detail = canonical(json(a.detailJson, "detail"));
    const row = { name: a.name, lastBeatUs: now(ctx), detail };
    if (ctx.db.service.name.find(a.name)) ctx.db.service.name.update(row);
    else ctx.db.service.insert(row);
  },
);
export const recordVerification = db.reducer(
  {
    lobbyId: t.u32(),
    assembledFrom: t.string(),
    treeHash: t.string(),
    mergeTreeClean: t.bool(),
    oracleHash: t.string(),
    exitCode: t.i32(),
    passed: t.u32(),
    total: t.u32(),
    reportHash: t.string(),
  },
  (ctx, a) => {
    const p = role(ctx, "verifier");
    check(ctx.db.lobby.id.find(a.lobbyId), "unknown lobby");
    check(a.passed <= a.total, "passed exceeds total");
    const assembled = json(a.assembledFrom, "assembledFrom");
    check(
      assembled &&
        typeof assembled === "object" &&
        !Array.isArray(assembled) &&
        Object.entries(assembled).every(
          ([key, value]) =>
            PROVIDERS.includes(key as never) &&
            typeof value === "string" &&
            /^[a-f0-9]{40,64}$/.test(value),
        ),
      "invalid assembledFrom",
    );
    for (const [name, value] of [
      ["treeHash", a.treeHash],
      ["oracleHash", a.oracleHash],
      ["reportHash", a.reportHash],
    ])
      check(/^[a-f0-9]{40,64}$/.test(value), `invalid ${name}`);
    const v = ctx.db.verification.insert({
      id: 0,
      ...a,
      assembledFrom: canonical(assembled),
      verifierId: p.id,
      createdAtUs: now(ctx),
    });
    emit(ctx, a.lobbyId, "verification_recorded", v.id);
  },
);
export const recordReview = db.reducer(
  {
    lobbyId: t.u32(),
    verificationId: t.u32(),
    kind: t.string(),
    summary: t.string(),
    findingsJson: t.string(),
    model: t.string(),
    sessionId: t.string(),
  },
  (ctx, a) => {
    role(ctx, "verifier");
    check(
      ctx.db.verification.id.find(a.verificationId)?.lobbyId === a.lobbyId,
      "wrong verification lobby",
    );
    check(REVIEW_KINDS.includes(a.kind as never), "invalid review kind");
    text(a.summary, 4000, "summary");
    text(a.model, 200, "model");
    text(a.sessionId, 200, "sessionId");
    check(a.findingsJson.length <= 100000, "review too large");
    const findings = json(a.findingsJson, "review") as {
      summary?: unknown;
      clauses?: unknown;
      rootCause?: unknown;
    };
    check(
      findings &&
        typeof findings.summary === "string" &&
        Array.isArray(findings.clauses) &&
        "rootCause" in findings,
      "invalid review findings",
    );
    for (const clause of findings.clauses) {
      check(
        clause &&
          typeof clause === "object" &&
          typeof clause.clause === "string" &&
          typeof clause.key === "string" &&
          ["conforms", "violates", "not_applicable"].includes(clause.verdict) &&
          Array.isArray(clause.evidence),
        "invalid review clause",
      );
      for (const evidence of clause.evidence)
        check(
          evidence &&
            typeof evidence.file === "string" &&
            Number.isSafeInteger(evidence.line) &&
            evidence.line > 0 &&
            typeof evidence.note === "string",
          "invalid review evidence",
        );
    }
    if (findings.rootCause !== null) {
      const root = findings.rootCause as Record<string, unknown>;
      check(
        root &&
          typeof root === "object" &&
          typeof root.key === "string" &&
          [...PROVIDERS, "unknown"].includes(root.violator as never) &&
          typeof root.explanation === "string",
        "invalid review rootCause",
      );
    }
    const r = ctx.db.review.insert({
      id: 0,
      lobbyId: a.lobbyId,
      verificationId: a.verificationId,
      kind: a.kind,
      summary: a.summary,
      findings: canonical(findings),
      model: a.model,
      sessionId: a.sessionId,
      createdAtUs: now(ctx),
    });
    emit(ctx, a.lobbyId, "review_recorded", r.id);
  },
);

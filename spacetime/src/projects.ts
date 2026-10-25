// Ordinary project rooms reuse negotiation, with separate onboarding/lifecycle.
// No capability is passed to helpers.once: its payload is public benchmark data.
import { t } from "spacetimedb/server";
import { ScheduleAt } from "spacetimedb";
import { db } from "./schema.ts";
import {
  actor,
  adminOnly,
  agents,
  canonical,
  check,
  deliver,
  emit,
  json,
  now,
  text,
  type Ctx,
} from "./helpers.ts";

export const PROJECT_PROTOCOL = "project-v1";
const DAY_US = 86_400_000_000n;

function settings(ctx: Ctx) {
  const old = ctx.db.projectSettings.id.find(1);
  check(old?.enabled, "Project onboarding is not enabled on this server.");
  const day = now(ctx) / DAY_US;
  if (old.day === day) return old;
  const next = { ...old, day, roomsToday: 0, leasesToday: 0 };
  ctx.db.projectSettings.id.update(next);
  return next;
}

export const configureProjects = db.reducer(
  {
    enabled: t.bool(),
    maxActiveRooms: t.u32(),
    maxRoomsPerDay: t.u32(),
    maxLeasesPerDay: t.u32(),
  },
  (ctx, args) => {
    adminOnly(ctx);
    check(
      args.maxActiveRooms <= 100 &&
        args.maxRoomsPerDay <= 1000 &&
        args.maxLeasesPerDay <= 10000,
      "Project budget is too large.",
    );
    const old = ctx.db.projectSettings.id.find(1);
    const day = now(ctx) / DAY_US;
    const row = {
      id: 1,
      ...args,
      day,
      roomsToday: old?.day === day ? old.roomsToday : 0,
      leasesToday: old?.day === day ? old.leasesToday : 0,
    };
    if (old) ctx.db.projectSettings.id.update(row);
    else ctx.db.projectSettings.insert(row);
    emit(ctx, 0, "notice_sent", 0, { projectOnboarding: args.enabled });
  },
);

function validateProvider(provider: string) {
  check(
    provider === "claude" || provider === "codex" || provider === "droid",
    "Projects support Claude, Codex and Droid.",
  );
}
function validateCode(code: string) {
  check(/^[a-f0-9]{48}$/.test(code), "Invalid project join code.");
}
function attachMember(ctx: Ctx, lobbyId: number, provider: string) {
  validateProvider(provider);
  const slot = `${lobbyId}/${provider}`;
  const old = ctx.db.projectMember.slot.find(slot);
  check(
    !old || old.identity.isEqual(ctx.sender),
    "This provider seat is already taken.",
  );
  const mine = ctx.db.projectMember.identity.find(ctx.sender);
  check(
    !mine || (mine.lobbyId === lobbyId && mine.provider === provider),
    "Use a separate identity for each project attachment.",
  );
  if (old) {
    const p = ctx.db.participant.id.find(old.participantId)!;
    ctx.db.participant.id.update({
      ...p,
      currentLobbyId: lobbyId,
      online: ctx.connectionId !== null,
    });
    return;
  }
  check(!actor(ctx), "Use a new project identity.");
  const p = ctx.db.participant.insert({
    id: 0,
    identity: ctx.sender,
    name: `project-${lobbyId}-${provider}`,
    provider,
    role: "agent",
    online: ctx.connectionId !== null,
    buildHash: PROJECT_PROTOCOL,
    currentLobbyId: lobbyId,
  });
  ctx.db.projectMember.insert({
    slot,
    lobbyId,
    identity: ctx.sender,
    participantId: p.id,
    provider,
  });
  emit(ctx, lobbyId, "joined_lobby", p.id);
}

export const createProject = db.reducer(
  {
    code: t.string(),
    provider: t.string(),
    brief: t.string(),
    vocabularyJson: t.string(),
    protocol: t.string(),
  },
  (ctx, args) => {
    validateCode(args.code);
    validateProvider(args.provider);
    check(
      args.protocol === PROJECT_PROTOCOL,
      "Incompatible project protocol. Update dibs.",
    );
    // vocabularyJson is a string at the reducer boundary. Canonicalize its
    // parsed value too, so recovery after reading the normalized lobby does
    // not depend on the original JSON object's property order.
    const payload = canonical({
      ...args,
      vocabularyJson: canonical(json(args.vocabularyJson, "vocabulary")),
    });
    const existing = ctx.db.projectRoom.code.find(args.code);
    if (existing) {
      check(
        existing.owner.isEqual(ctx.sender) &&
          existing.creationPayload === payload,
        "Project create request does not match.",
      );
      const l = ctx.db.lobby.id.find(existing.lobbyId)!;
      check(
        l.state === "running" && l.endsAtUs > now(ctx),
        "Project is closed or expired.",
      );
      attachMember(ctx, l.id, args.provider);
      return;
    }
    const s = settings(ctx);
    check(
      s.roomsToday < s.maxRoomsPerDay,
      "Daily project creation budget exhausted.",
    );
    const active = [...ctx.db.projectRoom.iter()].filter((r) => {
      const l = ctx.db.lobby.id.find(r.lobbyId);
      return l?.state === "running" && l.endsAtUs > now(ctx);
    }).length;
    check(active < s.maxActiveRooms, "Server active-project limit reached.");
    check(!actor(ctx), "Use a new project identity.");
    text(args.brief, 20000, "project brief");
    const vocabulary = json(args.vocabularyJson, "vocabulary") as {
      key: string;
      description: string;
    }[];
    check(
      Array.isArray(vocabulary) &&
        vocabulary.length > 0 &&
        vocabulary.length <= 20,
      "Provide 1–20 shared interfaces.",
    );
    const keys = new Set<string>();
    for (const entry of vocabulary) {
      check(
        entry &&
          typeof entry.key === "string" &&
          typeof entry.description === "string",
        "Invalid shared interface.",
      );
      check(
        /^[a-z][a-z0-9_.-]{0,99}$/.test(entry.key) && !keys.has(entry.key),
        "Invalid or duplicate shared interface key.",
      );
      text(entry.description, 1000, "interface description");
      keys.add(entry.key);
    }
    const at = now(ctx);
    const l = ctx.db.lobby.insert({
      id: 0,
      scenario: "project",
      mode: "dibs",
      baseSha: "unversioned",
      vocabulary: [...keys],
      vocabularyJson: canonical(vocabulary),
      charter: args.brief,
      buildHash: PROJECT_PROTOCOL,
      state: "running",
      analyzeAnywayFired: false,
      createdAtUs: at,
      startedAtUs: at,
      fallbackAtUs: at + DAY_US,
      endsAtUs: at + DAY_US,
    });
    ctx.db.projectRoom.insert({
      lobbyId: l.id,
      code: args.code,
      owner: ctx.sender,
      creationPayload: payload,
    });
    ctx.db.projectSettings.id.update({ ...s, roomsToday: s.roomsToday + 1 });
    attachMember(ctx, l.id, args.provider);
    ctx.db.lobbyTimer.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(l.endsAtUs),
      lobbyId: l.id,
      action: "stop",
    });
    emit(ctx, l.id, "lobby_created", l.id, {
      mode: "dibs",
      scenario: "project",
    });
    emit(ctx, l.id, "lobby_started", l.id);
  },
);

export const joinProject = db.reducer(
  { code: t.string(), provider: t.string(), protocol: t.string() },
  (ctx, args) => {
    settings(ctx);
    validateCode(args.code);
    check(
      args.protocol === PROJECT_PROTOCOL,
      "Incompatible project protocol. Update dibs.",
    );
    const room = ctx.db.projectRoom.code.find(args.code);
    check(room, "Invalid project join code.");
    const l = ctx.db.lobby.id.find(room.lobbyId)!;
    check(
      l.state === "running" && l.endsAtUs > now(ctx),
      "Project is closed or expired.",
    );
    attachMember(ctx, l.id, args.provider);
  },
);

export const resumeProject = db.reducer(
  { lobbyId: t.u32(), protocol: t.string() },
  (ctx, args) => {
    check(
      args.protocol === PROJECT_PROTOCOL,
      "Incompatible project protocol. Update dibs.",
    );
    const member = ctx.db.projectMember.identity.find(ctx.sender);
    check(member?.lobbyId === args.lobbyId, "Not a member of this project.");
    const l = ctx.db.lobby.id.find(args.lobbyId);
    check(
      l?.state === "running" && l.endsAtUs > now(ctx),
      "Project is closed or expired.",
    );
    attachMember(ctx, l.id, member.provider);
  },
);

export const leaveProject = db.reducer({ lobbyId: t.u32() }, (ctx, args) => {
  const member = ctx.db.projectMember.identity.find(ctx.sender);
  check(member?.lobbyId === args.lobbyId, "Not a member of this project.");
  const p = ctx.db.participant.id.find(member.participantId)!;
  ctx.db.participant.id.update({ ...p, currentLobbyId: undefined });
  emit(ctx, args.lobbyId, "notice_sent", p.id, { projectDetached: true });
});

export const closeProject = db.reducer({ lobbyId: t.u32() }, (ctx, args) => {
  const room = ctx.db.projectRoom.lobbyId.find(args.lobbyId);
  check(
    room?.owner.isEqual(ctx.sender),
    "Only the project creator can close it.",
  );
  const l = ctx.db.lobby.id.find(args.lobbyId)!;
  if (l.state === "stopped") return;
  ctx.db.lobby.id.update({ ...l, state: "stopped", endsAtUs: now(ctx) });
  emit(ctx, l.id, "lobby_stopped", l.id);
});

// Call before granting a lease. Exhaustion is terminal for this analysis job,
// so the worker does not repeatedly retry a queued job it cannot run.
export function reserveProjectLease(
  ctx: Ctx,
  lobbyId: number,
  jobId: number,
): boolean {
  if (!ctx.db.projectRoom.lobbyId.find(lobbyId)) return true;
  const lobby = ctx.db.lobby.id.find(lobbyId);
  check(
    lobby?.state === "running" && lobby.endsAtUs > now(ctx),
    "Project is closed or expired.",
  );
  const old = ctx.db.projectSettings.id.find(1);
  const day = now(ctx) / DAY_US;
  const leasesToday = old?.day === day ? old.leasesToday : 0;
  const job = ctx.db.job.id.find(jobId)!;
  if (!old?.enabled || leasesToday >= old.maxLeasesPerDay || job.calls >= 30) {
    ctx.db.job.id.update({
      ...job,
      state: "failed",
      error: "Project analysis budget exhausted or onboarding disabled.",
      updatedAtUs: now(ctx),
    });
    for (const p of agents(ctx, lobbyId))
      deliver(
        ctx,
        lobbyId,
        p.id,
        "notice",
        job.id,
        "dibs analysis is unavailable: the project or server budget is exhausted. Ask the project owner; do not assume an agreement.",
      );
    emit(ctx, lobbyId, "job_failed", jobId, { reason: "project_budget" });
    return false;
  }
  ctx.db.projectSettings.id.update({
    ...old,
    day,
    roomsToday: old.day === day ? old.roomsToday : 0,
    leasesToday: leasesToday + 1,
  });
  return true;
}

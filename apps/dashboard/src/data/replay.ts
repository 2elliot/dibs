// Replay: an EventsExport is the final state of every row. To step through a run we rebuild the
// dataset as it was at a cursor time `t`: rows appear at their creation time, and the columns
// that change over a row's life (current flags, proposal and job state, delivery stage, lobby
// state) are recomputed from the event log and the `…AtUs` columns.

import type { JobState, LobbyState, ProposalState } from "@dibs/protocol";
import { TIMING } from "@dibs/protocol";
import type {
  ContractRow,
  Dataset,
  DeliveryRow,
  EventRow,
  JobRow,
  PlanRow,
  ProposalRow,
} from "./rows.ts";

const JOB_EVENT_STATE: Record<string, JobState> = {
  job_debouncing: "debouncing",
  job_queued: "queued",
  job_leased: "leased",
  analysis_submitted: "done",
  job_failed: "failed",
};

const PROPOSAL_EVENT_STATE: Record<string, ProposalState> = {
  proposal_created: "proposed",
  proposal_accepted: "accepted",
  proposal_rejected: "rejected",
  proposal_superseded: "superseded",
  proposal_escalated: "escalated",
};

/** Every timestamp a replay can stop at, ascending and unique: event times plus row times. */
export function replayStops(d: Dataset): number[] {
  const ts = new Set<number>();
  for (const e of d.events) if (e.atUs) ts.add(e.atUs);
  for (const r of [
    ...d.plans,
    ...d.messages,
    ...d.proposals,
    ...d.responses,
    ...d.contracts,
    ...d.heads,
    ...d.verifications,
    ...d.reviews,
  ])
    if (r.createdAtUs) ts.add(r.createdAtUs);
  for (const dl of d.deliveries)
    for (const t of [
      dl.queuedAtUs,
      dl.receivedAtUs,
      dl.shownAtUs,
      dl.respondedAtUs,
    ])
      if (t) ts.add(t);
  return [...ts].sort((a, b) => a - b);
}

export function replayBounds(d: Dataset): { start: number; end: number } {
  const stops = replayStops(d);
  const candidates = [d.lobby?.createdAtUs ?? 0, stops[0] ?? 0].filter(
    (x) => x > 0,
  );
  const start = candidates.length ? Math.min(...candidates) : 0;
  const end = stops.length ? stops[stops.length - 1]! : start;
  return { start, end };
}

function eventsBySubject(
  events: EventRow[],
  types: Record<string, unknown>,
): Map<number, EventRow[]> {
  const m = new Map<number, EventRow[]>();
  for (const e of events) {
    if (!(e.type in types)) continue;
    const list = m.get(e.subjectId) ?? [];
    list.push(e);
    m.set(e.subjectId, list);
  }
  for (const list of m.values()) list.sort((a, b) => a.atUs - b.atUs || a.id - b.id);
  return m;
}

function lastAtOrBefore(list: EventRow[] | undefined, t: number) {
  if (!list) return undefined;
  let found: EventRow | undefined;
  for (const e of list) if (e.atUs <= t) found = e;
  return found;
}

function markCurrentPlans(plans: PlanRow[]): PlanRow[] {
  const latest = new Map<number, PlanRow>();
  for (const p of plans) {
    const prev = latest.get(p.participantId);
    if (!prev || p.revision > prev.revision || (p.revision === prev.revision && p.id > prev.id))
      latest.set(p.participantId, p);
  }
  return plans.map((p) => ({ ...p, current: latest.get(p.participantId) === p }));
}

/** Agreed beats aligned (rule 8); among the same source the newest wins. */
export function markCurrentContracts(contracts: ContractRow[]): ContractRow[] {
  const best = new Map<string, ContractRow>();
  for (const c of contracts) {
    const prev = best.get(c.key);
    const rank = (x: ContractRow) => (x.source === "agreed" ? 1 : 0);
    if (!prev || rank(c) > rank(prev) || (rank(c) === rank(prev) && c.id > prev.id))
      best.set(c.key, c);
  }
  return contracts.map((c) => ({ ...c, current: best.get(c.key) === c }));
}

function deliveryAt(dl: DeliveryRow, t: number): DeliveryRow {
  const reached = (at: number) => at > 0 && at <= t;
  const stage: DeliveryRow["stage"] = reached(dl.respondedAtUs)
    ? "responded"
    : reached(dl.shownAtUs)
      ? "shown"
      : reached(dl.receivedAtUs)
        ? "received"
        : "queued";
  return {
    ...dl,
    stage,
    receivedAtUs: dl.receivedAtUs <= t ? dl.receivedAtUs : 0,
    shownAtUs: dl.shownAtUs <= t ? dl.shownAtUs : 0,
    respondedAtUs: dl.respondedAtUs <= t ? dl.respondedAtUs : 0,
  };
}

function lobbyStateAt(d: Dataset, t: number): LobbyState {
  const l = d.lobby!;
  if (l.state === "setup" || !l.startedAtUs || t < l.startedAtUs) return "setup";
  const stopped = d.events.some((e) => e.type === "lobby_stopped" && e.atUs <= t);
  const verified =
    l.state === "verified" && d.verifications.some((v) => v.createdAtUs <= t);
  if (verified) return "verified";
  if (stopped || (l.endsAtUs && l.endsAtUs <= t)) return "stopped";
  return "running";
}

/** The dataset as it was at time `t` (microseconds). */
export function snapshotAt(d: Dataset, t: number): Dataset {
  const lobby = d.lobby
    ? {
        ...d.lobby,
        state: lobbyStateAt(d, t),
        analyzeAnywayFired:
          d.lobby.analyzeAnywayFired &&
          d.lobby.startedAtUs > 0 &&
          d.lobby.startedAtUs + TIMING.analyzeAnywaySec * 1e6 <= t,
      }
    : null;

  const plans = markCurrentPlans(d.plans.filter((p) => p.createdAtUs <= t));
  const planById = new Map(plans.map((p) => [p.id, p]));
  const planItems = d.planItems
    .filter((i) => planById.has(i.planId))
    .map((i) => ({ ...i, current: planById.get(i.planId)!.current }));

  const jobEvents = eventsBySubject(d.events, JOB_EVENT_STATE);
  const jobs: JobRow[] = [];
  for (const j of d.jobs) {
    const evs = jobEvents.get(j.id);
    if (!evs || evs.length === 0) {
      if (j.updatedAtUs <= t) jobs.push(j);
      continue;
    }
    const last = lastAtOrBefore(evs, t);
    if (!last) continue;
    const seen = evs.filter((e) => e.atUs <= t);
    const kindEv = [...seen].reverse().find((e) => typeof e.detail.kind === "string");
    const leases = seen.filter((e) => e.type === "job_leased").length;
    jobs.push({
      ...j,
      state: JOB_EVENT_STATE[last.type]!,
      kind: (kindEv?.detail.kind as JobRow["kind"]) ?? j.kind,
      calls: Math.min(j.calls, leases),
      attempts: Math.min(j.attempts, leases),
      updatedAtUs: last.atUs,
    });
  }

  const proposalEvents = eventsBySubject(d.events, PROPOSAL_EVENT_STATE);
  const proposals: ProposalRow[] = d.proposals
    .filter((p) => p.createdAtUs <= t)
    .map((p) => {
      const evs = proposalEvents.get(p.id);
      let state: ProposalState;
      if (evs && evs.length) {
        state = PROPOSAL_EVENT_STATE[lastAtOrBefore(evs, t)?.type ?? ""] ?? "proposed";
      } else {
        state = p.closedAtUs && p.closedAtUs <= t ? p.state : "proposed";
      }
      const open = !p.closedAtUs || p.closedAtUs > t;
      return {
        ...p,
        state,
        slot: open ? `${p.lobbyId}/${p.key}` : p.slot,
        closedAtUs: open ? 0 : p.closedAtUs,
      };
    });

  return {
    lobby,
    participants: d.participants,
    plans,
    planItems,
    messages: d.messages.filter((m) => m.createdAtUs <= t),
    jobs,
    proposals,
    responses: d.responses.filter((r) => r.createdAtUs <= t),
    contracts: markCurrentContracts(d.contracts.filter((c) => c.createdAtUs <= t)),
    deliveries: d.deliveries.filter((x) => x.queuedAtUs <= t).map((x) => deliveryAt(x, t)),
    events: d.events.filter((e) => e.atUs <= t),
    heads: d.heads.filter((h) => h.createdAtUs <= t),
    verifications: d.verifications.filter((v) => v.createdAtUs <= t),
    reviews: d.reviews.filter((r) => r.createdAtUs <= t),
    services: d.services,
  };
}

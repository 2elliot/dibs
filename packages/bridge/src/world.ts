// Lobby snapshot and the key/phase rules from docs/API.md. Pure: the bridge, the
// memory store and the SpacetimeDB adapter all compute dibs_status through here.

import type {
  ContractSource,
  Decision,
  DeliveryKind,
  DeliveryStage,
  ItemKind,
  JobKind,
  JobState,
  KeyStatus,
  LobbyState,
  MessageTarget,
  Mode,
  Phase,
  ProposalState,
  Provider,
  Relation,
  Role,
  StatusResult,
} from "@dibs/protocol";

export interface LobbyRow {
  id: number;
  mode: Mode;
  state: LobbyState;
  vocabulary: string[];
  fallbackAtUs: number;
  endsAtUs: number;
  startedAtUs: number;
  buildHash: string;
  baseSha: string;
}

export interface ParticipantRow {
  id: number;
  name: string;
  provider: Provider;
  role: Role;
  online: boolean;
  currentLobbyId: number | null;
}

export interface PlanRow {
  id: number;
  lobbyId: number;
  participantId: number;
  revision: number;
  goal: string;
  notes: string;
  requestId: string;
  current: boolean;
}

export interface ItemRow {
  id: number;
  planId: number;
  lobbyId: number;
  participantId: number;
  kind: ItemKind;
  key: string;
  text: string;
  current: boolean;
}

export interface JobRow {
  id: number;
  lobbyId: number;
  state: JobState;
  kind: JobKind;
  calls?: number;
}

export interface ProposalRow {
  id: number;
  lobbyId: number;
  key: string;
  revision: number;
  relation: Relation;
  contractText: string;
  rationale: string;
  citedItemIds: number[];
  requiredPartyIds: number[];
  state: ProposalState;
}

export interface ResponseRow {
  proposalId: number;
  revision: number;
  participantId: number;
  decision: Decision;
}

export interface ContractRow {
  id: number;
  lobbyId: number;
  key: string;
  revision: number;
  text: string;
  source: ContractSource;
  proposalId: number | null;
  current: boolean;
}

export interface MessageRow {
  id: number;
  lobbyId: number;
  fromId: number;
  to: MessageTarget;
  text: string;
  createdAtUs: number;
}

export interface DeliveryRow {
  id: number;
  lobbyId: number;
  targetId: number;
  kind: DeliveryKind;
  refId: number;
  summary: string;
  stage: DeliveryStage;
  queuedAtUs: number;
}

export interface World {
  meId: number | null;
  meName: string;
  meProvider: Provider;
  online: boolean;
  offlineSinceUs?: number;
  lobby: LobbyRow | null;
  participants: ParticipantRow[];
  plans: PlanRow[];
  items: ItemRow[];
  job: JobRow | null;
  proposals: ProposalRow[];
  responses: ResponseRow[];
  contracts: ContractRow[];
  messages: MessageRow[];
  deliveries: DeliveryRow[];
}

export interface HookStatusFile {
  project?: StatusResult["project"];
  lobbyId: number;
  online: boolean;
  offlineSinceUs?: number;
  phase: Phase;
  pendingKeys: string[];
  awaiting: { proposalId: number; revision: number; key: string }[];
  fallbackAtUs: number;
}

const MODES = new Set<Mode>(["none", "chat", "dibs"]);
const LOBBY_STATES = new Set<LobbyState>([
  "setup",
  "running",
  "stopped",
  "verified",
]);
const PROVIDERS = new Set<Provider>(["claude", "codex", "droid"]);
const ROLES = new Set<Role>(["agent", "worker", "verifier", "admin"]);
const ITEM_KINDS = new Set<ItemKind>(["produces", "requires"]);
const JOB_STATES = new Set<JobState>([
  "debouncing",
  "queued",
  "leased",
  "done",
  "failed",
]);
const JOB_KINDS = new Set<JobKind>(["analyze", "revise"]);
const RELATIONS = new Set<Relation>([
  "conflict",
  "dependency",
  "duplicate",
  "compatible",
  "unowned",
]);
const PROPOSAL_STATES = new Set<ProposalState>([
  "proposed",
  "accepted",
  "rejected",
  "superseded",
  "escalated",
]);
const DECISIONS = new Set<Decision>(["accept", "reject"]);
const SOURCES = new Set<ContractSource>(["agreed", "aligned"]);
const DELIVERY_KINDS = new Set<DeliveryKind>([
  "proposal",
  "contract",
  "aligned",
  "escalated",
  "notice",
  "message",
  "fallback",
  "debug",
]);
const STAGES = new Set<DeliveryStage>([
  "queued",
  "received",
  "shown",
  "responded",
]);
const TARGETS = new Set<MessageTarget>(["claude", "codex", "droid", "all"]);

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.trim() !== "" &&
    Number.isFinite(Number(value))
  )
    return Number(value);
  return fallback;
}

export function asOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    const tagged = value as { tag?: string; value?: unknown };
    if (tagged.tag === "none") return null;
    if (tagged.tag === "some") return asNumber(tagged.value);
  }
  return asNumber(value);
}

export function asString(value: unknown): string {
  return typeof value === "string"
    ? value
    : value === undefined || value === null
      ? ""
      : String(value);
}

export function asBool(value: unknown): boolean {
  return value === true || value === "true";
}

export function asNumberList(value: unknown): number[] {
  return Array.isArray(value) ? value.map((item) => asNumber(item)) : [];
}

export function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => asString(item)) : [];
}

/** Generated bindings use camelCase; a raw SQL row may be snake_case. */
export function field(row: Record<string, unknown>, camel: string): unknown {
  if (camel in row) return row[camel];
  const snake = camel.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
  return snake in row ? row[snake] : undefined;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: Set<T>,
  fallback: T,
): T {
  const text = asString(value);
  return allowed.has(text as T) ? (text as T) : fallback;
}

export function emptyWorld(meName: string, meProvider: Provider): World {
  return {
    meId: null,
    meName,
    meProvider,
    online: false,
    offlineSinceUs: Date.now() * 1000,
    lobby: null,
    participants: [],
    plans: [],
    items: [],
    job: null,
    proposals: [],
    responses: [],
    contracts: [],
    messages: [],
    deliveries: [],
  };
}

export interface RawTables {
  participant?: Record<string, unknown>[];
  lobby?: Record<string, unknown>[];
  plan?: Record<string, unknown>[];
  planItem?: Record<string, unknown>[];
  message?: Record<string, unknown>[];
  job?: Record<string, unknown>[];
  proposal?: Record<string, unknown>[];
  response?: Record<string, unknown>[];
  contract?: Record<string, unknown>[];
  delivery?: Record<string, unknown>[];
}

/** Turn client rows (bigint, snake_case, option wrappers) into the snapshot the tools read. */
export function normalizeWorld(
  raw: RawTables,
  meName: string,
  meProvider: Provider,
  lobbyId: number,
  online: boolean,
  offlineSinceUs?: number,
): World {
  const participants: ParticipantRow[] = (raw.participant ?? []).map((row) => ({
    id: asNumber(field(row, "id")),
    name: asString(field(row, "name")),
    provider: oneOf(field(row, "provider"), PROVIDERS, "claude"),
    role: oneOf(field(row, "role"), ROLES, "agent"),
    online: asBool(field(row, "online")),
    currentLobbyId: asOptionalNumber(field(row, "currentLobbyId")),
  }));
  const me =
    participants.find((participant) => participant.name === meName) ?? null;
  const lobbyRow = (raw.lobby ?? [])
    .map((row) => ({
      id: asNumber(field(row, "id")),
      mode: oneOf(field(row, "mode"), MODES, "dibs"),
      state: oneOf(field(row, "state"), LOBBY_STATES, "setup"),
      vocabulary: asStringList(field(row, "vocabulary")),
      fallbackAtUs: asNumber(field(row, "fallbackAtUs")),
      endsAtUs: asNumber(field(row, "endsAtUs")),
      startedAtUs: asNumber(field(row, "startedAtUs")),
      buildHash: asString(field(row, "buildHash")),
      baseSha: asString(field(row, "baseSha")),
    }))
    .find((lobby) => lobby.id === lobbyId);
  const inLobby = (id: number) => id === lobbyId;
  return {
    meId: me?.id ?? null,
    meName,
    meProvider,
    online,
    offlineSinceUs: online ? undefined : offlineSinceUs,
    lobby: lobbyRow ?? null,
    participants,
    plans: (raw.plan ?? [])
      .map((row) => ({
        id: asNumber(field(row, "id")),
        lobbyId: asNumber(field(row, "lobbyId")),
        participantId: asNumber(field(row, "participantId")),
        revision: asNumber(field(row, "revision")),
        goal: asString(field(row, "goal")),
        notes: asString(field(row, "notes")),
        requestId: asString(field(row, "requestId")),
        current: asBool(field(row, "current")),
      }))
      .filter((row) => inLobby(row.lobbyId)),
    items: (raw.planItem ?? [])
      .map((row) => ({
        id: asNumber(field(row, "id")),
        planId: asNumber(field(row, "planId")),
        lobbyId: asNumber(field(row, "lobbyId")),
        participantId: asNumber(field(row, "participantId")),
        kind: oneOf(field(row, "kind"), ITEM_KINDS, "produces"),
        key: asString(field(row, "key")),
        text: asString(field(row, "text")),
        current: asBool(field(row, "current")),
      }))
      .filter((row) => inLobby(row.lobbyId)),
    job:
      (raw.job ?? [])
        .map((row) => ({
          id: asNumber(field(row, "id")),
          lobbyId: asNumber(field(row, "lobbyId")),
          state: oneOf(field(row, "state"), JOB_STATES, "done"),
          kind: oneOf(field(row, "kind"), JOB_KINDS, "analyze"),
          calls: asNumber(field(row, "calls")),
        }))
        .filter((row) => inLobby(row.lobbyId))
        .sort((a, b) => b.id - a.id)[0] ?? null,
    proposals: (raw.proposal ?? [])
      .map((row) => ({
        id: asNumber(field(row, "id")),
        lobbyId: asNumber(field(row, "lobbyId")),
        key: asString(field(row, "key")),
        revision: asNumber(field(row, "revision")),
        relation: oneOf(field(row, "relation"), RELATIONS, "conflict"),
        contractText: asString(field(row, "contractText")),
        rationale: asString(field(row, "rationale")),
        citedItemIds: asNumberList(field(row, "citedItemIds")),
        requiredPartyIds: asNumberList(field(row, "requiredPartyIds")),
        state: oneOf(field(row, "state"), PROPOSAL_STATES, "proposed"),
      }))
      .filter((row) => inLobby(row.lobbyId)),
    responses: (raw.response ?? [])
      .filter((row) => asNumber(field(row, "lobbyId")) === lobbyId)
      .map((row) => ({
        proposalId: asNumber(field(row, "proposalId")),
        revision: asNumber(field(row, "revision")),
        participantId: asNumber(field(row, "participantId")),
        decision: oneOf(field(row, "decision"), DECISIONS, "accept"),
      })),
    contracts: (raw.contract ?? [])
      .map((row) => ({
        id: asNumber(field(row, "id")),
        lobbyId: asNumber(field(row, "lobbyId")),
        key: asString(field(row, "key")),
        revision: asNumber(field(row, "revision")),
        text: asString(field(row, "text")),
        source: oneOf(field(row, "source"), SOURCES, "agreed"),
        proposalId: asOptionalNumber(field(row, "proposalId")),
        current: asBool(field(row, "current")),
      }))
      .filter((row) => inLobby(row.lobbyId)),
    messages: (raw.message ?? [])
      .map((row) => ({
        id: asNumber(field(row, "id")),
        lobbyId: asNumber(field(row, "lobbyId")),
        fromId: asNumber(field(row, "fromId")),
        to: oneOf(field(row, "to"), TARGETS, "all"),
        text: asString(field(row, "text")),
        createdAtUs: asNumber(field(row, "createdAtUs")),
      }))
      .filter((row) => inLobby(row.lobbyId)),
    deliveries: (raw.delivery ?? [])
      .map((row) => ({
        id: asNumber(field(row, "id")),
        lobbyId: asNumber(field(row, "lobbyId")),
        targetId: asNumber(field(row, "targetId")),
        kind: oneOf(field(row, "kind"), DELIVERY_KINDS, "notice"),
        refId: asNumber(field(row, "refId")),
        summary: asString(field(row, "summary")),
        stage: oneOf(field(row, "stage"), STAGES, "queued"),
        queuedAtUs: asNumber(field(row, "queuedAtUs")),
      }))
      .filter((row) => (me ? row.targetId === me.id : false)),
  };
}

export function phaseOf(job: { state: JobState } | null): Phase {
  if (!job) return "ready";
  if (job.state === "debouncing") return "waiting_for_peers";
  if (job.state === "queued" || job.state === "leased") return "analyzing";
  return "ready";
}

export function fallbackInSec(fallbackAtUs: number, nowUs: number): number {
  if (!fallbackAtUs || fallbackAtUs <= 0) return 0;
  return Math.max(0, Math.ceil((fallbackAtUs - nowUs) / 1e6));
}

function latest<T extends { id: number }>(rows: T[]): T | undefined {
  return rows.reduce<T | undefined>(
    (best, row) => (!best || row.id > best.id ? row : best),
    undefined,
  );
}

/** Key status for dibs_status. While the phase is not ready, every touched key is pending. */
export function keyStatus(
  phase: Phase,
  contract: ContractRow | undefined,
  open: ProposalRow | undefined,
  escalated: ProposalRow | undefined,
): KeyStatus {
  if (phase !== "ready") return "pending";
  if (contract?.source === "agreed") return "agreed";
  if (contract?.source === "aligned") return "aligned";
  if (open) return "proposed";
  if (escalated) return "escalated";
  return "clear";
}

export function computeStatus(
  world: World,
  seenMessageIds: readonly number[],
  nowUs: number,
): StatusResult {
  const lobby = world.lobby;
  const phase = phaseOf(world.job);
  const myItems = world.items.filter(
    (item) => item.current && item.participantId === world.meId,
  );
  const keys = [...new Set(myItems.map((item) => item.key))];
  const order = new Map(
    (lobby?.vocabulary ?? []).map((key, index) => [key, index]),
  );
  keys.sort(
    (a, b) =>
      (order.get(a) ?? 1000) - (order.get(b) ?? 1000) || a.localeCompare(b),
  );

  const keyEntries = keys.map((key) => {
    const contract = world.contracts.find(
      (row) => row.current && row.key === key,
    );
    const open = latest(
      world.proposals.filter(
        (row) => row.key === key && row.state === "proposed",
      ),
    );
    const escalated = latest(
      world.proposals.filter(
        (row) => row.key === key && row.state === "escalated",
      ),
    );
    const status = keyStatus(phase, contract, open, escalated);
    const entry: StatusResult["keys"][number] = { key, status };
    if (status === "agreed" || status === "aligned") {
      if (contract) {
        entry.contractText = contract.text;
        entry.revision = contract.revision;
        if (contract.proposalId !== null)
          entry.proposalId = contract.proposalId;
      }
    } else if (status === "proposed" && open) {
      entry.proposalId = open.id;
      entry.revision = open.revision;
      entry.contractText = open.contractText;
    } else if (status === "escalated" && escalated) {
      entry.proposalId = escalated.id;
      entry.revision = escalated.revision;
      entry.contractText = escalated.contractText;
    }
    return entry;
  });

  const seen = new Set(seenMessageIds);
  const awaitingYou = world.proposals
    .filter(
      (proposal) =>
        proposal.state === "proposed" &&
        world.meId !== null &&
        proposal.requiredPartyIds.includes(world.meId),
    )
    .filter(
      (proposal) =>
        !world.responses.some(
          (response) =>
            response.proposalId === proposal.id &&
            response.revision === proposal.revision &&
            response.participantId === world.meId,
        ),
    )
    .sort((a, b) => a.id - b.id)
    .map((proposal) => ({
      proposalId: proposal.id,
      key: proposal.key,
      revision: proposal.revision,
      relation: proposal.relation,
      contractText: proposal.contractText,
      rationale: proposal.rationale,
      basis: proposal.citedItemIds.flatMap((id) => {
        const item = world.items.find((candidate) => candidate.id === id);
        if (!item) return [];
        const author = world.participants.find(
          (participant) => participant.id === item.participantId,
        );
        return [
          {
            participant: author?.name ?? String(item.participantId),
            provider: author?.provider ?? world.meProvider,
            kind: item.kind,
            text: item.text,
          },
        ];
      }),
    }));

  const messages = world.messages
    .filter((message) => message.fromId !== world.meId && !seen.has(message.id))
    .filter(
      (message) => message.to === "all" || message.to === world.meProvider,
    )
    .sort((a, b) => a.id - b.id)
    .map((message) => ({
      from:
        world.participants.find(
          (participant) => participant.id === message.fromId,
        )?.name ?? String(message.fromId),
      text: message.text,
      atUs: message.createdAtUs,
    }));

  const roster = lobby
    ? world.participants
        .filter(
          (participant) =>
            participant.role === "agent" &&
            participant.currentLobbyId === lobby.id,
        )
        .map((participant) => ({
          name: participant.name,
          provider: participant.provider,
          online: participant.online,
          hasPlan: world.plans.some(
            (plan) =>
              plan.current &&
              plan.participantId === participant.id &&
              plan.lobbyId === lobby.id,
          ),
        }))
    : [];

  return {
    status: world.online ? "ok" : "offline",
    ...(lobby?.buildHash === "project-v1"
      ? {
          project: {
            expiresAtUs: lobby.endsAtUs,
            remainingLeases: Math.max(0, 30 - (world.job?.calls ?? 0)),
            ...(lobby.state !== "running" || lobby.endsAtUs <= nowUs
              ? { unavailable: "Project is closed or expired." }
              : world.job?.state === "failed"
                ? {
                    unavailable:
                      "Analysis failed or its usage budget is exhausted. Read the delivered notice; no agreement is implied.",
                  }
                : {}),
          },
        }
      : {}),
    lobbyId: lobby?.id ?? 0,
    mode: lobby?.mode ?? "none",
    phase,
    keys: keyEntries,
    awaitingYou,
    messages,
    fallbackInSec: fallbackInSec(lobby?.fallbackAtUs ?? 0, nowUs),
    roster,
  };
}

export function toHookStatus(
  world: World,
  status: StatusResult,
): HookStatusFile {
  return {
    lobbyId: world.lobby?.id ?? status.lobbyId,
    online: world.online,
    ...(world.online
      ? {}
      : { offlineSinceUs: world.offlineSinceUs ?? Date.now() * 1000 }),
    phase: status.phase,
    ...(status.project ? { project: status.project } : {}),
    pendingKeys: status.keys
      .filter((key) => key.status === "pending")
      .map((key) => key.key),
    awaiting: status.awaitingYou.map((proposal) => ({
      proposalId: proposal.proposalId,
      revision: proposal.revision,
      key: proposal.key,
    })),
    fallbackAtUs: world.lobby?.fallbackAtUs ?? 0,
  };
}

/** Changes that should wake a long-poll. The countdown itself ticks every second and is not one of them. */
export function statusFingerprint(status: StatusResult): string {
  const { fallbackInSec: remaining, ...rest } = status;
  return JSON.stringify({ ...rest, fallbackReached: remaining === 0 });
}

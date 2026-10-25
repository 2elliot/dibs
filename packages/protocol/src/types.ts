// Protocol v1: the shapes that cross issue boundaries. Table rows themselves come from the
// generated bindings (packages/bindings); this file pins the enums, limits, JSON payloads and
// local file formats around them. docs/API.md is the prose contract for the module.
//
// Frozen. Don't edit this in a feature branch. If you need a change, say so in your PR and
// code against a local extension type until the owner of issue 1 merges it.
//
// Browser-safe: no Node imports, because the dashboard uses it too.

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Enums. The module stores these as plain strings; reducers reject anything not listed.

export const PROVIDERS = ["claude", "codex", "droid"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const ROLES = ["agent", "worker", "verifier", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const MODES = ["none", "chat", "dibs"] as const;
export type Mode = (typeof MODES)[number];

export const LOBBY_STATES = [
  "setup",
  "running",
  "stopped",
  "verified",
] as const;
export type LobbyState = (typeof LOBBY_STATES)[number];

export const ITEM_KINDS = ["produces", "requires"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const JOB_KINDS = ["analyze", "revise"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATES = [
  "debouncing",
  "queued",
  "leased",
  "done",
  "failed",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const RELATIONS = [
  "conflict",
  "dependency",
  "duplicate",
  "compatible",
  "unowned",
] as const;
export type Relation = (typeof RELATIONS)[number];

export const PROPOSAL_STATES = [
  "proposed",
  "accepted",
  "rejected",
  "superseded",
  "escalated",
] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

export const DECISIONS = ["accept", "reject"] as const;
export type Decision = (typeof DECISIONS)[number];

export const CONTRACT_SOURCES = ["agreed", "aligned"] as const;
export type ContractSource = (typeof CONTRACT_SOURCES)[number];

export const DELIVERY_KINDS = [
  "proposal",
  "contract",
  "aligned",
  "escalated",
  "notice",
  "message",
  "fallback",
  "debug",
] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

/** Forward-only. Times live in the matching `…AtUs` columns (0 = not reached). */
export const DELIVERY_STAGES = [
  "queued",
  "received",
  "shown",
  "responded",
] as const;
export type DeliveryStage = (typeof DELIVERY_STAGES)[number];

export const KEY_STATUSES = [
  "pending",
  "clear",
  "proposed",
  "agreed",
  "aligned",
  "escalated",
] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];

export const PHASES = ["waiting_for_peers", "analyzing", "ready"] as const;
export type Phase = (typeof PHASES)[number];

export const LOBBY_TIMER_ACTIONS = [
  "analyze_anyway",
  "fallback",
  "stop",
] as const;
export type LobbyTimerAction = (typeof LOBBY_TIMER_ACTIONS)[number];

export const REVIEW_KINDS = ["conformance", "diagnosis"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const MESSAGE_TARGETS = ["claude", "codex", "droid", "all"] as const;
export type MessageTarget = (typeof MESSAGE_TARGETS)[number];

/** `event.type` values. `event.detail` is a small JSON object; never codes, tokens or prompts. */
export const EVENT_TYPES = [
  "invite_created",
  "invite_claimed",
  "lobby_created",
  "lobby_started",
  "lobby_stopped",
  "joined_lobby",
  "plan_published",
  "message_sent",
  "job_debouncing",
  "job_queued",
  "job_leased",
  "job_failed",
  "analysis_submitted",
  "proposal_created",
  "proposal_superseded",
  "response_recorded",
  "proposal_accepted",
  "proposal_rejected",
  "proposal_escalated",
  "contract_agreed",
  "contract_aligned",
  "notice_sent",
  "fallback_reached",
  "delivery_stage",
  "head_reported",
  "verification_recorded",
  "review_recorded",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// ---------------------------------------------------------------------------------------------
// Limits and timing. Reducers enforce the limits; the timing values are the defaults
// `start_lobby` uses (tune from dry runs by changing them here, in one place).

export const LIMITS = {
  planItems: 6,
  textChars: 500,
  goalChars: 500,
  notesChars: 1000,
  messageChars: 1000,
  statusWaitSecMax: 45,
  hookContextChars: 1500,
  stopBlocksMax: 8,
  requestPayloadBytes: 4096,
  analysisCallsPerLobby: 30,
} as const;

export const TIMING = {
  debounceSec: 5,
  analyzeAnywaySec: 120,
  fallbackSec: 360,
  endSec: 900,
  leaseSec: 60,
  leaseRescanSec: 15,
  analysisTimeoutSec: 90,
  bridgeCallTimeoutSec: 5,
  claimedSweepSec: 60,
  hookAliveTimeoutSec: 30,
} as const;

// ---------------------------------------------------------------------------------------------
// Fixture manifest: fixture/dibs.json. One source for the key vocabulary and each provider's
// area, read by `create_lobby` (vocabulary), `dibs session` (out-of-area count) and
// `dibs verify` (assembly by area).

export interface VocabularyEntry {
  key: string;
  description: string;
}

export interface FixtureManifest {
  vocabulary: VocabularyEntry[];
  /** Globs relative to the fixture root, forward slashes. */
  areas: Record<Provider, string[]>;
  /** Files nobody edits. */
  frozen: string[];
}

// ---------------------------------------------------------------------------------------------
// Analysis: what the worker sends Claude and what it passes to `submit_analysis(findingsJson)`.

export interface AnalysisItem {
  id: number;
  planId: number;
  planRevision: number;
  participantId: number;
  participant: string;
  provider: Provider;
  kind: ItemKind;
  key: string;
  text: string;
}

export interface AnalysisContract {
  id: number;
  key: string;
  revision: number;
  text: string;
  source: ContractSource;
  /** plan_item ids the contract was agreed on. A finding on this key is ignored unless it cites an item that is not in this list. */
  basisItemIds: number[];
}

export interface AnalysisOpenProposal {
  id: number;
  key: string;
  revision: number;
  contractText: string;
  citedItemIds: number[];
  requiredPartyIds: number[];
}

export interface AnalysisRejection {
  proposalId: number;
  key: string;
  revision: number;
  participant: string;
  reason: string;
}

export interface AnalysisInput {
  lobbyId: number;
  jobId: number;
  jobKind: JobKind;
  inputKey: string;
  charter: string;
  vocabulary: VocabularyEntry[];
  /** Current revision of every participant's plan. */
  items: AnalysisItem[];
  contracts: AnalysisContract[];
  openProposals: AnalysisOpenProposal[];
  /** For `revise` jobs: the rejection being answered. */
  rejections: AnalysisRejection[];
}

export interface Finding {
  key: string;
  relation: Relation;
  /** plan_item ids; must exist in the lobby's current items. */
  citedItemIds: number[];
  explanation: string;
  /** Required for conflict, dependency and duplicate; the agreed text for compatible; "" for unowned. Concrete enough to code against. */
  contractText: string;
}

export interface Findings {
  findings: Finding[];
}

// ---------------------------------------------------------------------------------------------
// Local files. Everything lives under DIBS_HOME (default ~/.dibs), one folder per participant so
// two sessions on one machine never share an inbox or a lock:
//
//   <DIBS_HOME>/config.json                     DibsConfig
//   <DIBS_HOME>/<participant>/token             SpacetimeDB token, never in a repo
//   <DIBS_HOME>/<participant>/session.json      SessionFile, written by `dibs session prep`
//   <DIBS_HOME>/<participant>/inbox/<deliveryId>.json     InboxItem, written by the bridge (temp + rename)
//   <DIBS_HOME>/<participant>/claimed/<deliveryId>.json   the hook claims by atomic rename, then touches mtime
//   <DIBS_HOME>/<participant>/shown/<deliveryId>.json     moved here after a successful print
//   <DIBS_HOME>/<participant>/bridge.lock       BridgeLock
//   <DIBS_HOME>/<participant>/stopblocks.json   StopBlocks
//   <DIBS_HOME>/<participant>/hook-alive.json   HookAlive, written by the SessionStart hook

export const DIBS_HOME_ENV = "DIBS_HOME";
export const DIBS_FILES = {
  config: "config.json",
  token: "token",
  session: "session.json",
  inbox: "inbox",
  claimed: "claimed",
  shown: "shown",
  bridgeLock: "bridge.lock",
  stopBlocks: "stopblocks.json",
  hookAlive: "hook-alive.json",
} as const;

export interface DibsConfig {
  /** e.g. http://127.0.0.1:3000 or https://maincloud.spacetimedb.com */
  dbUri: string;
  dbName: string;
}

export interface SessionFile {
  /** Ordinary attachment: no benchmark runner or Git lifecycle. */
  project?: boolean;
  remoteParticipant?: string;
  brief?: string;
  vocabulary?: VocabularyEntry[];
  participant: string;
  provider: Provider;
  lobbyId: number;
  mode: Mode;
  /** Absolute path; hooks exit silently when their cwd is outside it. */
  clonePath: string;
  baseSha: string;
  startedAtUs: number;
  fallbackAtUs: number;
  endsAtUs: number;
}

export interface InboxItem {
  deliveryId: number;
  lobbyId: number;
  kind: DeliveryKind;
  refId: number;
  /** Facts, not commands. At most LIMITS.hookContextChars. */
  summary: string;
  queuedAtUs: number;
}

export interface BridgeLock {
  pid: number;
  participant: string;
  startedAtUs: number;
}

export interface StopBlocks {
  lobbyId: number;
  count: number;
  /** Proposal ids the Stop hook has already blocked for. */
  proposalIds: number[];
}

export interface HookAlive {
  lobbyId: number;
  provider: Provider;
  /** The provider's own session id from the hook input. */
  sessionId: string;
  atUs: number;
}

// ---------------------------------------------------------------------------------------------
// Agent tools (MCP). Names are fixed; descriptions live in the bridge.

export const TOOL_NAMES = {
  plan: "dibs_plan",
  status: "dibs_status",
  respond: "dibs_respond",
  message: "dibs_message",
} as const;

export const TOOLS_BY_MODE: Record<
  Mode,
  (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES][]
> = {
  none: ["dibs_plan"],
  chat: ["dibs_plan", "dibs_status", "dibs_message"],
  dibs: ["dibs_plan", "dibs_status", "dibs_respond", "dibs_message"],
};

export interface PlanInput {
  goal: string;
  produces: { key: string; statement: string }[];
  requires: { key: string; assumption: string }[];
  notes?: string;
}

/** Every tool result carries a status so agents can tell committed results from pending ones. */
export type ToolStatus = "ok" | "pending" | "offline" | "error";

export interface KeyStatusEntry {
  key: string;
  status: KeyStatus;
  proposalId?: number;
  revision?: number;
  contractText?: string;
}

export interface AwaitingProposal {
  proposalId: number;
  key: string;
  revision: number;
  relation: Relation;
  contractText: string;
  rationale: string;
  basis: {
    participant: string;
    provider: Provider;
    kind: ItemKind;
    text: string;
  }[];
}

export interface StatusResult {
  /** Present for ordinary project sessions; no implication of a verified test. */
  project?: {
    expiresAtUs: number;
    remainingLeases: number;
    unavailable?: string;
  };
  status: ToolStatus;
  lobbyId: number;
  mode: Mode;
  phase: Phase;
  keys: KeyStatusEntry[];
  awaitingYou: AwaitingProposal[];
  messages: { from: string; text: string; atUs: number }[];
  /** Seconds until the lobby's fallbackAtUs; 0 once reached. */
  fallbackInSec: number;
  roster: {
    name: string;
    provider: Provider;
    online: boolean;
    hasPlan: boolean;
  }[];
}

// ---------------------------------------------------------------------------------------------
// Verification and review.

/** `verification.assembledFrom` (JSON): provider → the lobby head SHA its area was taken from. */
export type AssembledFrom = Partial<Record<Provider, string>>;

export interface ReviewEvidence {
  file: string;
  line: number;
  note: string;
}

export interface ReviewClause {
  /** The contract (or charter interface) clause, quoted or paraphrased. */
  clause: string;
  key: string;
  verdict: "conforms" | "violates" | "not_applicable";
  evidence: ReviewEvidence[];
}

/** `review.findings` (JSON). Advisory: never changes `verification.passed`. */
export interface ReviewFindings {
  summary: string;
  clauses: ReviewClause[];
  rootCause: {
    key: string;
    violator: Provider | "unknown";
    explanation: string;
  } | null;
}

// ---------------------------------------------------------------------------------------------
// Events export: `dibs export <lobbyId>` writes it, the dashboard replays it offline.
// Rows use the generated bindings' field names (camelCase). Convert u64/bigint to number,
// Identity to its hex string, and Option to value | null, so JSON.stringify never throws.

export const EXPORTED_TABLES = [
  "lobby",
  "participant",
  "plan",
  "plan_item",
  "message",
  "job",
  "proposal",
  "response",
  "contract",
  "delivery",
  "event",
  "head",
  "verification",
  "review",
  "service",
] as const;
export type ExportedTable = (typeof EXPORTED_TABLES)[number];

export interface EventsExport {
  protocolVersion: typeof PROTOCOL_VERSION;
  /** Shown as a REPLAY label, e.g. "S2 / dibs / trial 1". */
  label: string;
  lobbyId: number;
  exportedAtUs: number;
  tables: Record<ExportedTable, Record<string, unknown>[]>;
}

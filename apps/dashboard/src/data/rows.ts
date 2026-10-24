// Plain rows for every table the dashboard reads, in the shape `dibs export` writes them
// (EventsExport): the generated bindings' camelCase field names, u64 → number, Identity → hex
// string, Option → value | null. Live mode converts binding rows into the same shapes, so every
// panel reads one interface whichever source is behind it. Columns follow docs/API.md.

import type {
  ContractSource,
  Decision,
  DeliveryKind,
  DeliveryStage,
  ItemKind,
  JobKind,
  JobState,
  LobbyState,
  Mode,
  Provider,
  ProposalState,
  Relation,
  ReviewKind,
  Role,
} from "@dibs/protocol";

export interface LobbyRow {
  id: number;
  scenario: string;
  mode: Mode;
  baseSha: string;
  vocabulary: string[];
  vocabularyJson: string;
  charter: string;
  buildHash: string;
  state: LobbyState;
  analyzeAnywayFired: boolean;
  createdAtUs: number;
  startedAtUs: number;
  fallbackAtUs: number;
  endsAtUs: number;
}

export interface ParticipantRow {
  id: number;
  identity: string;
  name: string;
  provider: Provider;
  role: Role;
  online: boolean;
  buildHash: string;
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
  createdAtUs: number;
}

export interface PlanItemRow {
  id: number;
  planId: number;
  lobbyId: number;
  participantId: number;
  kind: ItemKind;
  key: string;
  text: string;
  current: boolean;
}

export interface MessageRow {
  id: number;
  lobbyId: number;
  fromId: number;
  to: string;
  text: string;
  requestId: string;
  createdAtUs: number;
}

export interface JobRow {
  id: number;
  slot: string;
  lobbyId: number;
  kind: JobKind;
  state: JobState;
  inputKey: string;
  leaseToken: string;
  leaseExpiresUs: number;
  attempts: number;
  calls: number;
  error: string;
  updatedAtUs: number;
}

export interface ProposalRow {
  id: number;
  slot: string;
  lobbyId: number;
  key: string;
  revision: number;
  relation: Relation;
  contractText: string;
  rationale: string;
  citedItemIds: number[];
  requiredPartyIds: number[];
  state: ProposalState;
  inputKey: string;
  createdAtUs: number;
  closedAtUs: number;
}

export interface ResponseRow {
  id: number;
  lobbyId: number;
  proposalId: number;
  revision: number;
  participantId: number;
  decision: Decision;
  reason: string;
  requestId: string;
  createdAtUs: number;
}

export interface ContractRow {
  id: number;
  lobbyId: number;
  key: string;
  revision: number;
  text: string;
  source: ContractSource;
  proposalId: number | null;
  basisItemIds: number[];
  current: boolean;
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
  receivedAtUs: number;
  shownAtUs: number;
  respondedAtUs: number;
}

export interface EventRow {
  id: number;
  lobbyId: number;
  atUs: number;
  actor: string;
  type: string;
  subjectId: number;
  /** Parsed `detail` JSON; `{}` when it isn't an object. */
  detail: Record<string, unknown>;
}

export interface HeadRow {
  id: number;
  lobbyId: number;
  participantId: number;
  sha: string;
  outOfAreaFiles: string[];
  createdAtUs: number;
}

export interface VerificationRow {
  id: number;
  lobbyId: number;
  /** Parsed `AssembledFrom` JSON: provider → head SHA. */
  assembledFrom: Record<string, string>;
  treeHash: string;
  mergeTreeClean: boolean;
  oracleHash: string;
  exitCode: number;
  passed: number;
  total: number;
  reportHash: string;
  verifierId: number;
  createdAtUs: number;
}

export interface ReviewRow {
  id: number;
  lobbyId: number;
  verificationId: number;
  kind: ReviewKind;
  summary: string;
  /** Raw `findings` JSON string; parse with `parseReviewFindings`. */
  findings: string;
  model: string;
  sessionId: string;
  createdAtUs: number;
}

export interface ServiceRow {
  name: string;
  lastBeatUs: number;
  detail: Record<string, unknown>;
}

/** Everything the panels read, already scoped to one lobby (participants and services are global). */
export interface Dataset {
  lobby: LobbyRow | null;
  participants: ParticipantRow[];
  plans: PlanRow[];
  planItems: PlanItemRow[];
  messages: MessageRow[];
  jobs: JobRow[];
  proposals: ProposalRow[];
  responses: ResponseRow[];
  contracts: ContractRow[];
  deliveries: DeliveryRow[];
  events: EventRow[];
  heads: HeadRow[];
  verifications: VerificationRow[];
  reviews: ReviewRow[];
  services: ServiceRow[];
}

export const EMPTY_DATASET: Dataset = {
  lobby: null,
  participants: [],
  plans: [],
  planItems: [],
  messages: [],
  jobs: [],
  proposals: [],
  responses: [],
  contracts: [],
  deliveries: [],
  events: [],
  heads: [],
  verifications: [],
  reviews: [],
  services: [],
};

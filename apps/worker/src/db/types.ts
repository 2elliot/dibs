// What the worker reads from and calls on the dibs module (docs/API.md). Rows are plain JSON
// shapes: u64 times are numbers (µs), options are `T | null`. The SpacetimeDB adapter converts
// generated binding rows into these; the in-memory module used by tests produces them directly.

import type {
  ContractSource,
  Decision,
  ItemKind,
  JobKind,
  JobState,
  LobbyState,
  Mode,
  ProposalState,
  Provider,
  Relation,
  Role,
} from "@dibs/protocol";

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

export interface LobbyRow {
  id: number;
  scenario: string;
  mode: Mode;
  baseSha: string;
  vocabulary: string[];
  /** `VocabularyEntry[]` as JSON. */
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

/** Read access to the subscribed rows. Everything is a synchronous read of the local cache. */
export interface WorkerTables {
  jobs(): JobRow[];
  job(id: number): JobRow | undefined;
  lobby(id: number): LobbyRow | undefined;
  participants(): ParticipantRow[];
  plans(lobbyId: number): PlanRow[];
  planItems(lobbyId: number): PlanItemRow[];
  contracts(lobbyId: number): ContractRow[];
  proposals(lobbyId: number): ProposalRow[];
  responses(lobbyId: number): ResponseRow[];
}

/**
 * The worker's view of the module: subscribed tables, a job-change feed and the four worker
 * reducers. Reducer calls resolve once the module commits and reject with the `SenderError`
 * text otherwise; the committed rows then show up in the tables.
 */
export interface WorkerDb extends WorkerTables {
  /** True while the connection is up and the initial subscription has applied. */
  readonly connected: boolean;
  /** Called after any job row is inserted or updated. Returns an unsubscribe function. */
  onJob(listener: (job: JobRow) => void): () => void;
  leaseJob(jobId: number, leaseToken: string): Promise<void>;
  submitAnalysis(jobId: number, leaseToken: string, inputKey: string, findingsJson: string): Promise<void>;
  failJob(jobId: number, leaseToken: string, error: string): Promise<void>;
  heartbeat(name: string, detailJson: string): Promise<void>;
  close(): void;
}

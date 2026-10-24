// Turns loosely typed records (an EventsExport file, or rows from the live SpacetimeDB client)
// into the plain rows in rows.ts. Defensive on purpose: a missing column becomes a neutral
// default instead of a crash, because a judge-facing screen must keep rendering.

import {
  EXPORTED_TABLES,
  PROTOCOL_VERSION,
  type EventsExport,
  type ExportedTable,
  type Provider,
  type ReviewFindings,
} from "@dibs/protocol";
import type {
  ContractRow,
  Dataset,
  DeliveryRow,
  EventRow,
  HeadRow,
  JobRow,
  LobbyRow,
  MessageRow,
  ParticipantRow,
  PlanItemRow,
  PlanRow,
  ProposalRow,
  ResponseRow,
  ReviewRow,
  ServiceRow,
  VerificationRow,
} from "./rows.ts";

type Raw = Record<string, unknown>;

export function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (v && typeof v === "object") {
    // SpacetimeDB Timestamp-like values.
    const o = v as Record<string, unknown>;
    if ("microsSinceUnixEpoch" in o) return num(o.microsSinceUnixEpoch);
    if ("__timestamp_micros_since_unix_epoch__" in o)
      return num(o.__timestamp_micros_since_unix_epoch__);
  }
  return 0;
}

export function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean")
    return String(v);
  const o = v as { toHexString?: () => string };
  if (typeof o.toHexString === "function") return o.toHexString();
  return "";
}

export function bool(v: unknown): boolean {
  return v === true || v === "true" || v === 1;
}

/** Option<T> as exported (value | null), as the TS SDK gives it (value | undefined), or tagged. */
export function opt<T>(v: unknown, f: (x: unknown) => T): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if ("none" in o && Object.keys(o).length === 1) return null;
    if ("some" in o && Object.keys(o).length === 1) return f(o.some);
    if (o.tag === "none") return null;
    if (o.tag === "some") return f(o.value);
  }
  return f(v);
}

export function numArr(v: unknown): number[] {
  if (typeof v === "string") v = parseJson(v);
  return Array.isArray(v) ? v.map(num) : [];
}

export function strArr(v: unknown): string[] {
  if (typeof v === "string") v = parseJson(v);
  return Array.isArray(v) ? v.map(str) : [];
}

export function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

export function jsonObject(v: unknown): Record<string, unknown> {
  const parsed = parseJson(v);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------------------------

export function lobbyRow(r: Raw): LobbyRow {
  return {
    id: num(r.id),
    scenario: str(r.scenario),
    mode: str(r.mode) as LobbyRow["mode"],
    baseSha: str(r.baseSha),
    vocabulary: strArr(r.vocabulary),
    vocabularyJson: str(r.vocabularyJson),
    charter: str(r.charter),
    buildHash: str(r.buildHash),
    state: str(r.state) as LobbyRow["state"],
    analyzeAnywayFired: bool(r.analyzeAnywayFired),
    createdAtUs: num(r.createdAtUs),
    startedAtUs: num(r.startedAtUs),
    fallbackAtUs: num(r.fallbackAtUs),
    endsAtUs: num(r.endsAtUs),
  };
}

export function participantRow(r: Raw): ParticipantRow {
  return {
    id: num(r.id),
    identity: str(r.identity),
    name: str(r.name),
    provider: str(r.provider) as ParticipantRow["provider"],
    role: str(r.role) as ParticipantRow["role"],
    online: bool(r.online),
    buildHash: str(r.buildHash),
    currentLobbyId: opt(r.currentLobbyId, num),
  };
}

export function planRow(r: Raw): PlanRow {
  return {
    id: num(r.id),
    lobbyId: num(r.lobbyId),
    participantId: num(r.participantId),
    revision: num(r.revision),
    goal: str(r.goal),
    notes: str(r.notes),
    requestId: str(r.requestId),
    current: bool(r.current),
    createdAtUs: num(r.createdAtUs),
  };
}

export function planItemRow(r: Raw): PlanItemRow {
  return {
    id: num(r.id),
    planId: num(r.planId),
    lobbyId: num(r.lobbyId),
    participantId: num(r.participantId),
    kind: str(r.kind) as PlanItemRow["kind"],
    key: str(r.key),
    text: str(r.text),
    current: bool(r.current),
  };
}

export function messageRow(r: Raw): MessageRow {
  return {
    id: num(r.id),
    lobbyId: num(r.lobbyId),
    fromId: num(r.fromId),
    to: str(r.to),
    text: str(r.text),
    requestId: str(r.requestId),
    createdAtUs: num(r.createdAtUs),
  };
}

export function jobRow(r: Raw): JobRow {
  return {
    id: num(r.id),
    slot: str(r.slot),
    lobbyId: num(r.lobbyId),
    kind: str(r.kind) as JobRow["kind"],
    state: str(r.state) as JobRow["state"],
    inputKey: str(r.inputKey),
    leaseToken: str(r.leaseToken),
    leaseExpiresUs: num(r.leaseExpiresUs),
    attempts: num(r.attempts),
    calls: num(r.calls),
    error: str(r.error),
    updatedAtUs: num(r.updatedAtUs),
  };
}

export function proposalRow(r: Raw): ProposalRow {
  return {
    id: num(r.id),
    slot: str(r.slot),
    lobbyId: num(r.lobbyId),
    key: str(r.key),
    revision: num(r.revision),
    relation: str(r.relation) as ProposalRow["relation"],
    contractText: str(r.contractText),
    rationale: str(r.rationale),
    citedItemIds: numArr(r.citedItemIds),
    requiredPartyIds: numArr(r.requiredPartyIds),
    state: str(r.state) as ProposalRow["state"],
    inputKey: str(r.inputKey),
    createdAtUs: num(r.createdAtUs),
    closedAtUs: num(r.closedAtUs),
  };
}

export function responseRow(r: Raw): ResponseRow {
  return {
    id: num(r.id),
    lobbyId: num(r.lobbyId),
    proposalId: num(r.proposalId),
    revision: num(r.revision),
    participantId: num(r.participantId),
    decision: str(r.decision) as ResponseRow["decision"],
    reason: str(r.reason),
    requestId: str(r.requestId),
    createdAtUs: num(r.createdAtUs),
  };
}

export function contractRow(r: Raw): ContractRow {
  return {
    id: num(r.id),
    lobbyId: num(r.lobbyId),
    key: str(r.key),
    revision: num(r.revision),
    text: str(r.text),
    source: str(r.source) as ContractRow["source"],
    proposalId: opt(r.proposalId, num),
    basisItemIds: numArr(r.basisItemIds),
    current: bool(r.current),
    createdAtUs: num(r.createdAtUs),
  };
}

export function deliveryRow(r: Raw): DeliveryRow {
  return {
    id: num(r.id),
    lobbyId: num(r.lobbyId),
    targetId: num(r.targetId),
    kind: str(r.kind) as DeliveryRow["kind"],
    refId: num(r.refId),
    summary: str(r.summary),
    stage: str(r.stage) as DeliveryRow["stage"],
    queuedAtUs: num(r.queuedAtUs),
    receivedAtUs: num(r.receivedAtUs),
    shownAtUs: num(r.shownAtUs),
    respondedAtUs: num(r.respondedAtUs),
  };
}

export function eventRow(r: Raw): EventRow {
  return {
    id: num(r.id),
    lobbyId: num(r.lobbyId),
    atUs: num(r.atUs),
    actor: str(r.actor),
    type: str(r.type),
    subjectId: num(r.subjectId),
    detail: jsonObject(r.detail),
  };
}

export function headRow(r: Raw): HeadRow {
  return {
    id: num(r.id),
    lobbyId: num(r.lobbyId),
    participantId: num(r.participantId),
    sha: str(r.sha),
    outOfAreaFiles: strArr(r.outOfAreaFiles),
    createdAtUs: num(r.createdAtUs),
  };
}

export function verificationRow(r: Raw): VerificationRow {
  const from = jsonObject(r.assembledFrom);
  return {
    id: num(r.id),
    lobbyId: num(r.lobbyId),
    assembledFrom: Object.fromEntries(
      Object.entries(from).map(([k, v]) => [k, str(v)]),
    ),
    treeHash: str(r.treeHash),
    mergeTreeClean: bool(r.mergeTreeClean),
    oracleHash: str(r.oracleHash),
    exitCode: num(r.exitCode),
    passed: num(r.passed),
    total: num(r.total),
    reportHash: str(r.reportHash),
    verifierId: num(r.verifierId),
    createdAtUs: num(r.createdAtUs),
  };
}

export function reviewRow(r: Raw): ReviewRow {
  return {
    id: num(r.id),
    lobbyId: num(r.lobbyId),
    verificationId: num(r.verificationId),
    kind: str(r.kind) as ReviewRow["kind"],
    summary: str(r.summary),
    findings:
      typeof r.findings === "string"
        ? r.findings
        : JSON.stringify(r.findings ?? null),
    model: str(r.model),
    sessionId: str(r.sessionId),
    createdAtUs: num(r.createdAtUs),
  };
}

export function serviceRow(r: Raw): ServiceRow {
  return {
    name: str(r.name),
    lastBeatUs: num(r.lastBeatUs),
    detail: jsonObject(r.detail),
  };
}

/** `review.findings` → ReviewFindings, tolerating partial or malformed JSON. */
export function parseReviewFindings(raw: string): ReviewFindings {
  const o = jsonObject(raw);
  const clauses = Array.isArray(o.clauses) ? o.clauses : [];
  const rc = o.rootCause as Record<string, unknown> | null | undefined;
  return {
    summary: str(o.summary),
    clauses: clauses.map((c) => {
      const cc = (c ?? {}) as Record<string, unknown>;
      const verdict = str(cc.verdict);
      return {
        clause: str(cc.clause),
        key: str(cc.key),
        verdict:
          verdict === "conforms" || verdict === "violates"
            ? verdict
            : "not_applicable",
        evidence: (Array.isArray(cc.evidence) ? cc.evidence : []).map((e) => {
          const ee = (e ?? {}) as Record<string, unknown>;
          return { file: str(ee.file), line: num(ee.line), note: str(ee.note) };
        }),
      };
    }),
    rootCause:
      rc && typeof rc === "object"
        ? {
            key: str(rc.key),
            violator: (str(rc.violator) || "unknown") as Provider | "unknown",
            explanation: str(rc.explanation),
          }
        : null,
  };
}

// ---------------------------------------------------------------------------------------------

/** Builds a Dataset from per-table raw rows, scoped to `lobbyId`. */
export function datasetFromTables(
  tables: Partial<Record<ExportedTable, Raw[]>>,
  lobbyId: number | null,
): Dataset {
  const rows = (t: ExportedTable) => (tables[t] ?? []) as Raw[];
  const inLobby = <T extends { lobbyId: number }>(xs: T[]) =>
    lobbyId == null ? xs : xs.filter((x) => x.lobbyId === lobbyId);
  const lobbies = rows("lobby").map(lobbyRow);
  const lobby =
    (lobbyId == null
      ? lobbies.sort((a, b) => b.id - a.id)[0]
      : lobbies.find((l) => l.id === lobbyId)) ?? null;
  const byId = <T extends { id: number }>(xs: T[]) =>
    xs.sort((a, b) => a.id - b.id);
  return {
    lobby,
    participants: byId(rows("participant").map(participantRow)),
    plans: byId(inLobby(rows("plan").map(planRow))),
    planItems: byId(inLobby(rows("plan_item").map(planItemRow))),
    messages: byId(inLobby(rows("message").map(messageRow))),
    jobs: byId(inLobby(rows("job").map(jobRow))),
    proposals: byId(inLobby(rows("proposal").map(proposalRow))),
    responses: byId(inLobby(rows("response").map(responseRow))),
    contracts: byId(inLobby(rows("contract").map(contractRow))),
    deliveries: byId(inLobby(rows("delivery").map(deliveryRow))),
    events: byId(inLobby(rows("event").map(eventRow))),
    heads: byId(inLobby(rows("head").map(headRow))),
    verifications: byId(inLobby(rows("verification").map(verificationRow))),
    reviews: byId(inLobby(rows("review").map(reviewRow))),
    services: rows("service").map(serviceRow),
  };
}

export interface LoadedExport {
  label: string;
  lobbyId: number;
  exportedAtUs: number;
  data: Dataset;
}

/** Validates and normalizes an EventsExport. Throws with a readable message when it isn't one. */
export function normalizeExport(raw: unknown): LoadedExport {
  if (!raw || typeof raw !== "object")
    throw new Error("not an EventsExport: expected a JSON object");
  const e = raw as Partial<EventsExport>;
  if (e.protocolVersion !== PROTOCOL_VERSION)
    throw new Error(
      `unsupported protocolVersion ${String(e.protocolVersion)} (dashboard speaks ${PROTOCOL_VERSION})`,
    );
  if (!e.tables || typeof e.tables !== "object")
    throw new Error("not an EventsExport: missing tables");
  const tables: Partial<Record<ExportedTable, Raw[]>> = {};
  for (const t of EXPORTED_TABLES) {
    const v = (e.tables as Record<string, unknown>)[t];
    tables[t] = Array.isArray(v) ? (v as Raw[]) : [];
  }
  const lobbyId = num(e.lobbyId);
  return {
    label: str(e.label) || `lobby ${lobbyId}`,
    lobbyId,
    exportedAtUs: num(e.exportedAtUs),
    data: datasetFromTables(tables, lobbyId),
  };
}

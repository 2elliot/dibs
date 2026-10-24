import { schema, table, t } from 'spacetimedb/server';

const id = () => t.u32().primaryKey().autoInc();
const idx = () => t.u32().index('btree');
export const admin = table({ name: 'admin' }, { identity: t.identity().primaryKey() });
// Private bookkeeping: two clients using one token must not race the public online flag.
const presenceConnection = table({ name: 'presence_connection' }, {
  connectionId: t.connectionId().primaryKey(), identity: t.identity().index('btree'),
});
export const invite = table({ name: 'invite' }, {
  code: t.string().primaryKey(), name: t.string(), provider: t.string(), role: t.string(), used: t.bool(),
});
export const participant = table({ name: 'participant', public: true }, {
  id: id(), identity: t.identity().unique(), name: t.string().unique(), provider: t.string(), role: t.string(),
  online: t.bool(), buildHash: t.string(), currentLobbyId: t.option(t.u32()),
});
export const lobby = table({ name: 'lobby', public: true }, {
  id: id(), scenario: t.string(), mode: t.string(), baseSha: t.string(), vocabulary: t.array(t.string()),
  vocabularyJson: t.string(), charter: t.string(), buildHash: t.string(), state: t.string(),
  analyzeAnywayFired: t.bool(), createdAtUs: t.u64(), startedAtUs: t.u64(), fallbackAtUs: t.u64(), endsAtUs: t.u64(),
});
export const plan = table({ name: 'plan', public: true }, {
  id: id(), lobbyId: idx(), participantId: idx(), revision: t.u32(), goal: t.string(), notes: t.string(),
  requestId: t.string().index('btree'), current: t.bool(), createdAtUs: t.u64(),
});
export const planItem = table({ name: 'plan_item', public: true }, {
  id: id(), planId: idx(), lobbyId: idx(), participantId: t.u32(), kind: t.string(), key: t.string(), text: t.string(), current: t.bool(),
});
export const message = table({ name: 'message', public: true }, {
  id: id(), lobbyId: idx(), fromId: t.u32(), to: t.string(), text: t.string(), requestId: t.string(), createdAtUs: t.u64(),
});
export const job = table({ name: 'job', public: true }, {
  id: id(), slot: t.string().unique(), lobbyId: idx(), kind: t.string(), state: t.string(), inputKey: t.string(),
  leaseToken: t.string(), leaseExpiresUs: t.u64(), attempts: t.u32(), calls: t.u32(), error: t.string(), updatedAtUs: t.u64(),
});
export const jobTimer = table({ name: 'job_timer' }, {
  scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(), jobId: t.u32(), inputKey: t.string(),
});
export const lobbyTimer = table({ name: 'lobby_timer' }, {
  scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(), lobbyId: t.u32(), action: t.string(),
});
export const proposal = table({ name: 'proposal', public: true }, {
  id: id(), slot: t.string().unique(), lobbyId: idx(), key: t.string(), revision: t.u32(), relation: t.string(),
  contractText: t.string(), rationale: t.string(), citedItemIds: t.array(t.u32()), requiredPartyIds: t.array(t.u32()),
  state: t.string(), inputKey: t.string(), createdAtUs: t.u64(), closedAtUs: t.u64(),
});
export const response = table({ name: 'response', public: true }, {
  id: id(), lobbyId: idx(), proposalId: idx(), revision: t.u32(), participantId: t.u32(), decision: t.string(),
  reason: t.string(), requestId: t.string(), createdAtUs: t.u64(),
});
export const contract = table({ name: 'contract', public: true }, {
  id: id(), lobbyId: idx(), key: t.string(), revision: t.u32(), text: t.string(), source: t.string(),
  proposalId: t.option(t.u32()), basisItemIds: t.array(t.u32()), current: t.bool(), createdAtUs: t.u64(),
});
export const delivery = table({ name: 'delivery', public: true }, {
  id: id(), lobbyId: idx(), targetId: idx(), kind: t.string(), refId: t.u32(), summary: t.string(), stage: t.string(),
  queuedAtUs: t.u64(), receivedAtUs: t.u64(), shownAtUs: t.u64(), respondedAtUs: t.u64(),
});
export const event = table({ name: 'event', public: true }, {
  id: id(), lobbyId: idx(), atUs: t.u64(), actor: t.string(), type: t.string(), subjectId: t.u32(), detail: t.string(),
});
export const head = table({ name: 'head', public: true }, {
  id: id(), lobbyId: idx(), participantId: t.u32(), sha: t.string(), outOfAreaFiles: t.array(t.string()), createdAtUs: t.u64(),
});
export const verification = table({ name: 'verification', public: true }, {
  id: id(), lobbyId: idx(), assembledFrom: t.string(), treeHash: t.string(), mergeTreeClean: t.bool(), oracleHash: t.string(),
  exitCode: t.i32(), passed: t.u32(), total: t.u32(), reportHash: t.string(), verifierId: t.u32(), createdAtUs: t.u64(),
});
export const review = table({ name: 'review', public: true }, {
  id: id(), lobbyId: idx(), verificationId: t.u32(), kind: t.string(), summary: t.string(), findings: t.string(),
  model: t.string(), sessionId: t.string(), createdAtUs: t.u64(),
});
export const request = table({ name: 'request', public: true }, {
  requestId: t.string().primaryKey(), payload: t.string(), atUs: t.u64(),
});
export const service = table({ name: 'service', public: true }, {
  name: t.string().primaryKey(), lastBeatUs: t.u64(), detail: t.string(),
});
export const db = schema({ admin, presenceConnection, invite, participant, lobby, plan, planItem, message, job, jobTimer, lobbyTimer,
  proposal, response, contract, delivery, event, head, verification, review, request, service });

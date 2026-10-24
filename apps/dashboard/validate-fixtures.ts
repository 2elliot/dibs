import dibs from './fixtures/s2-dibs.json';
import none from './fixtures/s2-none.json';
import { EXPORTED_TABLES, PROTOCOL_VERSION, type EventsExport, type ExportedTable } from '@dibs/protocol';

type JsonEventsExport = Omit<EventsExport, 'protocolVersion'> & { protocolVersion: number };
const fixtures: JsonEventsExport[] = [dibs, none];
const tableNames = new Set<string>(EXPORTED_TABLES);
const getIds = (rows: Record<string, unknown>[]) => new Set(rows.map(row => Number(row.id)));
const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(message); };

function validate(fixture: JsonEventsExport) {
  const fail = (message: string): never => { throw new Error(`${fixture.label}: ${message}`); };
  assert(fixture.protocolVersion === PROTOCOL_VERSION, `unsupported protocol version ${fixture.protocolVersion}`);
  assert(Number.isSafeInteger(fixture.lobbyId), 'lobbyId must be an integer');
  for (const key of Object.keys(fixture.tables)) assert(tableNames.has(key), `unknown exported table ${key}`);
  for (const table of EXPORTED_TABLES) assert(Array.isArray(fixture.tables[table]), `missing table ${table}`);

  const tables = fixture.tables as Record<ExportedTable, Record<string, unknown>[]>;
  const lobby = tables.lobby.find(row => Number(row.id) === fixture.lobbyId);
  assert(lobby, 'exported lobby row is missing');
  const start = Number(lobby.startedAtUs);
  const end = Number(lobby.endsAtUs);
  assert(start > 0 && end >= start, 'lobby run bounds are invalid');
  assert(fixture.exportedAtUs >= start && fixture.exportedAtUs <= end, 'exportedAtUs is outside the lobby run');

  const ids = Object.fromEntries(EXPORTED_TABLES.map(table => [table, getIds(tables[table])])) as Record<ExportedTable, Set<number>>;
  for (const table of EXPORTED_TABLES) {
    const seen = new Set<number>();
    for (const [index, row] of tables[table].entries()) {
      if (typeof row.id === 'number') {
        assert(Number.isSafeInteger(row.id), `${table}[${index}].id is invalid`);
        assert(!seen.has(row.id), `${table} has duplicate id ${row.id}`);
        seen.add(row.id);
      }
      if (table !== 'participant' && table !== 'service' && table !== 'lobby') assert(Number(row.lobbyId) === fixture.lobbyId, `${table}[${index}] belongs to another lobby`);
      for (const [key, value] of Object.entries(row)) {
        if (!key.endsWith('AtUs') || typeof value !== 'number' || value === 0) continue; // zero is the protocol's not-yet-reached timestamp sentinel.
        assert(Number.isSafeInteger(value) && value >= start && value <= end, `${table}[${index}].${key} is outside the lobby run`);
      }
    }
  }
  assert(fixture.exportedAtUs >= start && fixture.exportedAtUs <= end, 'export time is invalid');

  const participantIds = ids.participant;
  const planIds = ids.plan;
  const itemIds = ids.plan_item;
  const proposalIds = ids.proposal;
  const contractIds = ids.contract;
  const verificationIds = ids.verification;
  const vocabulary = Array.isArray(lobby.vocabulary) ? lobby.vocabulary.map(String) : [];
  const vocabularyJson = JSON.parse(String(lobby.vocabularyJson ?? '[]')) as { key?: string }[];
  assert(new Set(vocabulary).size === vocabulary.length, 'lobby vocabulary contains duplicates');
  assert(JSON.stringify([...vocabulary].sort()) === JSON.stringify(vocabularyJson.map(entry => String(entry.key)).sort()), 'vocabularyJson does not match lobby.vocabulary');
  for (const item of tables.plan_item) {
    assert(vocabulary.includes(String(item.key)), `plan item ${item.id} uses key outside vocabulary: ${String(item.key)}`);
    assert(planIds.has(Number(item.planId)), `plan item ${item.id} references missing plan ${item.planId}`);
    assert(participantIds.has(Number(item.participantId)), `plan item ${item.id} references missing participant ${item.participantId}`);
  }
  for (const plan of tables.plan) assert(participantIds.has(Number(plan.participantId)), `plan ${plan.id} references missing participant ${plan.participantId}`);
  for (const proposal of tables.proposal) {
    for (const id of (proposal.citedItemIds as number[] ?? [])) assert(itemIds.has(Number(id)), `proposal ${proposal.id} cites missing plan item ${id}`);
    for (const id of (proposal.requiredPartyIds as number[] ?? [])) assert(participantIds.has(Number(id)), `proposal ${proposal.id} requires missing participant ${id}`);
  }
  for (const response of tables.response) {
    assert(proposalIds.has(Number(response.proposalId)), `response ${response.id} references missing proposal ${response.proposalId}`);
    assert(participantIds.has(Number(response.participantId)), `response ${response.id} references missing participant ${response.participantId}`);
  }
  for (const contract of tables.contract) {
    if (contract.proposalId != null) assert(proposalIds.has(Number(contract.proposalId)), `contract ${contract.id} references missing proposal ${contract.proposalId}`);
    for (const id of (contract.basisItemIds as number[] ?? [])) assert(itemIds.has(Number(id)), `contract ${contract.id} references missing basis item ${id}`);
  }
  for (const delivery of tables.delivery) {
    assert(participantIds.has(Number(delivery.targetId)), `delivery ${delivery.id} references missing target ${delivery.targetId}`);
    const targetIds = delivery.kind === 'proposal' ? proposalIds : delivery.kind === 'contract' || delivery.kind === 'aligned' ? contractIds : null;
    if (targetIds) assert(targetIds.has(Number(delivery.refId)), `delivery ${delivery.id} references missing ${delivery.kind} row ${delivery.refId}`);
    else assert(Object.values(ids).some(rows => rows.has(Number(delivery.refId))), `delivery ${delivery.id} has dangling refId ${delivery.refId}`);
  }
  for (const head of tables.head) assert(participantIds.has(Number(head.participantId)), `head ${head.id} references missing participant ${head.participantId}`);
  for (const verification of tables.verification) assert(participantIds.has(Number(verification.verifierId)), `verification ${verification.id} references missing verifier ${verification.verifierId}`);
  for (const review of tables.review) assert(verificationIds.has(Number(review.verificationId)), `review ${review.id} references missing verification ${review.verificationId}`);

  const subjectTables: Partial<Record<string, ExportedTable>> = {
    lobby_created: 'lobby', lobby_started: 'lobby', lobby_stopped: 'lobby',
    plan_published: 'plan', proposal_created: 'proposal', proposal_superseded: 'proposal',
    response_recorded: 'proposal', proposal_accepted: 'proposal', proposal_rejected: 'proposal', proposal_escalated: 'proposal',
    contract_agreed: 'contract', contract_aligned: 'contract', delivery_stage: 'delivery',
    head_reported: 'head', verification_recorded: 'verification', review_recorded: 'review',
  };
  for (const event of tables.event) {
    const targetTable = subjectTables[String(event.type)];
    assert(targetTable, `event ${event.id} has unsupported subject type ${String(event.type)}`);
    assert(ids[targetTable].has(Number(event.subjectId)), `event ${event.id} subjectId ${event.subjectId} does not reference ${targetTable}`);
  }
}

for (const fixture of fixtures) validate(fixture);
console.log(`Validated ${fixtures.length} EventsExport fixtures against protocol v${PROTOCOL_VERSION}, including vocabulary, references, and run timestamps.`);

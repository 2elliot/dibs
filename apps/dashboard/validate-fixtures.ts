import dibs from './fixtures/s2-dibs.json';
import none from './fixtures/s2-none.json';
import { EXPORTED_TABLES, PROTOCOL_VERSION, type EventsExport } from '@dibs/protocol';

type JsonEventsExport = Omit<EventsExport, 'protocolVersion'> & { protocolVersion: number };
const fixtures: JsonEventsExport[] = [dibs, none];
// JSON module imports widen the literal `protocolVersion: 1` to `number`; the table
// record itself is checked against the protocol interface and the version at runtime.
const typedTables: EventsExport['tables'][] = fixtures.map(fixture => fixture.tables);
for (const [index, fixture] of fixtures.entries()) {
  if (fixture.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Unsupported protocol in ${fixture.label}`);
  for (const table of EXPORTED_TABLES) if (!Array.isArray(typedTables[index][table])) throw new Error(`Missing table ${table} in ${fixture.label}`);
}
console.log(`Validated ${fixtures.length} EventsExport fixtures against protocol v${PROTOCOL_VERSION}.`);

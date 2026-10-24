import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { connect, subscribeLobby, toJson, type DbConnection } from '@dibs/client';
import { EXPORTED_TABLES, PROTOCOL_VERSION, type EventsExport } from '@dibs/protocol';
import { options, required, configured, id } from './common.ts';

export function snapshot(conn: DbConnection, lobbyId: number, label: string): EventsExport {
  const tables = {} as EventsExport['tables'];
  for (const name of EXPORTED_TABLES) {
    const accessor = name === 'plan_item' ? 'planItem' : name;
    tables[name] = [...conn.db[accessor].iter()].filter(row =>
      name === 'lobby' ? 'id' in row && row.id === lobbyId : name === 'participant' || name === 'service' || 'lobbyId' in row && row.lobbyId === lobbyId
    ).map(row => toJson(row));
  }
  return { protocolVersion: PROTOCOL_VERSION, label, lobbyId, exportedAtUs: Date.now() * 1000, tables };
}
export async function main(args: string[]) {
  const { values, positionals } = options(args, ['uri', 'db', 'out', 'label']);
  if (positionals.length !== 1) throw new Error('usage: dibs export <lobbyId> --out <file> [--db <db>] [--label <text>]');
  const lobbyId = id(positionals[0]); const { conn } = await connect(await configured(values));
  try {
    await subscribeLobby(conn, lobbyId);
    if (!conn.db.lobby.id.find(lobbyId)) throw new Error('unknown lobby');
    const path = resolve(required(values, 'out')); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(snapshot(conn, lobbyId, typeof values.label === 'string' ? values.label : `Lobby ${lobbyId}`), null, 2) + '\n');
    console.log(path);
  } finally { conn.disconnect(); }
}

import { readFile } from 'node:fs/promises';
import { subscribeLobby } from '@dibs/client';
import { options, required, id, asParticipant, all, waitFor } from './common.ts';
export async function main(args: string[]) {
  const { values, positionals } = options(args, ['uri', 'db', 'participant', 'scenario', 'mode', 'base', 'manifest', 'charter', 'build']);
  const { conn } = await asParticipant(values);
  try {
    if (positionals[0] === 'create' && positionals.length === 1) {
      await all(conn); const before = new Set([...conn.db.lobby.iter()].map(l => l.id));
      const manifest = JSON.parse(await readFile(required(values, 'manifest'), 'utf8'));
      await conn.reducers.createLobby({ scenario: required(values, 'scenario'), mode: required(values, 'mode'), baseSha: required(values, 'base'),
        vocabularyJson: JSON.stringify(manifest.vocabulary), charter: await readFile(required(values, 'charter'), 'utf8'), buildHash: required(values, 'build') });
      const lobby = await waitFor(() => [...conn.db.lobby.iter()].find(l => !before.has(l.id))); console.log(lobby.id);
    } else if (['start', 'stop'].includes(positionals[0]) && positionals.length === 2) {
      const lobbyId = id(positionals[1]); await subscribeLobby(conn, lobbyId, ['lobby']);
      await conn.reducers[positionals[0] === 'start' ? 'startLobby' : 'stopLobby']({ lobbyId });
      console.log(`Lobby ${lobbyId} ${positionals[0] === 'start' ? 'running' : 'stopped'}`);
    } else throw new Error('usage: dibs lobby create <options> | start <id> | stop <id>');
  } finally { conn.disconnect(); }
}

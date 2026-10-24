import { connect, subscribeLobby } from '@dibs/client';
import { saveConfig, saveToken, readToken } from '@dibs/client/node';
import { options, required, waitFor } from './common.ts';
export async function main(args: string[]) {
  const { values, positionals } = options(args, ['uri', 'db', 'participant', 'code']);
  if (positionals.length) throw new Error('usage: dibs join --uri <uri> --db <name> --participant <name> --code <code>');
  const name = required(values, 'participant'), uri = required(values, 'uri'), dbName = required(values, 'db');
  const token = await readToken(name);
  const session = await connect({ uri, dbName, token });
  try {
    await subscribeLobby(session.conn, 0, ['participant']);
    await session.conn.reducers.claimInvite({ code: required(values, 'code') });
    const me = await waitFor(() => [...session.conn.db.participant.iter()].find(p => p.identity.isEqual(session.identity)));
    await saveToken(me.name, session.token); await saveConfig({ dbUri: uri, dbName });
    if (me.name !== name) throw new Error(`invite belongs to ${me.name}, not ${name}; its token was saved under ${me.name}`);
    console.log(`Joined as ${name} (${me.role}); identity ${session.identity.toHexString()}`);
  } finally { session.conn.disconnect(); }
}

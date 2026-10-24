import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function localOnly(uri: string, db: string) {
  const url = new URL(uri);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !/^dibs-i1-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(db))
    throw new Error('automatic publishing/bootstrap requires a loopback URI and a dibs-i1-* database');
}
export function spacetime(args: string[], cwd?: string) {
  const installed = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'SpacetimeDB', 'spacetime.exe');
  const executable = process.env.SPACETIME_BIN || (installed && existsSync(installed) ? installed : 'spacetime');
  return execFileSync(executable, args, { cwd, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
}
export function publishLocal(uri: string, db: string, modulePath = fileURLToPath(new URL('../../../../spacetime/', import.meta.url))) {
  localOnly(uri, db);
  spacetime(['publish', '--server', uri, '--module-path', modulePath, '--yes', db]);
}
export function ownerSql(uri: string, db: string, query: string): unknown[][] {
  localOnly(uri, db);
  const output = spacetime(['sql', '--server', uri, '--format', 'json', db, query]);
  return JSON.parse(output)[0].rows;
}

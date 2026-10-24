import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DIBS_FILES, type DibsConfig } from '@dibs/protocol';

export function dibsHome() { return process.env.DIBS_HOME || join(homedir(), '.dibs'); }
export function participantDir(participant: string) {
  if (!/^[a-z][a-z0-9_-]*$/.test(participant)) throw new Error('invalid participant name');
  return join(dibsHome(), participant);
}
export async function readConfig(): Promise<DibsConfig> {
  const config = JSON.parse(await readFile(join(dibsHome(), DIBS_FILES.config), 'utf8'));
  if (typeof config.dbUri !== 'string' || typeof config.dbName !== 'string') throw new Error('invalid dibs config');
  return config;
}
export async function readToken(participant: string): Promise<string | undefined> {
  try { return (await readFile(join(participantDir(participant), DIBS_FILES.token), 'utf8')).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function atomic(file: string, value: string) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, value, { mode: 0o600 }); await rename(tmp, file);
}
export async function saveConfig(config: DibsConfig) {
  await mkdir(dibsHome(), { recursive: true });
  await atomic(join(dibsHome(), DIBS_FILES.config), JSON.stringify(config, null, 2) + '\n');
}
export async function saveToken(participant: string, token: string) {
  await mkdir(participantDir(participant), { recursive: true });
  await atomic(join(participantDir(participant), DIBS_FILES.token), token + '\n');
}

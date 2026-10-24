import { DbConnection, tables, type SubscriptionHandle } from '@dibs/bindings';
import type { Identity } from 'spacetimedb';
export { DbConnection, tables } from '@dibs/bindings';

export interface ConnectOptions { uri: string; dbName: string; token?: string; timeoutMs?: number; }
export function connect({ uri, dbName, token, timeoutMs = 10000 }: ConnectOptions): Promise<{ conn: DbConnection; identity: Identity; token: string }> {
  return new Promise((resolve, reject) => {
    let conn: DbConnection | undefined;
    let connected = false;
    const timer = setTimeout(() => { conn?.disconnect(); reject(new Error('connection timed out')); }, timeoutMs);
    try {
      conn = DbConnection.builder().withUri(uri).withDatabaseName(dbName).withToken(token)
        .withAutomaticReconnect()
        .onConnect((connection, identity, issuedToken) => { connected = true; clearTimeout(timer); resolve({ conn: connection, identity, token: issuedToken }); })
        .onConnectError((_ctx, error) => { if (!connected) { clearTimeout(timer); conn?.disconnect(); reject(error); } })
        .build();
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}
export type LobbyTable = keyof typeof tables;
const snakeToCamel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
export function subscribeLobby(conn: DbConnection, lobbyId: number, names: readonly (LobbyTable | 'plan_item')[] = [
  'participant', 'lobby', 'plan', 'planItem', 'message', 'job', 'proposal', 'response', 'contract', 'delivery', 'event', 'head', 'verification', 'review', 'service',
]): Promise<SubscriptionHandle> {
  // Keep a concrete typed query for every table; no interpolated SQL or untyped predicates.
  const queries = {
    participant: tables.participant, lobby: tables.lobby.where(r => r.id.eq(lobbyId)),
    plan: tables.plan.where(r => r.lobbyId.eq(lobbyId)), planItem: tables.planItem.where(r => r.lobbyId.eq(lobbyId)),
    message: tables.message.where(r => r.lobbyId.eq(lobbyId)), job: tables.job.where(r => r.lobbyId.eq(lobbyId)),
    proposal: tables.proposal.where(r => r.lobbyId.eq(lobbyId)), response: tables.response.where(r => r.lobbyId.eq(lobbyId)),
    contract: tables.contract.where(r => r.lobbyId.eq(lobbyId)), delivery: tables.delivery.where(r => r.lobbyId.eq(lobbyId)),
    event: tables.event.where(r => r.lobbyId.eq(lobbyId)), head: tables.head.where(r => r.lobbyId.eq(lobbyId)),
    verification: tables.verification.where(r => r.lobbyId.eq(lobbyId)), review: tables.review.where(r => r.lobbyId.eq(lobbyId)),
    service: tables.service, request: tables.request,
  };
  const selected = names.map(name => {
    const key = snakeToCamel(name) as keyof typeof queries;
    if (!(key in queries)) throw new Error(`unknown table: ${name}`);
    return queries[key];
  });
  if (selected.length === 0) return Promise.reject(new Error('at least one table is required'));
  return new Promise((resolve, reject) => {
    let handle: SubscriptionHandle;
    const timer = setTimeout(() => { handle?.unsubscribe(); reject(new Error('subscription timed out')); }, 10000);
    try {
      handle = conn.subscriptionBuilder().onApplied(() => { clearTimeout(timer); resolve(handle); })
        .onError(ctx => { clearTimeout(timer); reject(ctx.event); }).subscribe(selected);
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}
type Reducers = DbConnection['reducers'];
export type ReducerName = { [K in keyof Reducers]: Reducers[K] extends (args: infer A) => Promise<void> ? A extends object ? K : never : never }[keyof Reducers];
export type CallResult = { status: 'ok' | 'pending' | 'offline' | 'error'; error?: string };
export async function call<K extends ReducerName>(conn: DbConnection, reducer: K, args: Parameters<Reducers[K]>[0], { timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<CallResult> {
  if (!conn.isActive) return { status: 'offline', error: 'not connected' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const invoke = conn.reducers[reducer] as (args: unknown) => Promise<void>;
    return await Promise.race([
      invoke(args).then((): CallResult => ({ status: 'ok' })),
      new Promise<CallResult>(resolve => { timer = setTimeout(() => resolve({ status: 'pending', error: 'result not confirmed before timeout' }), timeoutMs); }),
    ]);
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return { status: name === 'UnknownCallResultError' ? 'pending' : name === 'DisconnectedError' || !conn.isActive ? 'offline' : 'error', error: error instanceof Error ? error.message : String(error) };
  } finally { if (timer) clearTimeout(timer); }
}
export function toJson(value: unknown): any {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new RangeError('bigint exceeds the safe JSON integer range');
    return number;
  }
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === 'object') {
    if ('toHexString' in value && typeof value.toHexString === 'function') return value.toHexString();
    if ('tag' in value && (value.tag === 'None' || value.tag === 'none')) return null;
    if ('tag' in value && (value.tag === 'Some' || value.tag === 'some') && 'value' in value) return toJson(value.value);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJson(item)]));
  }
  return value;
}

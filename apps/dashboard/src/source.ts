import { EXPORTED_TABLES, type EventsExport, type ExportedTable } from '@dibs/protocol';
import { normalizeExport } from './data/normalize';
import { replayBounds, snapshotAt } from './data/replay';
import type { Dataset } from './data/rows';

export type DashboardRows = Record<ExportedTable, Record<string, unknown>[]>;
export interface LobbySource {
  readonly mode: 'live' | 'replay';
  readonly label: string;
  getSnapshot(atUs?: number): DashboardRows;
  subscribe(listener: () => void): () => void;
  setTime?(atUs: number): void;
  disconnect(): void;
}

export function emptyRows(): DashboardRows {
  return Object.fromEntries(EXPORTED_TABLES.map(name => [name, []])) as unknown as DashboardRows;
}

export class ReplayLobbySource implements LobbySource {
  readonly mode = 'replay' as const;
  readonly label: string;
  private readonly data: Dataset;
  private readonly start: number;
  private readonly end: number;
  private cursor: number;
  private readonly listeners = new Set<() => void>();
  constructor(data: EventsExport) {
    const loaded = normalizeExport(data);
    this.label = loaded.label;
    this.data = loaded.data;
    const bounds = replayBounds(this.data);
    this.start = bounds.start;
    this.end = bounds.end;
    this.cursor = this.end;
  }
  get startUs() { return this.start; }
  get endUs() { return this.end; }
  setTime(atUs: number) { this.cursor = atUs; for (const listener of this.listeners) listener(); }
  getSnapshot(atUs = this.cursor): DashboardRows {
    const snapshot = snapshotAt(this.data, atUs);
    return {
      lobby: snapshot.lobby ? [snapshot.lobby as unknown as Record<string, unknown>] : [],
      participant: snapshot.participants as unknown as Record<string, unknown>[],
      plan: snapshot.plans as unknown as Record<string, unknown>[],
      plan_item: snapshot.planItems as unknown as Record<string, unknown>[],
      message: snapshot.messages as unknown as Record<string, unknown>[],
      job: snapshot.jobs as unknown as Record<string, unknown>[],
      proposal: snapshot.proposals as unknown as Record<string, unknown>[],
      response: snapshot.responses as unknown as Record<string, unknown>[],
      contract: snapshot.contracts as unknown as Record<string, unknown>[],
      delivery: snapshot.deliveries as unknown as Record<string, unknown>[],
      event: snapshot.events as unknown as Record<string, unknown>[],
      head: snapshot.heads as unknown as Record<string, unknown>[],
      verification: snapshot.verifications as unknown as Record<string, unknown>[],
      review: snapshot.reviews as unknown as Record<string, unknown>[],
      service: snapshot.services as unknown as Record<string, unknown>[],
    };
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  disconnect() { this.listeners.clear(); }
}

export async function loadReplay(url: string): Promise<ReplayLobbySource> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load replay (${response.status})`);
  return new ReplayLobbySource(await response.json() as EventsExport);
}

export async function createLiveSource(uri: string, db: string, lobbyId?: number): Promise<LobbySource> {
  const { connect, subscribeLobby, tables, toJson } = await import('@dibs/client');
  const { conn } = await connect({ uri, dbName: db });
  const tableAccessors: Record<ExportedTable, string> = {
    lobby: 'lobby', participant: 'participant', plan: 'plan', plan_item: 'planItem', message: 'message', job: 'job', proposal: 'proposal', response: 'response', contract: 'contract', delivery: 'delivery', event: 'event', head: 'head', verification: 'verification', review: 'review', service: 'service',
  };
  try {
    if (lobbyId !== undefined) {
      await subscribeLobby(conn, lobbyId);
    } else {
      // Follow the whole public dataset so newly created lobbies (and their rows)
      // are already in the cache when selection changes. The panels stay scoped.
      await new Promise<void>((resolve, reject) => {
        let handle: ReturnType<ReturnType<typeof conn.subscriptionBuilder>['subscribe']> | undefined;
        const timer = setTimeout(() => {
          handle?.unsubscribe();
          reject(new Error('subscription timed out'));
        }, 10000);
        try {
          handle = conn.subscriptionBuilder()
            .onApplied(() => { clearTimeout(timer); resolve(); })
            .onError(ctx => { clearTimeout(timer); reject(ctx.event); })
            .subscribe(EXPORTED_TABLES.map(table => tables[tableAccessors[table] as keyof typeof tables]));
        } catch (error) { clearTimeout(timer); reject(error); }
      });
    }
  } catch (error) {
    conn.disconnect();
    throw error;
  }
  const listeners = new Set<() => void>();
  const selectedLobbyId = () => {
    if (lobbyId !== undefined) return lobbyId;
    const lobbies = [...conn.db.lobby.iter()];
    const running = lobbies.filter(lobby => lobby.state === 'running');
    return (running.length ? running : lobbies).reduce<number | undefined>(
      (newest, lobby) => newest === undefined || lobby.id > newest ? lobby.id : newest,
      undefined,
    );
  };
  type DbTables = typeof conn.db;
  for (const table of EXPORTED_TABLES) {
    const accessor = conn.db[tableAccessors[table] as keyof DbTables] as unknown as { onInsert: (fn: () => void) => void; onDelete: (fn: () => void) => void; onUpdate?: (fn: () => void) => void };
    accessor.onInsert(() => listeners.forEach(fn => fn()));
    accessor.onDelete(() => listeners.forEach(fn => fn()));
    accessor.onUpdate?.(() => listeners.forEach(fn => fn()));
  }
  return {
    mode: 'live', get label() { return `Live lobby ${selectedLobbyId() ?? 'waiting'}`; },
    getSnapshot: () => {
      const rows = emptyRows();
      const selected = selectedLobbyId();
      for (const table of EXPORTED_TABLES) {
        const accessor = conn.db[tableAccessors[table] as keyof DbTables] as unknown as { iter: () => Iterable<unknown> };
        rows[table] = [...accessor.iter()].map(row => toJson(row) as Record<string, unknown>).filter(row => table === 'service' ? true : selected === undefined ? false : table === 'participant' ? row.currentLobbyId === selected : table === 'lobby' ? row.id === selected : row.lobbyId === selected);
      }
      return rows;
    },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    disconnect: () => { listeners.clear(); conn.disconnect(); },
  };
}

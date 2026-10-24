import { EXPORTED_TABLES, type EventsExport, type ExportedTable } from '@dibs/protocol';

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
  private atUs: number;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly data: EventsExport) {
    this.label = data.label;
    this.atUs = Math.max(...data.tables.event.map(row => Number(row.atUs ?? 0)));
    if (!Number.isFinite(this.atUs)) this.atUs = 0;
  }
  get startUs() { return Math.min(...this.data.tables.event.map(row => Number(row.atUs ?? 0)).filter(Boolean)) || 0; }
  get endUs() { return Math.max(...this.data.tables.event.map(row => Number(row.atUs ?? 0))) || this.startUs; }
  setTime(atUs: number) { this.atUs = atUs; for (const listener of this.listeners) listener(); }
  getSnapshot(atUs = this.atUs): DashboardRows {
    const rows = emptyRows();
    for (const name of EXPORTED_TABLES) {
      rows[name] = this.data.tables[name].filter(row => rowAt(row, name, this.data) <= atUs).map(row => ({ ...row }));
    }
    // Values such as state are stored as a final snapshot; reconstruct the proposal's
    // open/rejected state at the selected event time from its lifecycle events.
    for (const proposal of rows.proposal) {
      const closedAt = Number(proposal.closedAtUs ?? 0);
      if (closedAt > atUs) proposal.state = 'proposed';
    }
    return rows;
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  disconnect() { this.listeners.clear(); }
}

function rowAt(row: Record<string, unknown>, table: ExportedTable, data: EventsExport): number {
  const direct = ['atUs', 'createdAtUs', 'updatedAtUs', 'queuedAtUs', 'lastBeatUs'].map(k => row[k]).find(v => typeof v === 'number' && v > 0);
  if (typeof direct === 'number') return direct;
  if (table === 'plan_item') {
    const plan = data.tables.plan.find(p => p.id === row.planId);
    return Number(plan?.createdAtUs ?? 0);
  }
  if (table === 'participant' || table === 'lobby' || table === 'service') return 0;
  return 0;
}

export async function loadReplay(url: string): Promise<ReplayLobbySource> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load replay (${response.status})`);
  return new ReplayLobbySource(await response.json() as EventsExport);
}

export async function createLiveSource(uri: string, db: string, lobbyId: number): Promise<LobbySource> {
  const { connect, subscribeLobby, toJson } = await import('@dibs/client');
  const { conn } = await connect({ uri, dbName: db });
  await subscribeLobby(conn, lobbyId);
  const listeners = new Set<() => void>();
  const tableAccessors: Record<ExportedTable, string> = {
    lobby: 'lobby', participant: 'participant', plan: 'plan', plan_item: 'planItem', message: 'message', job: 'job', proposal: 'proposal', response: 'response', contract: 'contract', delivery: 'delivery', event: 'event', head: 'head', verification: 'verification', review: 'review', service: 'service',
  };
  type DbTables = typeof conn.db;
  for (const table of EXPORTED_TABLES) {
    const accessor = conn.db[tableAccessors[table] as keyof DbTables] as unknown as { onInsert: (fn: () => void) => void; onDelete: (fn: () => void) => void; onUpdate?: (fn: () => void) => void };
    accessor.onInsert(() => listeners.forEach(fn => fn()));
    accessor.onDelete(() => listeners.forEach(fn => fn()));
    accessor.onUpdate?.(() => listeners.forEach(fn => fn()));
  }
  return {
    mode: 'live', label: `Live lobby ${lobbyId}`,
    getSnapshot: () => {
      const rows = emptyRows();
      for (const table of EXPORTED_TABLES) {
        const accessor = conn.db[tableAccessors[table] as keyof DbTables] as unknown as { iter: () => Iterable<unknown> };
        rows[table] = [...accessor.iter()].map(row => toJson(row) as Record<string, unknown>).filter(row => table === 'participant' ? row.currentLobbyId === lobbyId : table === 'service' ? true : table === 'lobby' ? row.id === lobbyId : row.lobbyId === lobbyId);
      }
      return rows;
    },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    disconnect: () => { listeners.clear(); conn.disconnect(); },
  };
}

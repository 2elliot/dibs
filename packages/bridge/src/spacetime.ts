// SpacetimeDB-backed store. The live connection uses @dibs/client. Tests pass a fake builder.

import type { PlanInput, Provider } from "@dibs/protocol";
import { DbConnection } from "@dibs/client";
import { settleCall, type CallResult } from "./calls.ts";
import type { RespondInput } from "./memory.ts";
import type { AgentStore } from "./store.ts";
import {
  emptyWorld,
  normalizeWorld,
  type MessageRow,
  type RawTables,
  type World,
} from "./world.ts";

export interface RawTable {
  iter?: () => Iterable<Record<string, unknown>>;
  onInsert?: (cb: () => void) => void;
  onUpdate?: (cb: () => void) => void;
  onDelete?: (cb: () => void) => void;
}

export interface RawConn {
  db: Record<string, RawTable | undefined>;
  reducers: Record<string, (args: Record<string, unknown>) => Promise<void>>;
  subscriptionBuilder?: () => {
    onApplied: (cb: () => void) => { subscribe: (queries: string[]) => void };
  };
  disconnect?: () => void;
}

export interface DbBuilder {
  withUri(uri: string): DbBuilder;
  withDatabaseName(name: string): DbBuilder;
  withToken(token: string): DbBuilder;
  withAutomaticReconnect?: () => DbBuilder;
  onConnect(
    cb: (conn: RawConn, identity: unknown, token: string) => void,
  ): DbBuilder;
  onDisconnect(cb: (ctx: unknown, error?: unknown) => void): DbBuilder;
  onConnectError(cb: (ctx: unknown, error: unknown) => void): DbBuilder;
  build(): RawConn;
}

export interface RemoteReducers {
  joinLobby(args: { lobbyId: number; buildHash: string }): Promise<void>;
  publishPlan(args: {
    requestId: string;
    goal: string;
    produces: { key: string; text: string }[];
    requires: { key: string; text: string }[];
    notes: string;
  }): Promise<void>;
  sendMessage(args: {
    requestId: string;
    to: string;
    text: string;
  }): Promise<void>;
  respond(args: {
    requestId: string;
    proposalId: number;
    revision: number;
    decision: string;
    reason: string;
  }): Promise<void>;
  markDelivery(args: { deliveryId: number; stage: string }): Promise<void>;
  reportHead(args: {
    lobbyId: number;
    sha: string;
    outOfAreaFiles: string[];
  }): Promise<void>;
}

export interface RemoteSession {
  world(): World;
  changes(cb: () => void): () => void;
  reducers: RemoteReducers;
  close(): void;
  readonly closed: Promise<void>;
}

export interface ConnectOptions {
  builder: () => DbBuilder;
  uri: string;
  database: string;
  token: string;
  participant: string;
  provider: Provider;
  lobbyId: number;
  buildHash: string;
  join?: boolean;
  project?: boolean;
  log?: (message: string) => void;
  nowUs?: () => number;
  /** How long a disconnect may last before the connection is rebuilt. */
  reconnectGraceMs?: number;
}

const TABLES = [
  "participant",
  "lobby",
  "plan",
  "planItem",
  "message",
  "job",
  "proposal",
  "response",
  "contract",
  "delivery",
] as const;

export function connectSession(
  options: ConnectOptions,
): Promise<RemoteSession> {
  const log = options.log ?? (() => {});
  const grace = options.reconnectGraceMs ?? 3000;
  assertId(options.lobbyId, "lobby id");
  return new Promise((resolve, reject) => {
    let settled = false;
    let applied = false;
    let session: LiveSession | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const initial = setTimeout(
      () => fail(new Error("database did not connect")),
      15_000,
    );
    initial.unref?.();
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(initial);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    let builder: DbBuilder;
    try {
      builder = options.builder();
      builder
        .withUri(options.uri)
        .withDatabaseName(options.database)
        .withToken(options.token);
      builder.withAutomaticReconnect?.();
    } catch (error) {
      fail(error);
      return;
    }
    const automatic =
      typeof options.builder === "function" &&
      typeof builder.withAutomaticReconnect === "function";

    builder.onConnectError((_ctx, error) => {
      log(
        `database connect failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!applied) fail(error);
      else session?.noteDisconnect();
    });
    builder.onDisconnect(() => {
      session?.noteDisconnect();
      if (!automatic) {
        session?.finish();
        return;
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => session?.finish(), grace);
      reconnectTimer.unref?.();
    });
    builder.onConnect((conn) => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (applied && session) {
        session.noteReconnect();
        return;
      }
      void attach(conn).catch(fail);
    });

    async function attach(conn: RawConn): Promise<void> {
      await subscribe(conn, [
        "SELECT * FROM participant",
        `SELECT * FROM lobby WHERE id = ${options.lobbyId}`,
      ]);
      const first = snapshot(conn, options, true);
      if (first.meId === null) {
        log(
          `participant ${options.participant} has not claimed an invite; deliveries and join are skipped`,
        );
      }
      await subscribe(
        conn,
        first.meId === null
          ? lobbyQueries(options.lobbyId, 0).filter(
              (query) => !query.includes("delivery"),
            )
          : lobbyQueries(options.lobbyId, first.meId),
      );
      session = new LiveSession(conn, options, log);
      watch(conn, () => session?.refresh());
      session.refresh();
      applied = true;
      if (options.project) {
        // Membership is bound to the saved identity. Never use the public
        // benchmark build-hash join path for ordinary project sessions.
        try {
          await conn.reducers.resumeProject({
            lobbyId: options.lobbyId,
            protocol: "project-v1",
          });
        } catch (error) {
          conn.disconnect?.();
          throw error;
        }
      } else if (options.join !== false && first.meId !== null) {
        try {
          await conn.reducers.joinLobby({
            lobbyId: options.lobbyId,
            buildHash: options.buildHash,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (!/already/i.test(message)) log(`join_lobby: ${message}`);
        }
      }
      if (!settled && session) {
        settled = true;
        clearTimeout(initial);
        resolve(session);
      }
    }

    try {
      builder.build();
    } catch (error) {
      fail(error);
    }
  });
}

export class RemoteStore implements AgentStore {
  constructor(
    private readonly session: RemoteSession,
    private readonly timeoutMs?: number,
  ) {}

  world(): World {
    return this.session.world();
  }

  changes(cb: () => void): () => void {
    return this.session.changes(cb);
  }

  close(): void {
    this.session.close();
  }

  get closed(): Promise<void> {
    return this.session.closed;
  }

  publishPlan(input: PlanInput, requestId: string): Promise<CallResult> {
    return this.invoke(requestId, async () => {
      const args = {
        requestId,
        goal: input.goal,
        produces: input.produces.map((item) => ({
          key: item.key,
          text: item.statement,
        })),
        requires: input.requires.map((item) => ({
          key: item.key,
          text: item.assumption,
        })),
        notes: input.notes ?? "",
      };
      await this.session.reducers.publishPlan(args);
      const plan = await poll(() =>
        this.session
          .world()
          .plans.find((row) => row.requestId === requestId && row.current),
      );
      return { planId: plan?.id ?? null, revision: plan?.revision ?? null };
    });
  }

  respond(input: RespondInput, requestId: string): Promise<CallResult> {
    return this.invoke(requestId, async () => {
      await this.session.reducers.respond({ requestId, ...input });
      return { decision: input.decision, proposalId: input.proposalId };
    });
  }

  sendMessage(
    to: MessageRow["to"],
    text: string,
    requestId: string,
  ): Promise<CallResult> {
    return this.invoke(requestId, async () => {
      await this.session.reducers.sendMessage({ requestId, to, text });
      const message = await poll(() =>
        this.session
          .world()
          .messages.find((row) => row.text === text && row.to === to),
      );
      return { messageId: message?.id ?? null };
    });
  }

  markDelivery(id: number, stage: "received" | "shown"): Promise<CallResult> {
    return this.invoke(`delivery:${id}:${stage}`, async () => {
      await this.session.reducers.markDelivery({ deliveryId: id, stage });
      return { stage };
    });
  }

  reportHead(
    lobbyId: number,
    sha: string,
    outOfAreaFiles: string[],
  ): Promise<CallResult> {
    return this.invoke(`head:${sha}`, async () => {
      await this.session.reducers.reportHead({ lobbyId, sha, outOfAreaFiles });
      return { sha, outOfAreaFiles };
    });
  }

  private invoke(
    requestId: string,
    run: () => Promise<Record<string, unknown>>,
  ): Promise<CallResult> {
    if (!this.session.world().online)
      return Promise.resolve({ status: "offline", requestId });
    return settleCall(requestId, run, this.timeoutMs);
  }
}

export function loadDbBuilder(): Promise<() => DbBuilder> {
  return Promise.resolve(() => DbConnection.builder() as unknown as DbBuilder);
}

class LiveSession implements RemoteSession {
  private snapshot: World;
  private listeners = new Set<() => void>();
  private done = false;
  private closedResolve: () => void = () => {};
  readonly closed: Promise<void>;
  readonly reducers: RemoteReducers;

  constructor(
    private readonly conn: RawConn,
    private readonly options: ConnectOptions,
    private readonly log: (message: string) => void,
  ) {
    this.snapshot = emptyWorld(options.participant, options.provider);
    this.closed = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
    const call = (name: string, args: Record<string, unknown>) => {
      const reducer = conn.reducers[name];
      if (typeof reducer !== "function")
        return Promise.reject(new Error(`reducer ${name} is missing`));
      return reducer(args);
    };
    this.reducers = {
      joinLobby: (args) => call("joinLobby", args),
      publishPlan: (args) => call("publishPlan", args),
      sendMessage: (args) => call("sendMessage", args),
      respond: (args) => call("respond", args),
      markDelivery: (args) => call("markDelivery", args),
      reportHead: (args) => call("reportHead", args),
    };
  }

  world(): World {
    return this.snapshot;
  }

  changes(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private connected = true;

  refresh(): void {
    this.replace(
      snapshot(
        this.conn,
        this.options,
        this.connected,
        this.connected ? undefined : this.snapshot.offlineSinceUs,
      ),
    );
  }

  noteDisconnect(): void {
    this.connected = false;
    this.replace({
      ...this.snapshot,
      online: false,
      offlineSinceUs: this.options.nowUs?.() ?? Date.now() * 1000,
    });
  }

  noteReconnect(): void {
    this.connected = true;
    this.refresh();
    this.log("database reconnected; subscriptions kept");
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    this.closedResolve();
  }

  close(): void {
    try {
      this.conn.disconnect?.();
    } catch (error) {
      this.log(
        `disconnect: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.finish();
  }

  private replace(next: World): void {
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}

function snapshot(
  conn: RawConn,
  options: ConnectOptions,
  online: boolean,
  offlineSinceUs?: number,
): World {
  const raw: RawTables = {
    participant: rows(conn, "participant"),
    lobby: rows(conn, "lobby"),
    plan: rows(conn, "plan"),
    planItem: rows(conn, "planItem"),
    message: rows(conn, "message"),
    job: rows(conn, "job"),
    proposal: rows(conn, "proposal"),
    response: rows(conn, "response"),
    contract: rows(conn, "contract"),
    delivery: rows(conn, "delivery"),
  };
  return normalizeWorld(
    raw,
    options.participant,
    options.provider,
    options.lobbyId,
    online,
    offlineSinceUs,
  );
}

function rows(conn: RawConn, name: string): Record<string, unknown>[] {
  const table = conn.db[name];
  if (!table?.iter) return [];
  return [...table.iter()];
}

function watch(conn: RawConn, onChange: () => void): void {
  for (const name of TABLES) {
    const table = conn.db[name];
    table?.onInsert?.(() => onChange());
    table?.onUpdate?.(() => onChange());
    table?.onDelete?.(() => onChange());
  }
}

function subscribe(conn: RawConn, queries: string[]): Promise<void> {
  if (!conn.subscriptionBuilder) return Promise.resolve();
  const builder = conn.subscriptionBuilder();
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error("subscription was not applied"));
      }
    }, 10_000);
    timer.unref?.();
    try {
      const ready = builder.onApplied(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      });
      ready.subscribe(queries);
    } catch (error) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(error);
      }
    }
  });
}

function lobbyQueries(lobbyId: number, meId: number): string[] {
  assertId(meId, "participant id");
  const lobby = `lobby_id = ${lobbyId}`;
  return [
    `SELECT * FROM plan WHERE ${lobby}`,
    `SELECT * FROM plan_item WHERE ${lobby}`,
    `SELECT * FROM message WHERE ${lobby}`,
    `SELECT * FROM job WHERE ${lobby}`,
    `SELECT * FROM proposal WHERE ${lobby}`,
    `SELECT * FROM response WHERE ${lobby}`,
    `SELECT * FROM contract WHERE ${lobby}`,
    `SELECT * FROM delivery WHERE target_id = ${meId}`,
  ];
}

function assertId(id: number, name: string): void {
  if (!Number.isInteger(id) || id < 0 || id > 0xffff_ffff)
    throw new Error(`invalid ${name}`);
}

async function poll<T>(read: () => T | undefined): Promise<T | undefined> {
  const deadline = Date.now() + 1000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

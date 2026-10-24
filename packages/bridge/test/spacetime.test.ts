import { describe, expect, it } from "vitest";
import {
  connectSession,
  RemoteStore,
  type DbBuilder,
  type RawConn,
  type RawTable,
} from "../src/spacetime.ts";

function scripted(
  options: { fail?: boolean; automatic?: boolean; hangPlan?: boolean } = {},
) {
  const queries: string[][] = [];
  const hooks = new Map<string, () => void>();
  const tables: Record<string, Record<string, unknown>[]> = {
    participant: [
      {
        id: 1,
        name: "claude",
        provider: "claude",
        role: "agent",
        online: true,
        currentLobbyId: 3,
      },
    ],
    lobby: [
      {
        id: 3,
        mode: "dibs",
        state: "running",
        vocabulary: ["auth.session"],
        fallbackAtUs: 0,
        endsAtUs: 0,
        startedAtUs: 0,
        buildHash: "abc",
        baseSha: "def",
      },
    ],
    plan: [],
    planItem: [],
    message: [],
    job: [],
    proposal: [],
    response: [],
    contract: [],
    delivery: [],
  };
  const table = (name: string): RawTable => ({
    iter: () => tables[name] ?? [],
    onInsert: (cb) => hooks.set(name, cb),
    onUpdate: (cb) => hooks.set(name, cb),
    onDelete: (cb) => hooks.set(name, cb),
  });
  const conn: RawConn = {
    db: Object.fromEntries(
      Object.keys(tables).map((name) => [name, table(name)]),
    ),
    reducers: {
      joinLobby: async () => undefined,
      publishPlan: (args) => {
        if (options.hangPlan) return new Promise<void>(() => undefined);
        tables.plan?.push({
          id: 9,
          lobbyId: 3,
          participantId: 1,
          revision: 1,
          goal: args.goal,
          notes: args.notes,
          requestId: args.requestId,
          current: true,
        });
        hooks.get("plan")?.();
        return Promise.resolve();
      },
      sendMessage: async () => undefined,
      respond: async () => undefined,
      markDelivery: async () => undefined,
      reportHead: async () => undefined,
    },
    subscriptionBuilder: () => ({
      onApplied(cb) {
        return {
          subscribe(next) {
            queries.push(next);
            cb();
          },
        };
      },
    }),
    disconnect: () => undefined,
  };
  let onConnect: (
    next: RawConn,
    identity: unknown,
    token: string,
  ) => void = () => undefined;
  let onDisconnect: () => void = () => undefined;
  let onError: (error: unknown) => void = () => undefined;
  const builder: DbBuilder = {
    withUri: () => builder,
    withDatabaseName: () => builder,
    withToken: () => builder,
    ...(options.automatic ? { withAutomaticReconnect: () => builder } : {}),
    onConnect: (cb) => {
      onConnect = cb;
      return builder;
    },
    onDisconnect: (cb) => {
      onDisconnect = () => cb(undefined);
      return builder;
    },
    onConnectError: (cb) => {
      onError = (error) => cb(undefined, error);
      return builder;
    },
    build: () => {
      if (options.fail) onError(new Error("maincloud refused"));
      else onConnect(conn, "identity", "t");
      return conn;
    },
  };
  return {
    builder: () => builder,
    queries,
    disconnect: () => onDisconnect(),
    reconnect: () => onConnect(conn, "identity", "t"),
  };
}

describe("spacetime adapter", () => {
  it("retries a failed first connect on the next attempt and then calls publish_plan", async () => {
    const failed = scripted({ fail: true });
    await expect(
      connectSession({
        builder: failed.builder,
        uri: "http://127.0.0.1:3000",
        database: "dibs-i2-test",
        token: "t",
        participant: "claude",
        provider: "claude",
        lobbyId: 3,
        buildHash: "abc",
        log: () => undefined,
      }),
    ).rejects.toThrow(/refused/);

    const ok = scripted();
    const session = await connectSession({
      builder: ok.builder,
      uri: "http://127.0.0.1:3000",
      database: "dibs-i2-test",
      token: "t",
      participant: "claude",
      provider: "claude",
      lobbyId: 3,
      buildHash: "abc",
      log: () => undefined,
    });
    expect(ok.queries[0]).toContain("SELECT * FROM participant");
    expect(
      ok.queries[1]?.some((query) => query.includes("target_id = 1")),
    ).toBe(true);
    const store = new RemoteStore(session, 1000);
    const published = await store.publishPlan(
      {
        goal: "login",
        produces: [{ key: "auth.session", statement: "cookie" }],
        requires: [],
      },
      "req-1",
    );
    expect(published).toMatchObject({
      status: "ok",
      result: { planId: 9, revision: 1 },
    });
    session.close();
  });

  it("keeps subscriptions across an automatic reconnect and rebuilds after the grace period", async () => {
    const live = scripted({ automatic: true });
    const session = await connectSession({
      builder: live.builder,
      uri: "http://127.0.0.1:3000",
      database: "dibs-i2-test",
      token: "t",
      participant: "claude",
      provider: "claude",
      lobbyId: 3,
      buildHash: "abc",
      reconnectGraceMs: 40,
      log: () => undefined,
    });
    const subscribed = live.queries.length;
    live.disconnect();
    live.reconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(live.queries.length).toBe(subscribed);
    expect(session.world().online).toBe(true);
    live.disconnect();
    await Promise.race([
      session.closed,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("connection was not rebuilt")), 500),
      ),
    ]);
    session.close();
  });

  it("reports a timed-out reducer as pending", async () => {
    const hanging = scripted({ hangPlan: true });
    const session = await connectSession({
      builder: hanging.builder,
      uri: "http://127.0.0.1:3000",
      database: "dibs-i2-test",
      token: "t",
      participant: "claude",
      provider: "claude",
      lobbyId: 3,
      buildHash: "abc",
      log: () => undefined,
    });
    const result = await new RemoteStore(session, 30).publishPlan(
      { goal: "g", produces: [], requires: [] },
      "slow",
    );
    expect(result.status).toBe("pending");
    session.close();
  });
});

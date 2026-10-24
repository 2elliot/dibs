import { afterEach, expect, test, vi } from "vitest";
import { Identity } from "spacetimedb";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { call, toJson, type DbConnection } from "../src/index.ts";
import {
  dibsHome,
  participantDir,
  readConfig,
  readToken,
  saveConfig,
  saveToken,
} from "../src/node.ts";

const originalHome = process.env.DIBS_HOME;
afterEach(() => {
  vi.useRealTimers();
  if (originalHome === undefined) delete process.env.DIBS_HOME;
  else process.env.DIBS_HOME = originalHome;
});
function connection(fn: (args: unknown) => Promise<void>, isActive = true) {
  return { isActive, reducers: { claimInvite: fn } } as unknown as DbConnection;
}
test("call distinguishes success, rejected reducers and offline connections", async () => {
  expect(
    await call(
      connection(async () => {}),
      "claimInvite",
      { code: "x" },
    ),
  ).toEqual({ status: "ok" });
  const spy = vi.fn(async () => {});
  expect(
    (await call(connection(spy, false), "claimInvite", { code: "x" })).status,
  ).toBe("offline");
  expect(spy).not.toHaveBeenCalled();
  expect(
    await call(
      connection(async () => {
        throw new Error("invalid invite");
      }),
      "claimInvite",
      { code: "x" },
    ),
  ).toEqual({ status: "error", error: "invalid invite" });
});
test("a timeout and an unknown call result are pending, and late completion is safely handled", async () => {
  vi.useFakeTimers();
  let resolve!: () => void;
  const result = call(
    connection(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    ),
    "claimInvite",
    { code: "x" },
    { timeoutMs: 10 },
  );
  await vi.advanceTimersByTimeAsync(10);
  expect((await result).status).toBe("pending");
  resolve();
  const error = new Error("lost reply");
  error.name = "UnknownCallResultError";
  expect(
    (
      await call(
        connection(async () => {
          throw error;
        }),
        "claimInvite",
        { code: "x" },
      )
    ).status,
  ).toBe("pending");
});
test("JSON conversion handles nested bigint, identity, both option shapes and rejects silent integer corruption", () => {
  const identity = Identity.fromString("a".repeat(64));
  const row = {
    atUs: 1792835421381855n,
    identity,
    missing: undefined,
    nullable: null,
    none: { tag: "None" },
    some: { tag: "Some", value: 42n },
    nested: [1n, { x: undefined }],
  };
  const converted = toJson(row);
  expect(converted).toEqual({
    atUs: 1792835421381855,
    identity: "a".repeat(64),
    missing: null,
    nullable: null,
    none: null,
    some: 42,
    nested: [1, { x: null }],
  });
  expect(() => JSON.stringify(converted)).not.toThrow();
  expect(toJson({ tag: "some", value: 9n })).toBe(9);
  expect(toJson({ tag: "none" })).toBe(null);
  expect(() => toJson(9007199254740993n)).toThrow(RangeError);
});
test("Node helpers isolate participant tokens and honor DIBS_HOME without path traversal", async () => {
  const home = await mkdtemp(join(tmpdir(), "dibs-client-test-"));
  process.env.DIBS_HOME = home;
  expect(dibsHome()).toBe(home);
  expect(() => participantDir("../other")).toThrow();
  await saveConfig({ dbUri: "http://127.0.0.1:3000", dbName: "dibs-i1-test" });
  await saveToken("claude", "test-only-token-a");
  await saveToken("codex", "test-only-token-b");
  expect(await readConfig()).toEqual({
    dbUri: "http://127.0.0.1:3000",
    dbName: "dibs-i1-test",
  });
  expect(await readToken("claude")).toBe("test-only-token-a");
  expect(await readToken("codex")).toBe("test-only-token-b");
  expect(await readToken("droid")).toBeUndefined();
  expect(await readFile(join(home, "claude", "token"), "utf8")).toBe(
    "test-only-token-a\n",
  );
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { syncOnce, type SyncState } from "../src/inbox.ts";
import { MemoryStore } from "../src/memory.ts";
import { acquireLock, pidAlive } from "../src/home.ts";

function temp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dibs-mem-"));
}

describe("memory store and inbox", () => {
  it("publishes, deduplicates a request, and agrees a contract", async () => {
    const store = new MemoryStore({
      participant: "claude",
      provider: "claude",
      lobbyId: 3,
      mode: "dibs",
    });
    await store.connect();
    const codex = store.addPeer("codex");
    const first = await store.publishPlan(
      {
        goal: "login",
        produces: [{ key: "auth.session", statement: "set a cookie" }],
        requires: [],
      },
      "plan-1",
    );
    const again = await store.publishPlan(
      {
        goal: "login",
        produces: [{ key: "auth.session", statement: "set a cookie" }],
        requires: [],
      },
      "plan-1",
    );
    expect(again).toEqual(first);
    const changed = await store.publishPlan(
      {
        goal: "login",
        produces: [{ key: "auth.session", statement: "set a bearer token" }],
        requires: [],
      },
      "plan-1",
    );
    expect(changed.status).toBe("error");
    const proposal = store.openProposal({
      key: "auth.session",
      contractText: "set a cookie",
      requiredPartyIds: [store.world().meId ?? 0, codex],
    });
    const mine = await store.respond(
      { proposalId: proposal.id, revision: 1, decision: "accept", reason: "" },
      "resp-1",
    );
    expect(mine).toMatchObject({
      status: "ok",
      result: { proposalState: "proposed" },
    });
    expect(store.world().contracts).toHaveLength(0);
    const unknown = await store.publishPlan(
      {
        goal: "x",
        produces: [{ key: "nope", statement: "nope" }],
        requires: [],
      },
      "plan-2",
    );
    expect(unknown).toMatchObject({ status: "error" });
  });

  it("rejects messages in none mode and creates no job", async () => {
    const store = new MemoryStore({
      participant: "claude",
      provider: "claude",
      lobbyId: 1,
      mode: "none",
    });
    await store.connect();
    store.addPeer("codex");
    await store.publishPlan(
      {
        goal: "login",
        produces: [{ key: "auth.session", statement: "cookie" }],
        requires: [],
      },
      "p",
    );
    expect(store.world().job).toBeNull();
    const message = await store.sendMessage("codex", "hello", "m");
    expect(message.status).toBe("error");
  });

  it("escalates the second rejection", async () => {
    const store = new MemoryStore({
      participant: "claude",
      provider: "claude",
      lobbyId: 3,
      mode: "dibs",
    });
    await store.connect();
    await store.publishPlan(
      {
        goal: "login",
        produces: [{ key: "auth.session", statement: "cookie" }],
        requires: [],
      },
      "p",
    );
    const first = store.openProposal({
      key: "auth.session",
      contractText: "cookie",
    });
    await store.respond(
      { proposalId: first.id, revision: 1, decision: "reject", reason: "no" },
      "r1",
    );
    expect(store.world().proposals[0]?.state).toBe("rejected");
    const second = store.openProposal({
      key: "auth.session",
      contractText: "cookie again",
      revision: 2,
    });
    await store.respond(
      {
        proposalId: second.id,
        revision: 2,
        decision: "reject",
        reason: "still no",
      },
      "r2",
    );
    expect(
      store.world().proposals.find((row) => row.id === second.id)?.state,
    ).toBe("escalated");
  });

  it("writes an inbox file once, sweeps a stale claim, and rewrites a lost delivery", async () => {
    const home = temp();
    const dir = path.join(home, "claude");
    fs.mkdirSync(dir, { recursive: true });
    const store = new MemoryStore({
      participant: "claude",
      provider: "claude",
      lobbyId: 3,
      mode: "dibs",
      nowUs: () => 1_000_000,
    });
    await store.connect();
    const delivery = store.debugDeliver(
      "notice",
      "use port 4001 for any server",
    );
    const state: SyncState = { marking: new Set() };
    syncOnce(dir, store, state, Date.now());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const file = path.join(dir, "inbox", `${delivery.id}.json`);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).summary).toContain("4001");
    expect(store.world().deliveries[0]?.stage).toBe("received");
    fs.rmSync(file);
    syncOnce(dir, store, state, Date.now());
    expect(fs.existsSync(file)).toBe(true);
    const claimed = path.join(dir, "claimed");
    fs.mkdirSync(claimed, { recursive: true });
    const stale = path.join(claimed, `${delivery.id}.json`);
    fs.renameSync(file, stale);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(stale, old, old);
    syncOnce(dir, store, state, Date.now());
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(dir, "hook-status.json"))).toBe(true);
  });

  it("takes over a dead lock and leaves a live one alone", () => {
    const dir = temp();
    const dead = acquireLock(dir, "claude");
    expect(dead.ok).toBe(true);
    if (dead.ok) dead.release();
    fs.writeFileSync(
      path.join(dir, "bridge.lock"),
      JSON.stringify({
        pid: 2_000_000_000,
        participant: "claude",
        startedAtUs: 1,
      }),
    );
    expect(pidAlive(2_000_000_000)).toBe(false);
    const taken = acquireLock(dir, "claude");
    expect(taken.ok).toBe(true);
    if (taken.ok) taken.release();
    const holder = spawnHolder();
    fs.writeFileSync(
      path.join(dir, "bridge.lock"),
      JSON.stringify({
        pid: holder.pid,
        participant: "claude",
        startedAtUs: 1,
      }),
    );
    const refused = acquireLock(dir, "claude");
    expect(refused).toEqual({ ok: false, holder: holder.pid });
    holder.kill();
  });
});

function spawnHolder(): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  if (!child.pid) throw new Error("no pid");
  return { pid: child.pid, kill: () => child.kill() };
}

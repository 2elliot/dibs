import { afterEach, describe, it, expect, vi } from "vitest";
import { TIMING, type Findings } from "@dibs/protocol";
import { WorkerLoop } from "../src/worker/loop.ts";
import { FakeDb } from "../src/worker/fake-db.ts";
import { FakeModelClient } from "../src/model/fake.ts";
import type { ModelClient } from "../src/model/types.ts";
import { HealthState } from "../src/http/health.ts";
import { loadFixture } from "./helpers.ts";
import type { LeasableJob } from "../src/worker/db.ts";

function jobFor(input: ReturnType<typeof loadFixture>): LeasableJob {
  return {
    jobId: input.jobId,
    lobbyId: input.lobbyId,
    kind: input.jobKind,
    inputKey: input.inputKey,
    enqueuedAtMs: Date.now(),
  };
}

const futureFallbackUs = (Date.now() + 600_000) * 1000;

function makeLoop(db: FakeDb, model: ModelClient) {
  return new WorkerLoop({
    db,
    model,
    health: new HealthState(),
    log: () => {},
  });
}

/** A model whose calls stay open until the test releases them, in call order. */
function gatedModel(findings: Findings) {
  const release: (() => void)[] = [];
  const model: ModelClient = {
    name: "gated",
    analyze: () =>
      new Promise((resolve) =>
        release.push(() =>
          resolve({
            findings,
            usage: { inputTokens: 0, outputTokens: 0 },
            latencyMs: 0,
            model: "gated",
          }),
        ),
      ),
  };
  return { model, release };
}

/** Let every pending promise settle without moving the fake clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("WorkerLoop.tick", () => {
  it("leases a queued job and submits the validated findings", async () => {
    const input = loadFixture("bearer-vs-cookie");
    const db = new FakeDb();
    db.stage(jobFor(input), input, futureFallbackUs);
    const model = FakeModelClient.fromFindings(input.recordedFindings);

    await makeLoop(db, model).tick();

    expect(db.leaseCalls).toHaveLength(1);
    expect(db.submitCalls).toHaveLength(1);
    expect(db.submitCalls[0].inputKey).toBe(input.inputKey);
    expect(db.submitCalls[0].findings.findings[0].key).toBe("auth.session");
    expect(db.failCalls).toHaveLength(0);
  });

  it("fails the job when the model errors (and fallback is too close to retry)", async () => {
    const input = loadFixture("compatible");
    const model = FakeModelClient.fromFindings(input.recordedFindings);
    model.failNext(new Error("boom"));

    const db = new FakeDb();
    db.stage(jobFor(input), input, (Date.now() + 5_000) * 1000); // 5 s left < 90 s window
    await makeLoop(db, model).tick();

    expect(db.failCalls).toHaveLength(1);
    expect(db.submitCalls).toHaveLength(0);
  });

  it("does not submit when the job is no longer leasable", async () => {
    const input = loadFixture("compatible");
    const db = new FakeDb();
    db.stage(jobFor(input), input, futureFallbackUs);
    db.unleasable.add(input.jobId);
    const model = FakeModelClient.fromFindings(input.recordedFindings);

    await makeLoop(db, model).tick();

    expect(db.leaseCalls).toHaveLength(1);
    expect(db.submitCalls).toHaveLength(0);
  });

  it("heartbeats through beat()", async () => {
    const db = new FakeDb();
    const loop = makeLoop(db, new FakeModelClient());
    loop.start();
    loop.stop();
    // start() fires one immediate beat.
    await new Promise((r) => setTimeout(r, 10));
    expect(db.heartbeats.map((h) => h.name)).toEqual(["worker"]);
  });
});

describe("WorkerLoop.start", () => {
  afterEach(() => vi.useRealTimers());

  it("leases a queued job on sight instead of waiting for the rescan", async () => {
    vi.useFakeTimers();
    const input = loadFixture("bearer-vs-cookie");
    const db = new FakeDb();
    const loop = makeLoop(
      db,
      FakeModelClient.fromFindings(input.recordedFindings),
    );
    loop.start();
    await settle();
    expect(db.leaseCalls).toHaveLength(0);

    const queuedAt = Date.now();
    db.queue(jobFor(input), input, futureFallbackUs);
    await settle();

    expect(db.leaseCalls).toHaveLength(1);
    expect(db.submitCalls).toHaveLength(1);
    expect(Date.now()).toBe(queuedAt); // no timer fired: the queued row alone triggered the lease

    loop.stop();
    db.queue({ ...jobFor(input), jobId: input.jobId + 1 }, input, 0);
    await settle();
    expect(db.leaseCalls).toHaveLength(1); // stop() removed the listener
  });

  it("still rescans every leaseRescanSec for jobs no row change announces", async () => {
    vi.useFakeTimers();
    const input = loadFixture("bearer-vs-cookie");
    const db = new FakeDb();
    const loop = makeLoop(
      db,
      FakeModelClient.fromFindings(input.recordedFindings),
    );
    loop.start();
    await settle();
    // An expired lease changes no row, so nothing announces it.
    db.stage(jobFor(input), input, futureFallbackUs);

    await vi.advanceTimersByTimeAsync(TIMING.leaseRescanSec * 1000 - 1);
    expect(db.leaseCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.leaseCalls).toHaveLength(1);
    expect(db.submitCalls).toHaveLength(1);
    loop.stop();
  });

  it("keeps one call per lobby without holding up other lobbies, and leases a re-queued job when its lobby frees", async () => {
    vi.useFakeTimers();
    const input = loadFixture("bearer-vs-cookie");
    const { model, release } = gatedModel(input.recordedFindings);
    const db = new FakeDb();
    const loop = makeLoop(db, model);
    loop.start();
    await settle();
    const start = Date.now();
    const lobbyOne = jobFor(input);
    const lobbyTwo = {
      ...lobbyOne,
      jobId: lobbyOne.jobId + 1,
      lobbyId: lobbyOne.lobbyId + 1,
    };

    db.queue(lobbyOne, input, futureFallbackUs);
    await settle();
    expect(db.leaseCalls.map((c) => c.jobId)).toEqual([lobbyOne.jobId]);

    // The module re-queues lobby one's job while its analysis is still running.
    db.queue(
      { ...lobbyOne, inputKey: `${lobbyOne.inputKey}:2` },
      input,
      futureFallbackUs,
    );
    await settle();
    expect(db.leaseCalls).toHaveLength(1);

    db.queue(lobbyTwo, input, futureFallbackUs);
    await settle();
    expect(db.leaseCalls.map((c) => c.jobId)).toEqual([
      lobbyOne.jobId,
      lobbyTwo.jobId,
    ]);
    expect(release).toHaveLength(2);

    release[0]();
    await settle();
    expect(db.submitCalls.map((c) => c.jobId)).toEqual([lobbyOne.jobId]);
    expect(db.leaseCalls.map((c) => c.jobId)).toEqual([
      lobbyOne.jobId,
      lobbyTwo.jobId,
      lobbyOne.jobId,
    ]);
    expect(release).toHaveLength(3);

    release[1]();
    release[2]();
    await settle();
    expect(db.submitCalls).toHaveLength(3);
    expect(Date.now()).toBe(start);
    loop.stop();
  });

  it("never runs two scans at once when events and the timer arrive together", async () => {
    vi.useFakeTimers();
    const input = loadFixture("bearer-vs-cookie");
    const db = new FakeDb();
    const nextLeasableJob = db.nextLeasableJob.bind(db);
    let active = 0;
    let maxActive = 0;
    let scans = 0;
    vi.spyOn(db, "nextLeasableJob").mockImplementation(async (excluded) => {
      scans++;
      maxActive = Math.max(maxActive, ++active);
      await new Promise((r) => setTimeout(r, 100)); // a slow read
      active--;
      return nextLeasableJob(excluded);
    });
    const loop = new WorkerLoop({
      db,
      model: new FakeModelClient({ resolver: () => input.recordedFindings }),
      health: new HealthState(),
      log: () => {},
      pollMs: 150,
    });
    loop.start(); // the first scan is now in its slow read
    const jobs = [0, 1, 2].map((i) => ({
      ...jobFor(input),
      jobId: input.jobId + i,
      lobbyId: input.lobbyId + i,
    }));
    for (const job of jobs) db.queue(job, input, futureFallbackUs);

    await vi.advanceTimersByTimeAsync(1_000);
    loop.stop();

    expect(maxActive).toBe(1);
    expect(db.leaseCalls.map((c) => c.jobId).sort()).toEqual(
      jobs.map((j) => j.jobId).sort(),
    );
    expect(db.submitCalls).toHaveLength(3);
    // One pass for start(), one for the burst of events, and one per 150 ms rescan after that.
    expect(scans).toBeLessThan(20);
  });

  it("retries a heartbeat that failed for another reason on the next beat", async () => {
    vi.useFakeTimers();
    const db = new FakeDb();
    const heartbeat = db.heartbeat.bind(db);
    let down = true;
    vi.spyOn(db, "heartbeat").mockImplementation(async (name, detail) => {
      if (down) throw new Error("database disconnected");
      return heartbeat(name, detail);
    });
    const loop = makeLoop(db, new FakeModelClient());
    loop.start();
    await settle();
    expect(db.heartbeats).toHaveLength(0);
    down = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(db.heartbeats.map((h) => h.name)).toEqual(["worker"]);
    loop.stop();
  });
});

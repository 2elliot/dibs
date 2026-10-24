import { describe, it, expect } from "vitest";
import { WorkerLoop } from "../src/worker/loop.ts";
import { FakeDb } from "../src/worker/fake-db.ts";
import { FakeModelClient } from "../src/model/fake.ts";
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

function makeLoop(db: FakeDb, model: FakeModelClient) {
  return new WorkerLoop({
    db,
    model,
    health: new HealthState(),
    log: () => {},
  });
}

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
    expect(db.heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(db.heartbeats[0].name).toBe("worker");
  });
});

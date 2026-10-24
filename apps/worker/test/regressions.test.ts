import { afterEach, describe, expect, it, vi } from "vitest";
import type { Findings } from "@dibs/protocol";
import { TIMING } from "@dibs/protocol";
import { runAnalysis, runAnalysisWithRetry } from "../src/analysis/analyze.ts";
import { buildAnalysisRequest } from "../src/analysis/prompt.ts";
import { validateFindings } from "../src/analysis/validate.ts";
import { HealthState } from "../src/http/health.ts";
import { FakeModelClient } from "../src/model/fake.ts";
import type { ModelClient, ModelResult } from "../src/model/types.ts";
import { FakeDb } from "../src/worker/fake-db.ts";
import { WorkerLoop, LEASE_RESERVE_MS } from "../src/worker/loop.ts";
import { loadConfig, publicConfig } from "../src/config.ts";
import { connectWithRetry } from "../src/worker/connect.ts";
import { loadFixture } from "./helpers.ts";

afterEach(() => vi.useRealTimers());
const input = loadFixture("bearer-vs-cookie");
function result(findings: Findings): ModelResult {
  return {
    findings,
    usage: { inputTokens: 0, outputTokens: 0 },
    latencyMs: 0,
    model: "test",
  };
}
function stage(db: FakeDb) {
  db.stage(
    {
      jobId: input.jobId,
      lobbyId: input.lobbyId,
      kind: input.jobKind,
      inputKey: input.inputKey,
      enqueuedAtMs: Date.now(),
    },
    input,
    (Date.now() + 600_000) * 1000,
  );
}

describe("worker regression coverage", () => {
  it("rechecks remaining fallback time after the first call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let calls = 0;
    const model: ModelClient = {
      name: "test",
      analyze: async () => {
        calls++;
        vi.setSystemTime(1_090_000);
        throw new Error("first failure");
      },
    };
    await expect(
      runAnalysisWithRetry(input, model, {
        now: Date.now,
        fallbackAtUs: 1_110_000_000,
      }),
    ).rejects.toThrow("first failure");
    expect(calls).toBe(1);
  });

  it("aborts a hung call and records fail_job before the lease expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const db = new FakeDb();
    stage(db);
    let signal: AbortSignal | undefined;
    const model: ModelClient = {
      name: "hung",
      analyze: async (_req, opts) => {
        signal = opts.signal;
        return new Promise(() => {});
      },
    };
    const pending = new WorkerLoop({
      db,
      model,
      health: new HealthState(),
      log: () => {},
    }).tick();
    await vi.advanceTimersByTimeAsync(
      TIMING.leaseSec * 1000 - LEASE_RESERVE_MS,
    );
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(db.failCalls).toHaveLength(1);
    expect(db.submitCalls).toHaveLength(0);
    expect(Date.now()).toBeLessThan(1_000_000 + TIMING.leaseSec * 1000);
  });

  it("shares the lease deadline across retries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const timeouts: number[] = [];
    const model: ModelClient = {
      name: "test",
      analyze: async (_req, opts) => {
        timeouts.push(opts.timeoutMs);
        if (timeouts.length === 1) {
          vi.setSystemTime(1_020_000);
          throw new Error("temporary");
        }
        return result(input.recordedFindings);
      },
    };
    const outcome = await runAnalysisWithRetry(
      input,
      model,
      { now: Date.now, fallbackAtUs: 1_600_000_000 },
      { deadlineMs: 1_054_000 },
    );
    expect(outcome.attempts).toBe(2);
    expect(timeouts).toEqual([54_000, 34_000]);
  });

  it.each([{}, { findings: null }, { findings: [{ key: "auth.session" }] }])(
    "rejects malformed findings %j",
    async (bad) => {
      const model: ModelClient = {
        name: "test",
        analyze: async () => result(bad as Findings),
      };
      await expect(runAnalysis(input, model)).rejects.toThrow(/invalid model/);
    },
  );

  it("fails invalid citations instead of marking analysis complete", async () => {
    const bad = structuredClone(input.recordedFindings);
    bad.findings[0].citedItemIds = [99999];
    const db = new FakeDb();
    stage(db);
    await new WorkerLoop({
      db,
      model: new FakeModelClient({ resolver: () => bad }),
      health: new HealthState(),
      log: () => {},
    }).tick();
    expect(db.submitCalls).toHaveLength(0);
    expect(db.failCalls).toHaveLength(1);
  });

  it("rejects citations belonging to another key", () => {
    const bad = structuredClone(input.recordedFindings);
    bad.findings[0].citedItemIds = [
      input.items.find((i) => i.key !== bad.findings[0].key)!.id,
    ];
    const validation = validateFindings(bad, input);
    expect(validation.kept).toHaveLength(0);
    expect(validation.dropped[0].reason).toContain("wrong-key");
  });

  it("includes a single consumer's unowned requirement in analysis", () => {
    const request = buildAnalysisRequest(loadFixture("unowned"));
    const keys = request.user
      .split("# Keys to analyze")[1]
      .split("# Existing")[0];
    expect(keys).toContain("- events.registration");
    expect(request.system).toContain("even if only one participant touches it");
  });

  it("retries initial database failures until connection succeeds", async () => {
    const health = new HealthState();
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValue("db");
    const pending = connectWithRetry(connect, health, undefined, () => {});
    await expect(pending).resolves.toBe("db");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(health.report().db).toBe("connected");
  });

  it("contains unexpected reducer errors rather than rejecting the timer tick", async () => {
    const db = new FakeDb();
    stage(db);
    vi.spyOn(db, "submitAnalysis").mockRejectedValue(
      new Error("stale inputKey"),
    );
    const log = vi.fn();
    await expect(
      new WorkerLoop({
        db,
        model: FakeModelClient.fromFindings(input.recordedFindings),
        health: new HealthState(),
        log,
      }).tick(),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "job processing failed",
      expect.objectContaining({
        error: expect.stringContaining("stale inputKey"),
      }),
    );
  });

  it("publishes dashboard aliases and the configured lobby without secrets", () => {
    const config = loadConfig({
      SPACETIME_URI: "https://example.com",
      SPACETIME_DB: "dibs-dev",
      SPACETIME_TOKEN: "secret",
      ANTHROPIC_API_KEY: "secret",
      DIBS_LOBBY_ID: "7",
    });
    expect(publicConfig(config)).toEqual({
      dbUri: "https://example.com",
      dbName: "dibs-dev",
      uri: "https://example.com",
      db: "dibs-dev",
      lobby: 7,
    });
    expect(config.anthropicModel).toBe("claude-sonnet-4-6");
    expect(() => loadConfig({ DIBS_LOBBY_ID: "0" })).toThrow(
      "positive integer",
    );
  });
});

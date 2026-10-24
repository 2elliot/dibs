import { describe, it, expect } from "vitest";
import { runAnalysis, runAnalysisWithRetry } from "../src/analysis/analyze.ts";
import { FakeModelClient } from "../src/model/fake.ts";
import { loadFixture } from "./helpers.ts";

describe("runAnalysis", () => {
  it("calls the model and validates the result", async () => {
    const input = loadFixture("bearer-vs-cookie");
    const model = FakeModelClient.fromFindings(input.recordedFindings);
    const outcome = await runAnalysis(input, model);
    expect(outcome.attempts).toBe(1);
    expect(outcome.kept).toHaveLength(1);
    expect(outcome.kept[0].key).toBe("auth.session");
    expect(model.calls).toHaveLength(1);
  });
});

describe("runAnalysisWithRetry", () => {
  const input = loadFixture("compatible");

  it("retries once when a full window still fits before fallback", async () => {
    const model = new FakeModelClient({
      recordings: [{ findings: input.recordedFindings }],
    });
    model.failNext(new Error("timeout"));
    const nowMs = 1_000_000;
    const fallbackAtUs = (nowMs + 200_000) * 1000; // 200 s left > 90 s window
    const outcome = await runAnalysisWithRetry(input, model, {
      now: () => nowMs,
      fallbackAtUs,
    });
    expect(outcome.attempts).toBe(2);
    expect(outcome.kept).toHaveLength(1);
  });

  it("does not retry when there is not enough time before fallback", async () => {
    const model = FakeModelClient.fromFindings(input.recordedFindings);
    model.failNext(new Error("timeout"));
    const nowMs = 1_000_000;
    const fallbackAtUs = (nowMs + 10_000) * 1000; // only 10 s left < 90 s window
    await expect(
      runAnalysisWithRetry(input, model, { now: () => nowMs, fallbackAtUs }),
    ).rejects.toThrow("timeout");
    expect(model.calls).toHaveLength(1);
  });

  it("does not retry when the caller aborted", async () => {
    const model = FakeModelClient.fromFindings(input.recordedFindings);
    model.failNext(new Error("aborted"));
    const controller = new AbortController();
    controller.abort();
    const nowMs = 1_000_000;
    const fallbackAtUs = (nowMs + 999_000) * 1000;
    await expect(
      runAnalysisWithRetry(
        input,
        model,
        { now: () => nowMs, fallbackAtUs },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(model.calls).toHaveLength(0);
  });
});

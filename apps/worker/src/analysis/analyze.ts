import { TIMING } from "@dibs/protocol";
import type { AnalysisInput, Finding, Findings } from "@dibs/protocol";
import type { ModelClient, ModelUsage } from "../model/types.ts";
import { buildAnalysisRequest } from "./prompt.ts";
import {
  InvalidFindingsError,
  validateFindings,
  type DroppedFinding,
  type RepairedFinding,
} from "./validate.ts";

export interface AnalysisOutcome {
  kept: Finding[];
  dropped: DroppedFinding[];
  repaired: RepairedFinding[];
  raw: Findings;
  usage: ModelUsage;
  latencyMs: number;
  model: string;
  attempts: number;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** A job-wide deadline, including retries, reserved inside the database lease. */
  deadlineMs?: number;
  now?: () => number;
}

export async function runAnalysis(
  input: AnalysisInput,
  model: ModelClient,
  opts: RunOptions = {},
): Promise<AnalysisOutcome> {
  const now = opts.now ?? Date.now;
  const timeoutMs = Math.min(
    opts.timeoutMs ?? TIMING.analysisTimeoutSec * 1000,
    opts.deadlineMs === undefined ? Infinity : opts.deadlineMs - now(),
  );
  if (timeoutMs <= 0) throw new Error("analysis lease budget exhausted");
  if (opts.signal?.aborted) throw new Error("analysis aborted");

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      controller.abort();
      reject(new Error("analysis aborted"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("analysis timed out"));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([
      model.analyze(buildAnalysisRequest(input), {
        timeoutMs,
        signal: controller.signal,
      }),
      interrupted,
    ]);
    const { kept, dropped, repaired } = validateFindings(
      result.findings,
      input,
    );
    // Submit whatever is valid. Only output with findings but none usable fails (and is retried):
    // submitting it empty would turn every key "clear", while fail_job sends overlap notices.
    const invalid = dropped.filter((d) => !d.ignored);
    if (invalid.length && !kept.length) {
      throw new InvalidFindingsError(
        "invalid model findings: " + invalid.map((d) => d.reason).join("; "),
      );
    }
    return {
      kept,
      dropped,
      repaired,
      raw: result.findings,
      usage: result.usage,
      latencyMs: result.latencyMs,
      model: result.model,
      attempts: 1,
    };
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
  }
}

export interface RetryClock {
  now: () => number;
  fallbackAtUs: number;
}

export async function runAnalysisWithRetry(
  input: AnalysisInput,
  model: ModelClient,
  clock: RetryClock,
  opts: RunOptions = {},
): Promise<AnalysisOutcome> {
  const runOpts = { ...opts, now: clock.now };
  try {
    return await runAnalysis(input, model, runOpts);
  } catch (firstError) {
    if (opts.signal?.aborted) throw firstError;
    const now = clock.now();
    if (clock.fallbackAtUs / 1000 - now < TIMING.analysisTimeoutSec * 1000)
      throw firstError;
    if (opts.deadlineMs !== undefined && opts.deadlineMs <= now)
      throw firstError;
    const outcome = await runAnalysis(input, model, runOpts);
    return { ...outcome, attempts: 2 };
  }
}

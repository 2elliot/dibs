// Orchestrates one analysis: build the request, call the model with a timeout, validate the result.
// The retry policy (one retry only if 90 s remain before the lobby's fallback) lives here too, as a
// pure function of the clock, so it's testable without the DB.
import { TIMING } from "@dibs/protocol";
import type { AnalysisInput, Finding, Findings } from "@dibs/protocol";
import type { ModelClient, ModelUsage } from "../model/types.ts";
import { buildAnalysisRequest } from "./prompt.ts";
import { validateFindings } from "./validate.ts";
import type { DroppedFinding } from "./validate.ts";

export interface AnalysisOutcome {
  /** The findings that passed local validation; what submit_analysis gets. */
  kept: Finding[];
  dropped: DroppedFinding[];
  raw: Findings;
  usage: ModelUsage;
  latencyMs: number;
  model: string;
  attempts: number;
}

export interface RunOptions {
  /** Defaults to TIMING.analysisTimeoutSec. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** One model call + validation. No retry; see runAnalysisWithRetry for the budgeted retry. */
export async function runAnalysis(
  input: AnalysisInput,
  model: ModelClient,
  opts: RunOptions = {},
): Promise<AnalysisOutcome> {
  const timeoutMs = opts.timeoutMs ?? TIMING.analysisTimeoutSec * 1000;
  const req = buildAnalysisRequest(input);
  const result = await model.analyze(req, { timeoutMs, signal: opts.signal });
  const { kept, dropped } = validateFindings(result.findings, input);
  return {
    kept,
    dropped,
    raw: result.findings,
    usage: result.usage,
    latencyMs: result.latencyMs,
    model: result.model,
    attempts: 1,
  };
}

export interface RetryClock {
  /** Date.now()-style milliseconds. */
  nowMs: number;
  /** The lobby's fallback time, in microseconds (the `fallbackAtUs` column). */
  fallbackAtUs: number;
}

/**
 * Retry once, but only if a full analysis window (timeout) still fits before the fallback — this is
 * the plan's "one retry only if 90 s remain before fallbackAtUs". A retry is never attempted when
 * the model call was aborted by the caller's signal.
 */
export async function runAnalysisWithRetry(
  input: AnalysisInput,
  model: ModelClient,
  clock: RetryClock,
  opts: RunOptions = {},
): Promise<AnalysisOutcome> {
  const timeoutMs = opts.timeoutMs ?? TIMING.analysisTimeoutSec * 1000;
  try {
    return await runAnalysis(input, model, { ...opts, timeoutMs });
  } catch (firstError) {
    if (opts.signal?.aborted) throw firstError;
    const fallbackAtMs = clock.fallbackAtUs / 1000;
    const msLeft = fallbackAtMs - clock.nowMs;
    if (msLeft < timeoutMs) throw firstError;
    const outcome = await runAnalysis(input, model, { ...opts, timeoutMs });
    return { ...outcome, attempts: 2 };
  }
}

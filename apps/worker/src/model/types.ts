// The model lives behind this interface so the worker is testable without a key: the fake replays
// recorded responses, the real client talks to Anthropic. The prompt builder produces an
// AnalysisRequest; the client returns raw Findings (validation happens afterwards, in analysis/).
import type { Findings } from "@dibs/protocol";

export interface AnalysisRequest {
  system: string;
  user: string;
  /** JSON Schema the model must fill (protocol FINDINGS_SCHEMA). */
  schema: object;
  maxTokens: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResult {
  /** As returned by the model, before local validation. */
  findings: Findings;
  usage: ModelUsage;
  latencyMs: number;
  model: string;
}

export interface ModelCallOptions {
  timeoutMs: number;
  /** Caller-side cancellation, in addition to the timeout. */
  signal?: AbortSignal;
}

export interface ModelClient {
  readonly name: string;
  analyze(req: AnalysisRequest, opts: ModelCallOptions): Promise<ModelResult>;
}

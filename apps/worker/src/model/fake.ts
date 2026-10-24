// A model client that replays recorded responses instead of calling Anthropic. Used by every test
// (this machine has no ANTHROPIC_API_KEY) and by `npm run analyze -- --fake`. Two ways to drive it:
//   - recordings: returned in order, one per call (queue);
//   - resolver:   compute Findings from the request (e.g. match a fixture).
import type { Findings } from "@dibs/protocol";
import type {
  AnalysisRequest,
  ModelCallOptions,
  ModelClient,
  ModelResult,
  ModelUsage,
} from "./types.ts";

export interface Recording {
  findings: Findings;
  latencyMs?: number;
  usage?: ModelUsage;
}

export type FakeResolver = (req: AnalysisRequest) => Findings;

export interface FakeInit {
  recordings?: Recording[];
  resolver?: FakeResolver;
  /** Set to make the next call reject, to exercise the fail_job path. */
  throwError?: Error;
}

export class FakeModelClient implements ModelClient {
  readonly name = "fake";
  /** Every request the worker made, for assertions. */
  readonly calls: AnalysisRequest[] = [];
  private readonly queue: Recording[];
  private readonly resolver?: FakeResolver;
  private throwError?: Error;

  constructor(init: FakeInit = {}) {
    this.queue = init.recordings ? [...init.recordings] : [];
    this.resolver = init.resolver;
    this.throwError = init.throwError;
  }

  static fromFindings(findings: Findings): FakeModelClient {
    return new FakeModelClient({ recordings: [{ findings }] });
  }

  /** Arm a one-shot error for the next analyze() call. */
  failNext(error: Error): void {
    this.throwError = error;
  }

  async analyze(
    req: AnalysisRequest,
    _opts: ModelCallOptions,
  ): Promise<ModelResult> {
    this.calls.push(req);
    if (this.throwError) {
      const e = this.throwError;
      this.throwError = undefined;
      throw e;
    }
    const rec: Recording | undefined = this.resolver
      ? { findings: this.resolver(req) }
      : this.queue.shift();
    if (!rec) {
      throw new Error("FakeModelClient: no recording left to replay");
    }
    return {
      findings: rec.findings,
      usage: rec.usage ?? { inputTokens: 0, outputTokens: 0 },
      latencyMs: rec.latencyMs ?? 0,
      model: "fake",
    };
  }
}

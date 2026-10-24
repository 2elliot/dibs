// The real model client. Streams a single forced-tool call so the model must return JSON matching
// FINDINGS_SCHEMA. Streaming lets a 90 s timeout abort a hung call; the tool_use block is the
// structured output. Never logs the prompt (only latency and token counts, by the caller).
import Anthropic from "@anthropic-ai/sdk";
import type { Findings } from "@dibs/protocol";
import type {
  AnalysisRequest,
  ModelCallOptions,
  ModelClient,
  ModelResult,
} from "./types.ts";

const TOOL_NAME = "report_findings";

export interface AnthropicClientOptions {
  apiKey: string;
  model: string;
}

export class AnthropicModelClient implements ModelClient {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: AnthropicClientOptions) {
    this.model = opts.model;
    this.name = `anthropic:${opts.model}`;
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 });
  }

  async analyze(
    req: AnalysisRequest,
    opts: ModelCallOptions,
  ): Promise<ModelResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    const onAbort = () => controller.abort();
    if (opts.signal?.aborted) controller.abort();
    else if (opts.signal)
      opts.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          tools: [
            {
              name: TOOL_NAME,
              strict: true,
              description:
                "Report the per-key analysis findings for this lobby.",
              // FINDINGS_SCHEMA is a plain closed JSON Schema; the SDK's InputSchema type is looser.
              input_schema: req.schema as Anthropic.Messages.Tool.InputSchema,
            },
          ],
          tool_choice: { type: "tool", name: TOOL_NAME },
        },
        { signal: controller.signal },
      );

      const final = await stream.finalMessage();
      const block = final.content.find((b) => b.type === "tool_use");
      if (!block || block.type !== "tool_use") {
        throw new Error("model returned no tool_use block");
      }
      return {
        findings: block.input as Findings,
        usage: {
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens,
        },
        latencyMs: Date.now() - started,
        model: this.model,
      };
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    }
  }
}

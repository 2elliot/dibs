// `dibs review --runner claude`: the same read-only, clause-by-clause review through the Anthropic
// API, for when the Droid SDK isn't available. The model can't open files, so the assembled code
// it reviews is sent in the prompt with line numbers (it never runs or edits anything). One forced
// tool call returns JSON in the REVIEW_SCHEMA shape, which reviewLobby validates before saving.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { REVIEW_SCHEMA } from "@dibs/protocol";
import type { ReviewInput, ReviewOutput, ReviewRunner } from "./review.ts";

const TOOL_NAME = "report_review";
/** The parts of the fixture the agents write, plus the frozen files they build against. */
const CODE_ROOTS = ["src", "public", "test"];
const MAX_CODE_CHARS = 80_000;
const TIMEOUT_MS = 120_000;

export const reviewModel = () =>
  process.env.DIBS_REVIEW_MODEL ??
  process.env.ANTHROPIC_MODEL ??
  "claude-sonnet-4-6";

function files(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** The tree's code files, each with numbered lines, so evidence can cite file:line. */
export function numberedCode(cwd: string, limit = MAX_CODE_CHARS): string {
  let out = "";
  const paths = CODE_ROOTS.flatMap((root) => files(join(cwd, root)))
    .map((path) => relative(cwd, path).split("\\").join("/"))
    .filter((path) => /\.(m?js|cjs|ts|html|css|json)$/.test(path))
    .sort();
  for (const path of paths) {
    const lines = readFileSync(join(cwd, path), "utf8").split(/\r?\n/);
    const block = `=== ${path}\n${lines.map((line, i) => `${i + 1}: ${line}`).join("\n")}\n\n`;
    if (out.length + block.length > limit) {
      out += `=== (${paths.length - paths.indexOf(path)} more file(s) omitted for length)\n`;
      break;
    }
    out += block;
  }
  return out;
}

type CreateMessage = (
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  options: { signal: AbortSignal },
) => Promise<Anthropic.Messages.Message>;

export class ClaudeReviewRunner implements ReviewRunner {
  readonly name = "claude";
  private readonly create: CreateMessage;
  private readonly model: string;

  /** `create` is injectable for tests; by default it's the Anthropic SDK with ANTHROPIC_API_KEY. */
  constructor(options: { create?: CreateMessage; model?: string } = {}) {
    this.model = options.model ?? reviewModel();
    if (options.create) {
      this.create = options.create;
    } else {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          "ANTHROPIC_API_KEY isn't set (needed for --runner claude)",
        );
      }
      const client = new Anthropic({ apiKey, maxRetries: 1 });
      this.create = (params, opts) => client.messages.create(params, opts);
    }
  }

  async run(input: ReviewInput): Promise<ReviewOutput> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const message = await this.create(
        {
          model: this.model,
          max_tokens: 4096,
          system:
            "You review code for conformance to agreed interface contracts. You can't run or change anything; cite evidence only from the numbered files you're given.",
          messages: [
            {
              role: "user",
              content: `${input.prompt}\n\n## The assembled code, with line numbers\n\n${numberedCode(input.cwd)}`,
            },
          ],
          tools: [
            {
              name: TOOL_NAME,
              description:
                "Report the clause-by-clause review of the assembled code.",
              input_schema:
                REVIEW_SCHEMA as unknown as Anthropic.Messages.Tool.InputSchema,
            },
          ],
          tool_choice: { type: "tool", name: TOOL_NAME },
        },
        { signal: controller.signal },
      );
      const block = message.content.find((b) => b.type === "tool_use");
      if (!block || block.type !== "tool_use") {
        throw new Error("Claude returned no review (no tool_use block)");
      }
      return {
        findings: block.input,
        model: message.model,
        sessionId: message.id,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

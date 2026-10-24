import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REVIEW_SCHEMA } from "@dibs/protocol";
import { ClaudeReviewRunner, numberedCode } from "../src/review-claude.ts";
import { runnerByName } from "../src/review.ts";
import type { ReviewInput } from "../src/review.ts";
import { validate } from "../src/schema.ts";
import { tempDir } from "./helpers.ts";

const tree = () => {
  const dir = tempDir("claude");
  mkdirSync(join(dir, "src/auth"), { recursive: true });
  mkdirSync(join(dir, "node_modules/x"), { recursive: true });
  writeFileSync(
    join(dir, "src/auth/index.js"),
    "export function requireUser() {}\n// line 2\n",
  );
  writeFileSync(join(dir, "node_modules/x/index.js"), "secret\n");
  return dir;
};

describe("Claude review runner", () => {
  it("numbers the code lines and skips node_modules", () => {
    const dir = tree();
    const code = numberedCode(dir);
    expect(code).toContain("=== src/auth/index.js");
    expect(code).toContain("1: export function requireUser() {}");
    expect(code).toContain("2: // line 2");
    expect(code).not.toContain("secret");
    rmSync(dir, { recursive: true, force: true });
  });

  it("forces one tool call with REVIEW_SCHEMA and returns its input", async () => {
    const dir = tree();
    const findings = {
      summary: "All clauses conform.",
      clauses: [
        {
          clause: "helper",
          key: "auth.server",
          verdict: "conforms",
          evidence: [
            { file: "src/auth/index.js", line: 1, note: "exports requireUser" },
          ],
        },
      ],
      rootCause: null,
    };
    let sent: Record<string, unknown> | undefined;
    const runner = new ClaudeReviewRunner({
      model: "test-model",
      create: async (params) => {
        sent = params as unknown as Record<string, unknown>;
        return {
          id: "msg_1",
          model: "test-model",
          content: [
            {
              type: "tool_use",
              id: "t",
              name: "report_review",
              input: findings,
            },
          ],
        } as never;
      },
    });
    const out = await runner.run({ cwd: dir, prompt: "PROMPT" } as ReviewInput);
    expect(out).toEqual({ findings, model: "test-model", sessionId: "msg_1" });
    expect(validate(REVIEW_SCHEMA, out.findings)).toEqual([]);
    expect(sent?.tool_choice).toEqual({ type: "tool", name: "report_review" });
    expect(JSON.stringify(sent?.messages)).toContain(
      "1: export function requireUser",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("auto picks Claude when only ANTHROPIC_API_KEY is set, and explains when neither is", async () => {
    const saved = {
      f: process.env.FACTORY_API_KEY,
      a: process.env.ANTHROPIC_API_KEY,
    };
    delete process.env.FACTORY_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test";
    expect((await runnerByName("auto")).name).toBe("claude");
    delete process.env.ANTHROPIC_API_KEY;
    await expect(runnerByName("auto")).rejects.toThrow(/ANTHROPIC_API_KEY/);
    if (saved.f) process.env.FACTORY_API_KEY = saved.f;
    if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
  });
});

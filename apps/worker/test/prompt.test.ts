import { describe, it, expect } from "vitest";
import { FINDINGS_SCHEMA } from "@dibs/protocol";
import {
  buildAnalysisRequest,
  buildUserPrompt,
  MAX_OUTPUT_TOKENS,
} from "../src/analysis/prompt.ts";
import { loadFixture } from "./helpers.ts";

describe("prompt builder", () => {
  it("builds a request with the findings schema and token budget", () => {
    const input = loadFixture("bearer-vs-cookie");
    const req = buildAnalysisRequest(input);
    expect(req.schema).toBe(FINDINGS_SCHEMA);
    expect(req.maxTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(req.system).toMatch(/report_findings/);
    expect(req.system).toMatch(/non-negotiable/i);
  });

  it("includes the charter, vocabulary keys, and real item ids", () => {
    const input = loadFixture("bearer-vs-cookie");
    const user = buildUserPrompt(input);
    expect(user).toContain("exactly one session transport");
    for (const v of input.vocabulary) expect(user).toContain(v.key);
    for (const it of input.items) expect(user).toContain(`[item ${it.id}]`);
  });

  it("lists only keys shared by more than one participant", () => {
    const input = loadFixture("bearer-vs-cookie");
    const user = buildUserPrompt(input);
    // auth.session is produced by claude and required by codex -> shared.
    const sharedSection = user.slice(user.indexOf("Keys to analyze"));
    expect(sharedSection).toContain("- auth.session");
    // auth.server is only claude's here -> not in the shared list.
    const sharedLines = sharedSection.slice(
      0,
      sharedSection.indexOf("# Existing"),
    );
    expect(sharedLines).not.toContain("- auth.server");
  });

  it("marks a revise job", () => {
    const input = {
      ...loadFixture("bearer-vs-cookie"),
      jobKind: "revise" as const,
    };
    expect(buildUserPrompt(input)).toMatch(/REVISE job/);
  });
});

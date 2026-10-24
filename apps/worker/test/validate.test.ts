import { describe, it, expect } from "vitest";
import type { AnalysisInput, Findings } from "@dibs/protocol";
import { validateFindings } from "../src/analysis/validate.ts";
import { loadFixture } from "./helpers.ts";

describe("validateFindings", () => {
  it("keeps a well-formed conflict finding", () => {
    const input = loadFixture("bearer-vs-cookie");
    const { kept, dropped } = validateFindings(input.recordedFindings, input);
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(1);
    expect(kept[0].key).toBe("auth.session");
  });

  it("normalizes unowned contractText to empty", () => {
    const input = loadFixture("unowned");
    const { kept } = validateFindings(input.recordedFindings, input);
    expect(kept[0].relation).toBe("unowned");
    expect(kept[0].contractText).toBe("");
  });

  it("drops an unknown key, a bad relation, a nonexistent citation, and empty contract text", () => {
    const input = loadFixture("bearer-vs-cookie");
    const bad: Findings = {
      findings: [
        {
          key: "not.a.key",
          relation: "conflict",
          citedItemIds: [1],
          explanation: "x",
          contractText: "c",
        },
        {
          key: "auth.session",
          relation: "banana" as unknown as Findings["findings"][0]["relation"],
          citedItemIds: [1],
          explanation: "x",
          contractText: "c",
        },
        {
          key: "auth.server",
          relation: "dependency",
          citedItemIds: [999],
          explanation: "x",
          contractText: "c",
        },
        {
          key: "auth.server",
          relation: "conflict",
          citedItemIds: [2],
          explanation: "x",
          contractText: "  ",
        },
      ],
    };
    const { kept, dropped } = validateFindings(bad, input);
    expect(kept).toHaveLength(0);
    expect(dropped.map((d) => d.reason).join(" | ")).toMatch(
      /not in the vocabulary/,
    );
    expect(dropped.some((d) => /unknown relation/.test(d.reason))).toBe(true);
    expect(dropped.some((d) => /nonexistent item/.test(d.reason))).toBe(true);
    expect(dropped.some((d) => /empty contractText/.test(d.reason))).toBe(true);
  });

  it("drops a second finding for the same key", () => {
    const input = loadFixture("bearer-vs-cookie");
    const dup: Findings = {
      findings: [
        input.recordedFindings.findings[0],
        { ...input.recordedFindings.findings[0], explanation: "again" },
      ],
    };
    const { kept, dropped } = validateFindings(dup, input);
    expect(kept).toHaveLength(1);
    expect(dropped[0].reason).toMatch(/duplicate finding/);
  });

  it("drops a finding on an agreed key that cites nothing new (rule 8)", () => {
    const base = loadFixture("compatible");
    const input: AnalysisInput = {
      ...base,
      contracts: [
        {
          id: 1,
          key: "auth.server",
          revision: 1,
          text: "agreed text",
          source: "agreed",
          basisItemIds: [1, 2],
        },
      ],
    };
    const finding: Findings = {
      findings: [
        {
          key: "auth.server",
          relation: "conflict",
          citedItemIds: [1, 2],
          explanation: "x",
          contractText: "c",
        },
      ],
    };
    const { kept, dropped } = validateFindings(finding, input);
    expect(kept).toHaveLength(0);
    expect(dropped[0].reason).toMatch(/already has an agreed contract/);
  });
});

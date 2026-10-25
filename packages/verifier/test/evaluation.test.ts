import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildInput,
  detectorReport,
  scoreRun,
  sharedKeys,
  type DetectorCase,
  type RunResult,
} from "../src/detector.ts";
import { applyMutant, type Mutant } from "../src/mutants.ts";
import { benchDir } from "../src/paths.ts";

const plan = (
  produces: [string, string][] = [],
  requires: [string, string][] = [],
) => ({
  goal: "g",
  produces: produces.map(([key, text]) => ({ key, text })),
  requires: requires.map(([key, text]) => ({ key, text })),
});
const c: DetectorCase = {
  id: "t",
  split: "heldout",
  scenario: "s",
  plans: {
    claude: plan([
      ["auth.session", "bearer"],
      ["auth.server", "getCurrentUser"],
    ]),
    codex: plan([], [["auth.session", "cookie"]]),
    droid: plan([], [["auth.server", "getCurrentUser"]]),
  },
  labels: { "auth.session": "mismatch", "auth.server": "consistent" },
};
const input = buildInput(c, "charter", []);
const finding = (key: string, relation: string, ids: number[]) =>
  ({
    key,
    relation,
    citedItemIds: ids,
    explanation: "",
    contractText: "x",
  }) as never;

describe("detector scoring", () => {
  it("finds shared keys and their parties", () => {
    expect(sharedKeys(c)).toEqual([
      { key: "auth.server", label: "consistent", parties: ["claude", "droid"] },
      { key: "auth.session", label: "mismatch", parties: ["claude", "codex"] },
    ]);
    expect(
      input.items.map((i) => [i.id, i.participant, i.kind, i.key]),
    ).toEqual([
      [1, "claude", "produces", "auth.session"],
      [2, "claude", "produces", "auth.server"],
      [3, "codex", "requires", "auth.session"],
      [4, "droid", "requires", "auth.server"],
    ]);
  });

  it("scores TP, FN, FP and TN, and whether a proposal cites both sides", () => {
    const right = scoreRun(c, input, [
      finding("auth.session", "conflict", [1, 3]),
      finding("auth.server", "compatible", [2, 4]),
    ]);
    expect(right.keys.map((k) => [k.key, k.outcome, k.citesBothSides])).toEqual(
      [
        ["auth.server", "TN", null],
        ["auth.session", "TP", true],
      ],
    );
    const wrong = scoreRun(c, input, [
      finding("auth.session", "compatible", [1, 3]),
      finding("auth.server", "dependency", [2, 4]),
    ]);
    expect(wrong.keys.map((k) => k.outcome)).toEqual(["FP", "FN"]);
    const oneSided = scoreRun(c, input, [
      finding("auth.session", "conflict", [1]),
    ]);
    expect(oneSided.keys[1]!.citesBothSides).toBe(false);
  });

  it("aggregates runs, counting errors as runs without an answer", () => {
    const run = (
      n: number,
      outcomes: Parameters<typeof scoreRun>[2],
      ok = true,
    ): RunResult => ({
      caseId: "t",
      split: "heldout",
      run: n,
      ok,
      ...(ok ? scoreRun(c, input, outcomes) : { keys: [], strayProposals: 0 }),
      latencyMs: 100,
      inputTokens: 1,
      outputTokens: 1,
      droppedFindings: 0,
      model: "m",
    });
    const report = detectorReport(
      [c],
      [
        run(0, [finding("auth.session", "conflict", [1, 3])]),
        run(1, [
          finding("auth.session", "conflict", [1, 3]),
          finding("auth.server", "conflict", [2, 4]),
        ]),
        run(2, [], false),
      ],
      { runsPerCase: 3, casesHash: "h", promptHash: null },
    );
    const s = report.splits.heldout!;
    expect(s).toMatchObject({
      runs: 3,
      errors: 1,
      counts: { TP: 2, FN: 0, FP: 1, TN: 1 },
    });
    expect(s.recall).toMatchObject({ k: 2, n: 2 });
    expect(s.falseAlarmRate).toMatchObject({ k: 1, n: 2 });
    expect(s.caseAccuracy).toMatchObject({ k: 1, n: 2 });
    expect(
      report.cases[0]!.keys.find((k) => k.key === "auth.server")!.raised,
    ).toMatchObject({ k: 1, n: 2 });
  });

  it("the committed cases are well-formed and within plan limits", () => {
    const { cases } = JSON.parse(
      readFileSync(join(benchDir, "detector", "cases.json"), "utf8"),
    ) as { cases: DetectorCase[] };
    expect(
      cases.filter((x) => x.split === "heldout").length,
    ).toBeGreaterThanOrEqual(12);
    for (const x of cases) {
      for (const p of Object.values(x.plans))
        for (const it of [...p.produces, ...p.requires])
          expect(it.text.length).toBeLessThanOrEqual(500);
      // Every label names a shared key.
      const shared = new Set(sharedKeys(x).map((k) => k.key));
      for (const key of Object.keys(x.labels ?? {}))
        expect(shared.has(key)).toBe(true);
    }
  });
});

describe("oracle mutants", () => {
  const tree = mkdtempSync(join(tmpdir(), "mutant-"));
  mkdirSync(join(tree, "src"));
  const m: Mutant = {
    id: "x",
    description: "",
    file: "src/a.js",
    find: "status(409)",
    replace: "status(201)",
    mustFail: [3],
    mustPass: [],
  };

  it("applies an exact edit once", () => {
    writeFileSync(join(tree, "src/a.js"), "res.status(409).json({})");
    applyMutant(tree, m);
    expect(readFileSync(join(tree, "src/a.js"), "utf8")).toBe(
      "res.status(201).json({})",
    );
  });

  it("refuses a missing or ambiguous match instead of passing silently", () => {
    writeFileSync(join(tree, "src/a.js"), "nothing here");
    expect(() => applyMutant(tree, m)).toThrow(/found 0/);
    writeFileSync(join(tree, "src/a.js"), "status(409) status(409)");
    expect(() => applyMutant(tree, m)).toThrow(/found 2/);
  });

  it("every check 1-6 is targeted by at least one committed mutant", () => {
    const { mutants } = JSON.parse(
      readFileSync(join(benchDir, "oracle-mutants.json"), "utf8"),
    ) as { mutants: Mutant[] };
    const targeted = new Set(mutants.flatMap((x) => x.mustFail));
    expect([...targeted].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    for (const x of mutants)
      expect(x.mustFail.some((n) => x.mustPass.includes(n))).toBe(false);
  });
});

describe("detector breakdown by relation", () => {
  it("separates clashes from confirmation requests on both sides", () => {
    const mk = (
      n: number,
      findings: Parameters<typeof scoreRun>[2],
    ): RunResult => ({
      caseId: "t",
      split: "heldout",
      run: n,
      ok: true,
      ...scoreRun(c, input, findings),
      latencyMs: 1,
      inputTokens: 1,
      outputTokens: 1,
      droppedFindings: 0,
      model: "m",
    });
    const report = detectorReport(
      [c],
      [
        mk(0, [
          finding("auth.session", "conflict", [1, 3]),
          finding("auth.server", "compatible", [2, 4]),
        ]),
        mk(1, [
          finding("auth.session", "dependency", [1, 3]),
          finding("auth.server", "dependency", [2, 4]),
        ]),
        mk(2, [
          finding("auth.session", "conflict", [1, 3]),
          finding("auth.server", "conflict", [2, 4]),
        ]),
      ],
      { runsPerCase: 3, casesHash: "h", promptHash: null },
    );
    const s = report.splits.heldout!;
    expect(s.byRelation).toEqual({
      catches: { conflict: 2, dependency: 1 },
      falseAlarms: { dependency: 1, conflict: 1 },
    });
    expect(s.clashRecognized).toMatchObject({ k: 2, n: 3 });
    expect(s.wrongClash).toMatchObject({ k: 1, n: 3 });
    expect(s.confirmRequests).toMatchObject({ k: 1, n: 3 });
    // The strict headline is unchanged by the breakdown.
    expect(s.falseAlarmRate).toMatchObject({ k: 2, n: 3 });
    expect(
      report.cases[0]!.keys.find((k) => k.key === "auth.server")!.relations,
    ).toEqual({ compatible: 1, dependency: 1, conflict: 1 });
  });
});

describe("review input", () => {
  const clauses = [{ key: "auth.session", verdict: "violates" }];
  it("reads dibs review's wrapped findings, a bare file, or the newest database row", async () => {
    const { reviewInput } = await import("../src/metrics-cli.ts");
    expect(
      reviewInput(
        {
          lobbyId: 5,
          kind: "diagnosis",
          findings: { summary: "s", clauses, rootCause: null },
        },
        undefined,
        5,
      )?.clauses,
    ).toEqual(clauses);
    expect(
      reviewInput({ summary: "s", clauses, rootCause: null }, undefined, 5)
        ?.clauses,
    ).toEqual(clauses);
    const dump = {
      review: [
        { id: 1, lobbyId: 5, findings: JSON.stringify({ clauses: [] }) },
        { id: 2, lobbyId: 5, findings: JSON.stringify({ clauses }) },
        { id: 3, lobbyId: 6, findings: JSON.stringify({ clauses: [] }) },
      ],
    };
    expect(reviewInput(undefined, dump, 5)?.clauses).toEqual(clauses);
    expect(reviewInput(undefined, undefined, 5)).toBeUndefined();
  });
});

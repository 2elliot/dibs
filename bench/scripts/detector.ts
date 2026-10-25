// Offline detector benchmark: runs the worker's real analysis (same prompt, model client and
// validation as production) on every labelled case in bench/detector/cases.json, N times each,
// and scores it (packages/verifier/src/detector.ts, bench/EVALUATION.md §1).
//
//   ANTHROPIC_API_KEY=... npx tsx bench/scripts/detector.ts [--runs 10] [--split all|heldout|dev]
//     [--concurrency 3] [--model claude-sonnet-4-6]
//   npx tsx bench/scripts/detector.ts --self-test     # no key: a perfect fake, checks the pipeline
//   npx tsx bench/scripts/detector.ts --from bench/results/detector/runs.jsonl
//       # no key, no model calls: re-scores saved raw findings (after a scoring change)
//
// Writes bench/results/detector/detector.json (+ runs.jsonl with every raw finding, for audit).
// --self-test writes detector-selftest.json instead and must never be reported as a result.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Findings, VocabularyEntry } from "@dibs/protocol";
import { buildAnalysisRequest } from "../../apps/worker/src/analysis/prompt.ts";
import { runAnalysis } from "../../apps/worker/src/analysis/analyze.ts";
import { AnthropicModelClient } from "../../apps/worker/src/model/anthropic.ts";
import { FakeModelClient } from "../../apps/worker/src/model/fake.ts";
import {
  buildInput,
  detectorReport,
  scoreRun,
  sharedKeys,
  type DetectorCase,
  type RunResult,
} from "../../packages/verifier/src/detector.ts";
import { benchDir, fixtureDir } from "../../packages/verifier/src/paths.ts";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "10" },
    split: { type: "string", default: "all" },
    concurrency: { type: "string", default: "3" },
    model: { type: "string" },
    "self-test": { type: "boolean", default: false },
    from: { type: "string" },
  },
});
const rescoreFrom = values.from;
const runsPerCase = Number(values.runs);
const selfTest = values["self-test"];
const casesPath = join(benchDir, "detector", "cases.json");
const casesText = readFileSync(casesPath, "utf8");
const allCases = (JSON.parse(casesText) as { cases: DetectorCase[] }).cases;
const cases = allCases.filter(
  (c) => values.split === "all" || c.split === values.split,
);

const read = (p: string) => readFileSync(p, "utf8");
const charters = {
  s: read(join(benchDir, "prompts", "charter-s.md")).trim(),
  n: read(join(benchDir, "prompts", "charter-n.md")).trim(),
};
const vocabularies: Record<string, VocabularyEntry[]> = {
  s: JSON.parse(read(join(fixtureDir, "dibs.json"))).vocabulary,
  n: JSON.parse(read(join(benchDir, "prompts", "vocabulary-n.json")))
    .vocabulary,
};

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!selfTest && !rescoreFrom && !apiKey) {
  console.error(
    "ANTHROPIC_API_KEY is not set. Set it, or pass --self-test to check the pipeline.",
  );
  process.exit(2);
}
const modelName =
  values.model ??
  process.env.DIBS_DETECTOR_MODEL ??
  process.env.ANTHROPIC_MODEL ??
  "claude-sonnet-4-6";

/** A perfect detector built from the labels: proves scoring and validation, measures nothing. */
function perfectFake(c: DetectorCase, input: ReturnType<typeof buildInput>) {
  const findings: Findings = {
    findings: sharedKeys(c).map(({ key, label }) => ({
      key,
      relation: label === "mismatch" ? "conflict" : "compatible",
      citedItemIds: input.items.filter((i) => i.key === key).map((i) => i.id),
      explanation: `self-test: ${label}`,
      contractText: `self-test contract for ${key}`,
    })),
  };
  return FakeModelClient.fromFindings(findings);
}

const outDir = join(benchDir, "results", "detector");
mkdirSync(outDir, { recursive: true });
const rawPath = join(outDir, selfTest ? "runs-selftest.jsonl" : "runs.jsonl");
// Re-scoring reads the saved raw findings; it must never truncate them.
const savedLines = rescoreFrom
  ? readFileSync(rescoreFrom, "utf8").split(/\r?\n/).filter(Boolean)
  : [];
if (!rescoreFrom) writeFileSync(rawPath, "");

const jobs = cases.flatMap((c) =>
  Array.from({ length: runsPerCase }, (_, run) => ({ c, run })),
);
const results: RunResult[] = [];
let next = 0;
let done = 0;
const promptHash = cases[0]
  ? createHash("sha256")
      .update(
        buildAnalysisRequest(buildInput(cases[0], charters.s, vocabularies.s!))
          .system,
      )
      .digest("hex")
      .slice(0, 12)
  : null;

async function worker() {
  while (next < jobs.length) {
    const { c, run } = jobs[next++]!;
    const input = buildInput(
      c,
      charters[c.scenario],
      vocabularies[c.scenario]!,
    );
    const model = selfTest
      ? perfectFake(c, input)
      : new AnthropicModelClient({ apiKey: apiKey!, model: modelName });
    let result: RunResult;
    try {
      const outcome = await runAnalysis(input, model);
      result = {
        caseId: c.id,
        split: c.split,
        run,
        ok: true,
        ...scoreRun(c, input, outcome.kept),
        latencyMs: outcome.latencyMs,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        droppedFindings: outcome.dropped.filter((d) => !d.ignored).length,
        model: outcome.model,
      };
      appendFileSync(
        rawPath,
        `${JSON.stringify({ caseId: c.id, run, kept: outcome.kept, dropped: outcome.dropped, latencyMs: outcome.latencyMs, inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens, model: outcome.model })}\n`,
      );
    } catch (error) {
      // An error counts as a run with no answer: reported, never silently retried.
      result = {
        caseId: c.id,
        split: c.split,
        run,
        ok: false,
        error: (error as Error).message,
        keys: [],
        strayProposals: 0,
        latencyMs: null,
        inputTokens: null,
        outputTokens: null,
        droppedFindings: 0,
        model: selfTest ? "self-test" : modelName,
      };
      appendFileSync(
        rawPath,
        `${JSON.stringify({ caseId: c.id, run, error: result.error })}\n`,
      );
    }
    results.push(result);
    done++;
    process.stderr.write(`\r${done}/${jobs.length} runs`);
  }
}
/** Re-scores one saved line exactly as a live run would be scored. */
function rescore(line: string): RunResult | null {
  const raw = JSON.parse(line) as {
    caseId: string;
    run: number;
    kept?: Findings["findings"];
    dropped?: { ignored?: boolean }[];
    error?: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
  };
  const c = cases.find((x) => x.id === raw.caseId);
  if (!c) return null;
  const base = {
    caseId: c.id,
    split: c.split,
    run: raw.run,
    latencyMs: raw.latencyMs ?? null,
    inputTokens: raw.inputTokens ?? null,
    outputTokens: raw.outputTokens ?? null,
    model: raw.model ?? null,
  };
  if (raw.error || !raw.kept)
    return {
      ...base,
      ok: false,
      error: raw.error ?? "no findings saved",
      keys: [],
      strayProposals: 0,
      droppedFindings: 0,
    };
  const input = buildInput(c, charters[c.scenario], vocabularies[c.scenario]!);
  return {
    ...base,
    ok: true,
    ...scoreRun(c, input, raw.kept),
    droppedFindings: (raw.dropped ?? []).filter((d) => !d.ignored).length,
  };
}

if (rescoreFrom) {
  for (const line of savedLines) {
    const r = rescore(line);
    if (r) results.push(r);
  }
} else {
  await Promise.all(
    Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker),
  );
  process.stderr.write("\n");
}

// Older raw files carry no timing or model: keep those from the detector.json being replaced.
const previous = rescoreFrom
  ? (() => {
      try {
        return JSON.parse(
          readFileSync(join(outDir, "detector.json"), "utf8"),
        ) as ReturnType<typeof detectorReport>;
      } catch {
        return null;
      }
    })()
  : null;

const report = detectorReport(cases, results, {
  runsPerCase: rescoreFrom
    ? Math.max(
        0,
        ...cases.map((c) => results.filter((r) => r.caseId === c.id).length),
      )
    : runsPerCase,
  casesHash: createHash("sha256").update(casesText).digest("hex").slice(0, 12),
  promptHash,
  notes: selfTest
    ? [
        "SELF-TEST: a fake built from the labels. Checks the pipeline only; not a result.",
      ]
    : rescoreFrom
      ? [
          `Re-scored from saved raw findings (${rescoreFrom}); no model calls were made.${previous ? ` Original run: ${previous.createdAt}.` : ""}`,
        ]
      : [],
});
if (previous) {
  report.model ??= previous.model;
  report.promptHash = previous.promptHash ?? report.promptHash;
  for (const [split, s] of Object.entries(report.splits)) {
    const old = previous.splits?.[split];
    if (old && s.latencyMs.n === 0) s.latencyMs = old.latencyMs;
    if (old && s.outputTokens.n === 0) s.outputTokens = old.outputTokens;
  }
}
const out = join(outDir, selfTest ? "detector-selftest.json" : "detector.json");
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
const pct = (r: {
  rate: number | null;
  low: number | null;
  high: number | null;
  k: number;
  n: number;
}) =>
  r.n
    ? `${r.k}/${r.n} = ${Math.round(r.rate! * 100)}% (95% CI ${Math.round(r.low! * 100)}–${Math.round(r.high! * 100)}%)`
    : "–";
for (const [split, s] of Object.entries(report.splits)) {
  console.log(`${split}: ${s.runs} runs, ${s.errors} errors`);
  console.log(`  recall (mismatches caught)     ${pct(s.recall)}`);
  console.log(`  false alarms (clean keys)      ${pct(s.falseAlarmRate)}`);
  console.log(`  precision                      ${pct(s.precision)}`);
  console.log(`  whole case right               ${pct(s.caseAccuracy)}`);
  console.log(
    `  latency median                 ${s.latencyMs.median ?? "–"} ms`,
  );
  const list = (m: Record<string, number>) =>
    Object.entries(m)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ") || "none";
  console.log(`  breakdown by relation (secondary)`);
  console.log(`    catches                      ${list(s.byRelation.catches)}`);
  console.log(
    `    false alarms                 ${list(s.byRelation.falseAlarms)}`,
  );
  console.log(`    mismatch called a clash      ${pct(s.clashRecognized)}`);
  console.log(`    clean key called a clash     ${pct(s.wrongClash)}`);
  console.log(`    clean key asked to confirm   ${pct(s.confirmRequests)}`);
}
console.log(`written: ${out}`);

// Offline detector benchmark: runs the worker's real analysis (same prompt, model client and
// validation as production) on every labelled case in bench/detector/cases.json, N times each,
// and scores it (packages/verifier/src/detector.ts, bench/EVALUATION.md §1).
//
//   ANTHROPIC_API_KEY=... npx tsx bench/scripts/detector.ts [--runs 10] [--split all|heldout|dev]
//     [--concurrency 3] [--model claude-sonnet-4-6]
//   npx tsx bench/scripts/detector.ts --self-test     # no key: a perfect fake, checks the pipeline
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
  },
});
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
if (!selfTest && !apiKey) {
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
writeFileSync(rawPath, "");

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
        `${JSON.stringify({ caseId: c.id, run, kept: outcome.kept, dropped: outcome.dropped })}\n`,
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
await Promise.all(
  Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker),
);
process.stderr.write("\n");

const report = detectorReport(cases, results, {
  runsPerCase,
  casesHash: createHash("sha256").update(casesText).digest("hex").slice(0, 12),
  promptHash,
  notes: selfTest
    ? [
        "SELF-TEST: a fake built from the labels. Checks the pipeline only; not a result.",
      ]
    : [],
});
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
}
console.log(`written: ${out}`);

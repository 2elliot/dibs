// The evaluation report (bench/EVALUATION.md): collects every source into one JSON and renders
// bench/report/template.html with it. Sections whose data doesn't exist yet render as "pending"
// with the command that fills them; re-run this script after each run and the page updates.
//
//   npx tsx bench/scripts/report.ts [--out <dir>]
// Reads  bench/trials.json, bench/PREREG.md, bench/oracle-mutants.json, bench/detector/cases.json,
//        bench/results/<id>/{metrics,evidence}.json + assembled.diff, bench/results/mutant-probe.json,
//        bench/results/oracle-mutants.json, bench/results/detector/detector.json
// Writes <out>/report.html (self-contained), <out>/report-data.json, and <out>/data/ (every input).
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compare } from "../../packages/verifier/src/compare.ts";
import {
  sharedKeys,
  type DetectorCase,
} from "../../packages/verifier/src/detector.ts";
import { inArea, loadManifest } from "../../packages/verifier/src/manifest.ts";
import {
  ORACLE_TIERS,
  parseDiff,
  type LobbyMetrics,
} from "../../packages/verifier/src/metrics.ts";
import {
  benchDir,
  fixtureDir,
  repoRoot,
  resultsDir,
} from "../../packages/verifier/src/paths.ts";
import { fisherExact } from "../../packages/verifier/src/stats.ts";

const { values } = parseArgs({ options: { out: { type: "string" } } });
const results = join(benchDir, "results");
const outDir = values.out ?? join(results, "report");
mkdirSync(join(outDir, "data"), { recursive: true });

const readJson = <T>(p: string): T | null =>
  existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
const sources: string[] = [];
/** Reads a file into the bundle as well, so the data folder holds every input the page used. */
function take<T>(path: string, bundleName: string): T | null {
  const value = readJson<T>(path);
  if (value !== null) {
    cpSync(path, join(outDir, "data", bundleName));
    sources.push(bundleName);
  }
  return value;
}
const git = (args: string[]) => {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
};

// Trials --------------------------------------------------------------------------------------
type Trial = {
  lobby: number;
  trial: string;
  scenario: string;
  mode: string;
  status: string;
  reason?: string;
};
const registry =
  take<{ lobbies: Trial[] }>(join(benchDir, "trials.json"), "trials.json")
    ?.lobbies ?? [];
const manifest = loadManifest(fixtureDir);
const areas = manifest.areas as Record<string, string[]>;

const trials = registry.map((t) => {
  const dir = resultsDir(t.lobby);
  const metrics = take<LobbyMetrics>(
    join(dir, "metrics.json"),
    `lobby-${t.lobby}-metrics.json`,
  );
  const evidence = take<Record<string, unknown>>(
    join(dir, "evidence.json"),
    `lobby-${t.lobby}-evidence.json`,
  );
  const diffPath = join(dir, "assembled.diff");
  let code: Record<
    string,
    { src: number; test: number; removed: number }
  > | null = null;
  if (existsSync(diffPath)) {
    cpSync(diffPath, join(outDir, "data", `lobby-${t.lobby}-assembled.diff`));
    code = {};
    for (const f of parseDiff(readFileSync(diffPath, "utf8"))) {
      const agent = Object.keys(areas).find((a) => inArea(f.path, areas[a]!));
      if (!agent) continue;
      const c = (code[agent] ??= { src: 0, test: 0, removed: 0 });
      if (f.path.startsWith("test/")) c.test += f.added;
      else c.src += f.added;
      c.removed += f.removed;
    }
  }
  return { ...t, metrics, evidence, code };
});
const scored = trials
  .filter((t) => t.status === "scored" && t.metrics)
  .map((t) => t.metrics!);
const comparison = scored.length
  ? compare(scored, { baseline: "none", treatment: "dibs" })
  : null;

// Power: which outcomes would be significant, for the sample sizes on the table.
const power = [1, 3, 5, 6, 8, 10].map((n) => ({
  n,
  // p[noneK][dibsK]
  p: Array.from({ length: n + 1 }, (_, a) =>
    Array.from({ length: n + 1 }, (_, b) => fisherExact(b, n - b, a, n - a)),
  ),
}));

// Oracle mutants ------------------------------------------------------------------------------
const mutantSpec = take<{ mutants: Record<string, unknown>[] }>(
  join(benchDir, "oracle-mutants.json"),
  "oracle-mutants.json",
);
const mutantProbe = take<Record<string, unknown>>(
  join(results, "mutant-probe.json"),
  "mutant-probe.json",
);
const mutantOracle = take<Record<string, unknown>>(
  join(results, "oracle-mutants.json"),
  "oracle-mutants-result.json",
);

// Detector ------------------------------------------------------------------------------------
const casesFile = take<{ cases: DetectorCase[] }>(
  join(benchDir, "detector", "cases.json"),
  "detector-cases.json",
);
const cases = (casesFile?.cases ?? []).map((c) => ({
  id: c.id,
  split: c.split,
  scenario: c.scenario,
  note: c.note,
  keys: sharedKeys(c).map((k) => ({
    key: k.key,
    label: k.label,
    parties: k.parties,
  })),
}));
const detector = take<Record<string, unknown>>(
  join(results, "detector", "detector.json"),
  "detector.json",
);
const detectorSelfTest = take<Record<string, unknown>>(
  join(results, "detector", "detector-selftest.json"),
  "detector-selftest.json",
);
if (existsSync(join(results, "detector", "runs.jsonl")))
  cpSync(
    join(results, "detector", "runs.jsonl"),
    join(outDir, "data", "detector-runs.jsonl"),
  );

// Pre-registration ----------------------------------------------------------------------------
const prereg = readFileSync(join(benchDir, "PREREG.md"), "utf8");
cpSync(join(benchDir, "PREREG.md"), join(outDir, "data", "PREREG.md"));
const schedule = [
  ...prereg.matchAll(
    /^\|\s*(\d+)\s*\|\s*([A-Z0-9-]+)\s*\|\s*(\w+)\s*\|\s*(\w+)\s*\|$/gm,
  ),
].map((m) => ({
  n: Number(m[1]),
  block: m[2]!,
  scenario: m[3]!,
  arm: m[4]!,
}));
const hypotheses = [
  ...prereg.matchAll(/^\|\s*\**(H\d)\**\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/gm),
].map((m) => ({
  id: m[1]!,
  text: m[2]!.replace(/\*\*/g, ""),
  measure: m[3]!.replace(/`/g, ""),
}));
const ran = new Map(
  registry
    .filter((t) => (t as Trial & { prereg?: number }).prereg)
    .map((t) => [(t as Trial & { prereg?: number }).prereg!, t]),
);

const data = {
  generatedAt: new Date().toISOString(),
  commit: git(["rev-parse", "--short", "HEAD"]),
  oracleHash: readFileSync(join(benchDir, "oracle.hash"), "utf8")
    .trim()
    .slice(0, 12),
  preregCommit: git(["log", "-1", "--format=%h %cI", "--", "bench/PREREG.md"]),
  tiers: ORACLE_TIERS,
  trials,
  comparison,
  power,
  mutants: {
    spec: mutantSpec?.mutants ?? [],
    probe: mutantProbe,
    oracle: mutantOracle,
  },
  detector: { cases, report: detector, selfTest: detectorSelfTest },
  prereg: {
    schedule: schedule.map((s) => ({
      ...s,
      lobby: ran.get(s.n)?.lobby ?? null,
    })),
    hypotheses,
  },
  sources,
};
writeFileSync(
  join(outDir, "report-data.json"),
  `${JSON.stringify(data, null, 2)}\n`,
);
const template = readFileSync(
  join(benchDir, "report", "template.html"),
  "utf8",
);
// Whitespace-tolerant: a formatter once turned "/*__REPORT_DATA__*/null" into "... */ null" and the
// page silently rendered empty. A missing placeholder now stops the build instead.
const PLACEHOLDER = /\/\*__REPORT_DATA__\*\/\s*null/;
if (!PLACEHOLDER.test(template))
  throw new Error(
    "bench/report/template.html has no /*__REPORT_DATA__*/ null placeholder",
  );
const json = JSON.stringify(data).replace(/</g, "\\u003c");
const html = template.replace(PLACEHOLDER, () => json);
writeFileSync(join(outDir, "report.html"), html);
console.log(
  `report: ${join(outDir, "report.html")}\ndata:   ${join(outDir, "data")} (${readdirSync(join(outDir, "data")).length} files)`,
);

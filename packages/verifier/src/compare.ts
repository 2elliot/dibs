// Cross-trial comparison: groups lobbies' metrics.json by arm (the lobby's mode, or a label you
// give) and reports each metric with its spread and uncertainty, plus the difference between
// two arms. One lobby per arm is an anecdote; this makes that visible instead of hiding it.
import type { LobbyMetrics } from "./metrics.ts";
import {
  bootstrapMeanDiff,
  fisherExact,
  summarize,
  trialsNeeded,
  wilson,
  type Difference,
  type Rate,
  type Summary,
} from "./stats.ts";

export const COMPARE_SCHEMA = "dibs.compare/v1";

/** The numbers compared between arms: [id, label, unit, pick, better]. */
type Pick = (m: LobbyMetrics) => number | null | undefined;
export interface MetricDef {
  id: string;
  label: string;
  unit: string;
  pick: Pick;
  /** Which direction is better, for the summary line. */
  better: "higher" | "lower";
}

const bool = (b: boolean | null | undefined) =>
  b === null || b === undefined ? null : b ? 1 : 0;

export const METRICS: MetricDef[] = [
  {
    id: "passRate",
    label: "Oracle checks passed",
    unit: "%",
    pick: (m) =>
      m.outcome.passRate === null ? null : m.outcome.passRate * 100,
    better: "higher",
  },
  {
    id: "reviewViolations",
    label: "Contract clauses violated (review)",
    unit: "clauses",
    pick: (m) => m.outcome.reviewViolations,
    better: "lower",
  },
  {
    id: "outOfAreaFiles",
    label: "Out-of-area files",
    unit: "files",
    pick: (m) => m.outcome.outOfAreaFiles,
    better: "lower",
  },
  {
    id: "mergeTreeClean",
    label: "Clean git merge",
    unit: "%",
    pick: (m) =>
      bool(m.outcome.mergeTreeClean) === null
        ? null
        : bool(m.outcome.mergeTreeClean)! * 100,
    better: "higher",
  },
  {
    id: "allPlansSec",
    label: "Time to all plans",
    unit: "s",
    pick: (m) => m.time.allPlansSec,
    better: "lower",
  },
  {
    id: "firstContractSec",
    label: "Time to first contract",
    unit: "s",
    pick: (m) => m.time.firstContractSec,
    better: "lower",
  },
  {
    id: "allSettledSec",
    label: "Time to all shared keys settled",
    unit: "s",
    pick: (m) => m.time.allSettledSec,
    better: "lower",
  },
  {
    id: "lastEditSec",
    label: "Time to last shared edit",
    unit: "s",
    pick: (m) => m.time.lastEditSec,
    better: "lower",
  },
  {
    id: "lastHeadSec",
    label: "Time to last head",
    unit: "s",
    pick: (m) => m.time.lastHeadSec,
    better: "lower",
  },
  {
    id: "settledShare",
    label: "Shared keys settled",
    unit: "%",
    pick: (m) =>
      m.coordination.sharedKeys
        ? (100 * (m.coordination.settledKeys ?? 0)) / m.coordination.sharedKeys
        : null,
    better: "higher",
  },
  {
    id: "proposalRounds",
    label: "Proposal rounds",
    unit: "rounds",
    pick: (m) => m.coordination.proposalRounds,
    better: "lower",
  },
  {
    id: "rejects",
    label: "Proposal rejections",
    unit: "rejects",
    pick: (m) => m.coordination.rejects,
    better: "lower",
  },
  {
    id: "messages",
    label: "Agent messages",
    unit: "msgs",
    pick: (m) => m.coordination.messages,
    better: "lower",
  },
  {
    id: "planRevisions",
    label: "Plan revisions",
    unit: "plans",
    pick: (m) => m.coordination.planRevisions,
    better: "lower",
  },
  {
    id: "responseLatency",
    label: "Proposal shown → response (median)",
    unit: "ms",
    pick: (m) => m.coordination.responseLatency.medianMs,
    better: "lower",
  },
  {
    id: "linesAdded",
    label: "Lines added",
    unit: "lines",
    pick: (m) => m.work.linesAdded,
    better: "lower",
  },
  {
    id: "linesRemoved",
    label: "Lines removed",
    unit: "lines",
    pick: (m) => m.work.linesRemoved,
    better: "lower",
  },
  {
    id: "editsBefore",
    label: "Shared edits before contract",
    unit: "edits",
    pick: (m) => m.work.sharedEditsBeforeContract,
    better: "lower",
  },
  {
    id: "editsAfter",
    label: "Shared edits after contract",
    unit: "edits",
    pick: (m) => m.work.sharedEditsAfterContract,
    better: "higher",
  },
  {
    id: "totalTokens",
    label: "Agent tokens (all)",
    unit: "tokens",
    pick: (m) => m.cost.totalTokens,
    better: "lower",
  },
  {
    id: "outputTokens",
    label: "Agent output tokens",
    unit: "tokens",
    pick: (m) => m.cost.outputTokens,
    better: "lower",
  },
  {
    id: "toolCalls",
    label: "Agent tool calls",
    unit: "calls",
    pick: (m) => m.cost.toolCalls,
    better: "lower",
  },
  {
    id: "agentActiveSec",
    label: "Agent active time (sum)",
    unit: "s",
    pick: (m) => m.cost.agentActiveSec,
    better: "lower",
  },
  {
    id: "interventions",
    label: "Human interventions",
    unit: "count",
    pick: (m) => m.interventions,
    better: "lower",
  },
];

export interface ArmReport {
  arm: string;
  lobbies: number[];
  fullPass: Rate;
  /** check number → pass rate */
  checks: Record<string, Rate>;
  metrics: Record<string, Summary>;
}

export interface ArmDiff {
  a: string;
  b: string;
  fullPass: { a: Rate; b: Rate; delta: number | null; fisherP: number | null };
  checks: Record<
    string,
    { a: Rate; b: Rate; delta: number | null; fisherP: number | null }
  >;
  metrics: Record<string, Difference>;
  /** Trials per arm to detect the observed full-pass difference (power 0.8, alpha 0.05). */
  trialsNeededPerArm: number | null;
}

export interface ComparisonReport {
  schema: typeof COMPARE_SCHEMA;
  createdAt: string;
  arms: ArmReport[];
  diff: ArmDiff | null;
  warnings: string[];
}

export function armOf(
  m: LobbyMetrics,
  labels: Record<string, string> = {},
): string {
  return labels[String(m.lobbyId)] ?? m.mode ?? "unknown";
}

function rateOf(xs: (boolean | null | undefined)[]): Rate {
  const known = xs.filter((x): x is boolean => typeof x === "boolean");
  return wilson(known.filter(Boolean).length, known.length);
}

export function compare(
  all: LobbyMetrics[],
  {
    labels = {},
    baseline,
    treatment,
  }: {
    labels?: Record<string, string>;
    baseline?: string;
    treatment?: string;
  } = {},
): ComparisonReport {
  const warnings: string[] = [];
  const groups = new Map<string, LobbyMetrics[]>();
  for (const m of all) {
    const arm = armOf(m, labels);
    groups.set(arm, [...(groups.get(arm) ?? []), m]);
  }
  const checkIds = [
    ...new Set(all.flatMap((m) => Object.keys(m.outcome.checks))),
  ].sort();
  const hashes = new Set(all.map((m) => m.oracleHash).filter(Boolean));
  if (hashes.size > 1)
    warnings.push(
      `Lobbies were scored by ${hashes.size} different oracles; their pass rates aren't comparable.`,
    );
  const bases = new Set(all.map((m) => m.baseSha).filter(Boolean));
  if (bases.size > 1)
    warnings.push(`Lobbies started from ${bases.size} different base commits.`);

  const arms: ArmReport[] = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([arm, ms]) => {
      if (ms.length < 5)
        warnings.push(
          `Arm "${arm}" has ${ms.length} lobb${ms.length === 1 ? "y" : "ies"}; intervals will be wide (5+ per arm recommended).`,
        );
      return {
        arm,
        lobbies: ms.map((m) => m.lobbyId).sort((a, b) => a - b),
        fullPass: rateOf(ms.map((m) => m.outcome.fullPass)),
        checks: Object.fromEntries(
          checkIds.map((c) => [c, rateOf(ms.map((m) => m.outcome.checks[c]))]),
        ),
        metrics: Object.fromEntries(
          METRICS.map((d) => [d.id, summarize(ms.map(d.pick))]),
        ),
      };
    });

  // Default pairing: none (baseline) vs dibs (treatment), else the first two arms.
  const names = arms.map((a) => a.arm);
  const a = baseline ?? (names.includes("none") ? "none" : names[0]);
  const b =
    treatment ?? (names.includes("dibs") ? "dibs" : names.find((n) => n !== a));
  let diff: ArmDiff | null = null;
  const A = arms.find((x) => x.arm === a);
  const B = arms.find((x) => x.arm === b);
  if (A && B && A !== B) {
    const ga = groups.get(A.arm)!;
    const gb = groups.get(B.arm)!;
    const rateDiff = (ra: Rate, rb: Rate) => ({
      a: ra,
      b: rb,
      delta: ra.rate !== null && rb.rate !== null ? rb.rate - ra.rate : null,
      fisherP:
        ra.n && rb.n ? fisherExact(rb.k, rb.n - rb.k, ra.k, ra.n - ra.k) : null,
    });
    const fp = rateDiff(A.fullPass, B.fullPass);
    diff = {
      a: A.arm,
      b: B.arm,
      fullPass: fp,
      checks: Object.fromEntries(
        checkIds.map((c) => [c, rateDiff(A.checks[c]!, B.checks[c]!)]),
      ),
      metrics: Object.fromEntries(
        METRICS.map((d) => [
          d.id,
          bootstrapMeanDiff(ga.map(d.pick), gb.map(d.pick)),
        ]),
      ),
      trialsNeededPerArm:
        fp.a.rate !== null && fp.b.rate !== null && fp.a.rate !== fp.b.rate
          ? trialsNeeded(
              Math.min(Math.max(fp.a.rate, 0.01), 0.99),
              Math.min(Math.max(fp.b.rate, 0.01), 0.99),
            )
          : null,
    };
  }
  return {
    schema: COMPARE_SCHEMA,
    createdAt: new Date().toISOString(),
    arms,
    diff,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering

const fmt = (x: number | null | undefined, digits = 1) =>
  x === null || x === undefined
    ? "–"
    : Math.abs(x) >= 1000
      ? Math.round(x).toLocaleString("en-US")
      : Number(x.toFixed(digits)).toString();
const pct = (x: number | null) =>
  x === null ? "–" : `${Math.round(x * 100)}%`;
const rateText = (r: Rate) =>
  r.n ? `${r.k}/${r.n} (${pct(r.rate)}, CI ${pct(r.low)}–${pct(r.high)})` : "–";

export function toMarkdown(report: ComparisonReport): string {
  const out: string[] = ["# Benchmark comparison", ""];
  for (const w of report.warnings) out.push(`> ⚠ ${w}`);
  if (report.warnings.length) out.push("");
  const arms = report.arms;
  out.push(
    `| Metric | ${arms.map((a) => `${a.arm} (n=${a.lobbies.length})`).join(" | ")}${report.diff ? ` | Δ ${report.diff.b} − ${report.diff.a} (95% CI) |` : " |"}`,
  );
  out.push(
    `| --- | ${arms.map(() => "---").join(" | ")}${report.diff ? " | --- |" : " |"}`,
  );
  const d = report.diff;
  out.push(
    `| **Full pass (all checks)** | ${arms.map((a) => rateText(a.fullPass)).join(" | ")}${d ? ` | ${d.fullPass.delta === null ? "–" : `${d.fullPass.delta >= 0 ? "+" : ""}${Math.round(d.fullPass.delta * 100)} pts, Fisher p=${fmt(d.fullPass.fisherP, 3)}`} |` : " |"}`,
  );
  for (const c of Object.keys(arms[0]?.checks ?? {})) {
    const dc = d?.checks[c];
    out.push(
      `| Check ${c} | ${arms.map((a) => rateText(a.checks[c]!)).join(" | ")}${d ? ` | ${dc?.delta === null || dc === undefined ? "–" : `${dc.delta >= 0 ? "+" : ""}${Math.round(dc.delta * 100)} pts`} |` : " |"}`,
    );
  }
  for (const def of METRICS) {
    if (arms.every((a) => a.metrics[def.id]!.n === 0)) continue;
    const cells = arms.map((a) => {
      const s = a.metrics[def.id]!;
      if (!s.n) return "–";
      return s.n === 1
        ? `${fmt(s.mean)}`
        : `${fmt(s.mean)} ± ${fmt(s.sd)} (med ${fmt(s.median)})`;
    });
    const dm = d?.metrics[def.id];
    const dcell =
      !dm || dm.delta === null
        ? "–"
        : `${dm.delta >= 0 ? "+" : ""}${fmt(dm.delta)}${dm.low !== null ? ` (${fmt(dm.low)} to ${fmt(dm.high)})` : " (n too small for CI)"}`;
    out.push(
      `| ${def.label} (${def.unit}, ${def.better} is better) | ${cells.join(" | ")}${d ? ` | ${dcell} |` : " |"}`,
    );
  }
  out.push("");
  for (const a of arms)
    out.push(`- **${a.arm}**: lobbies ${a.lobbies.join(", ")}`);
  if (d?.trialsNeededPerArm)
    out.push(
      "",
      `To show the observed full-pass difference (${pct(d.fullPass.a.rate)} → ${pct(d.fullPass.b.rate)}) at p<0.05 with 80% power, run about **${d.trialsNeededPerArm} lobbies per arm**.`,
    );
  out.push(
    "",
    "Rates use 95% Wilson intervals; differences in means use a 10,000-sample percentile bootstrap (seed 42). Values are mean ± sd (median).",
  );
  return `${out.join("\n")}\n`;
}

/** One row per lobby, for spreadsheets and plotting. */
export function toCsv(
  all: LobbyMetrics[],
  labels: Record<string, string> = {},
): string {
  const checkIds = [
    ...new Set(all.flatMap((m) => Object.keys(m.outcome.checks))),
  ].sort();
  const header = [
    "lobby",
    "arm",
    "passed",
    "total",
    "fullPass",
    ...checkIds.map((c) => `check${c}`),
    ...METRICS.map((d) => d.id),
  ];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = all
    .sort((a, b) => a.lobbyId - b.lobbyId)
    .map((m) => [
      m.lobbyId,
      armOf(m, labels),
      m.outcome.passed,
      m.outcome.total,
      bool(m.outcome.fullPass),
      ...checkIds.map((c) => bool(m.outcome.checks[c])),
      ...METRICS.map((d) => d.pick(m)),
    ]);
  return `${[header, ...rows].map((r) => r.map(esc).join(",")).join("\n")}\n`;
}

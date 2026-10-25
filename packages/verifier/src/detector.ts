// Offline detector benchmark (bench/EVALUATION.md §1). dibs's core claim is that it finds
// conflicts in the agents' plans before they become code. That can be measured without running
// any coding agent: hand the analyzer plan sets whose answer is known, many times, and count.
//
// The unit is one shared key in one run. A key is "shared" when one agent produces it and another
// requires it. Each is labelled `mismatch` (the plans can't both be built as written: a proposal
// is expected) or `consistent` (any proposal is a false alarm).
import type {
  AnalysisInput,
  AnalysisItem,
  Finding,
  Provider,
  VocabularyEntry,
} from "@dibs/protocol";
import { summarize, wilson, type Rate, type Summary } from "./stats.ts";

export const DETECTOR_SCHEMA = "dibs.detector/v1";

export interface CasePlan {
  goal: string;
  produces: { key: string; text: string }[];
  requires: { key: string; text: string }[];
  notes?: string;
}

export interface DetectorCase {
  id: string;
  split: "dev" | "heldout";
  scenario: "s" | "n";
  note?: string;
  plans: Record<string, CasePlan>;
  /** key → label; null means every shared key is consistent. */
  labels: Record<string, "mismatch" | "consistent"> | null;
}

/** Relations that open a proposal (docs/API.md "What submit_analysis writes"). */
export const PROPOSAL_RELATIONS = new Set([
  "conflict",
  "dependency",
  "duplicate",
]);

export function buildInput(
  c: DetectorCase,
  charter: string,
  vocabulary: VocabularyEntry[],
): AnalysisInput {
  const items: AnalysisItem[] = [];
  let id = 1;
  Object.entries(c.plans).forEach(([name, plan], index) => {
    for (const kind of ["produces", "requires"] as const)
      for (const item of plan[kind])
        items.push({
          id: id++,
          planId: index + 1,
          planRevision: 1,
          participantId: index + 1,
          participant: name,
          provider: name as Provider,
          kind,
          key: item.key,
          text: item.text,
        });
  });
  return {
    lobbyId: 0,
    jobId: 0,
    jobKind: "analyze",
    inputKey: `bench:${c.id}`,
    charter,
    vocabulary,
    items,
    contracts: [],
    openProposals: [],
    rejections: [],
  };
}

/** Keys with a producer and a consumer, with their labels and the agents on each side. */
export function sharedKeys(c: DetectorCase) {
  const keys = new Map<
    string,
    { producers: Set<string>; consumers: Set<string> }
  >();
  for (const [name, plan] of Object.entries(c.plans)) {
    for (const it of plan.produces) {
      const k = keys.get(it.key) ?? {
        producers: new Set(),
        consumers: new Set(),
      };
      k.producers.add(name);
      keys.set(it.key, k);
    }
    for (const it of plan.requires) {
      const k = keys.get(it.key) ?? {
        producers: new Set(),
        consumers: new Set(),
      };
      k.consumers.add(name);
      keys.set(it.key, k);
    }
  }
  return [...keys.entries()]
    .filter(([, k]) => k.producers.size && k.consumers.size)
    .map(([key, k]) => ({
      key,
      label: c.labels?.[key] ?? ("consistent" as const),
      parties: [...new Set([...k.producers, ...k.consumers])].sort(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export type KeyOutcome = "TP" | "FN" | "FP" | "TN";

export interface KeyResult {
  key: string;
  label: "mismatch" | "consistent";
  outcome: KeyOutcome;
  relation: string | null;
  /** For a TP: the proposal cites items from every agent on the key. */
  citesBothSides: boolean | null;
}

export interface RunResult {
  caseId: string;
  split: DetectorCase["split"];
  run: number;
  ok: boolean;
  error?: string;
  keys: KeyResult[];
  /** Proposals on keys nobody shares (shouldn't happen; validation drops them). */
  strayProposals: number;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  droppedFindings: number;
  model: string | null;
}

export function scoreRun(
  c: DetectorCase,
  input: AnalysisInput,
  kept: Finding[],
): Pick<RunResult, "keys" | "strayProposals"> {
  const shared = sharedKeys(c);
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const keys = shared.map(({ key, label, parties }) => {
    const proposal = kept.find(
      (f) => f.key === key && PROPOSAL_RELATIONS.has(f.relation),
    );
    const raised = Boolean(proposal);
    const outcome: KeyOutcome =
      label === "mismatch" ? (raised ? "TP" : "FN") : raised ? "FP" : "TN";
    const cited = proposal
      ? new Set(proposal.citedItemIds.map((id) => byId.get(id)?.participant))
      : null;
    return {
      key,
      label,
      outcome,
      relation:
        proposal?.relation ?? kept.find((f) => f.key === key)?.relation ?? null,
      citesBothSides:
        outcome === "TP" && cited ? parties.every((p) => cited.has(p)) : null,
    };
  });
  const sharedSet = new Set(shared.map((k) => k.key));
  const strayProposals = kept.filter(
    (f) => PROPOSAL_RELATIONS.has(f.relation) && !sharedSet.has(f.key),
  ).length;
  return { keys, strayProposals };
}

export interface SplitReport {
  runs: number;
  errors: number;
  /** Mismatched keys that got a proposal: TP / (TP + FN). */
  recall: Rate;
  /** Consistent keys that got a proposal: FP / (FP + TN). */
  falseAlarmRate: Rate;
  /** Of the proposals raised on shared keys, how many were on real mismatches: TP / (TP + FP). */
  precision: Rate;
  /** Runs where every shared key in the case was right. */
  caseAccuracy: Rate;
  /** True positives whose proposal cites both sides. */
  citesBothSides: Rate;
  latencyMs: Summary;
  outputTokens: Summary;
  counts: Record<KeyOutcome, number>;
  /**
   * Breakdown by the relation the detector chose (added after the first real run; the strict
   * rates above stay the headline). A proposal can be:
   *   conflict   "these plans won't work together"
   *   dependency "pin these details down" (a confirmation request)
   *   duplicate  "two of you are building this"
   */
  byRelation: {
    /** Proposals on mismatched keys, by relation. */
    catches: Record<string, number>;
    /** Proposals on consistent keys, by relation. */
    falseAlarms: Record<string, number>;
  };
  /** Mismatched keys called a conflict: recognised as a clash, not just pinned down. */
  clashRecognized: Rate;
  /** Consistent keys called a conflict: the damaging false alarm ("won't work" when it would). */
  wrongClash: Rate;
  /** Consistent keys given a dependency or duplicate proposal: an unneeded confirmation request. */
  confirmRequests: Rate;
}

export interface CaseReport {
  id: string;
  split: string;
  note?: string;
  /** relations: how often each relation was chosen for this key across runs (including compatible). */
  keys: {
    key: string;
    label: string;
    raised: Rate;
    relations: Record<string, number>;
  }[];
  correct: Rate;
}

export interface DetectorReport {
  schema: typeof DETECTOR_SCHEMA;
  createdAt: string;
  model: string | null;
  runsPerCase: number;
  casesHash: string;
  promptHash: string | null;
  splits: Record<string, SplitReport>;
  cases: CaseReport[];
  notes: string[];
}

const tally = (xs: string[]) =>
  xs.reduce<Record<string, number>>(
    (m, x) => ((m[x] = (m[x] ?? 0) + 1), m),
    {},
  );

export function splitReport(runs: RunResult[]): SplitReport {
  const ok = runs.filter((r) => r.ok);
  const all = ok.flatMap((r) => r.keys);
  const n = (o: KeyOutcome) => all.filter((k) => k.outcome === o).length;
  const counts = { TP: n("TP"), FN: n("FN"), FP: n("FP"), TN: n("TN") };
  const tps = all.filter((k) => k.outcome === "TP");
  return {
    runs: runs.length,
    errors: runs.length - ok.length,
    recall: wilson(counts.TP, counts.TP + counts.FN),
    falseAlarmRate: wilson(counts.FP, counts.FP + counts.TN),
    precision: wilson(counts.TP, counts.TP + counts.FP),
    caseAccuracy: wilson(
      ok.filter((r) =>
        r.keys.every((k) => k.outcome === "TP" || k.outcome === "TN"),
      ).length,
      ok.length,
    ),
    citesBothSides: wilson(
      tps.filter((k) => k.citesBothSides).length,
      tps.length,
    ),
    latencyMs: summarize(ok.map((r) => r.latencyMs)),
    outputTokens: summarize(ok.map((r) => r.outputTokens)),
    counts,
    byRelation: {
      catches: tally(tps.map((k) => k.relation ?? "unknown")),
      falseAlarms: tally(
        all
          .filter((k) => k.outcome === "FP")
          .map((k) => k.relation ?? "unknown"),
      ),
    },
    clashRecognized: wilson(
      tps.filter((k) => k.relation === "conflict").length,
      counts.TP + counts.FN,
    ),
    wrongClash: wilson(
      all.filter((k) => k.outcome === "FP" && k.relation === "conflict").length,
      counts.FP + counts.TN,
    ),
    confirmRequests: wilson(
      all.filter((k) => k.outcome === "FP" && k.relation !== "conflict").length,
      counts.FP + counts.TN,
    ),
  };
}

export function detectorReport(
  cases: DetectorCase[],
  runs: RunResult[],
  meta: {
    runsPerCase: number;
    casesHash: string;
    promptHash: string | null;
    notes?: string[];
  },
): DetectorReport {
  const splits: Record<string, SplitReport> = {};
  for (const split of ["heldout", "dev"])
    if (runs.some((r) => r.split === split))
      splits[split] = splitReport(runs.filter((r) => r.split === split));
  return {
    schema: DETECTOR_SCHEMA,
    createdAt: new Date().toISOString(),
    model: runs.find((r) => r.model)?.model ?? null,
    runsPerCase: meta.runsPerCase,
    casesHash: meta.casesHash,
    promptHash: meta.promptHash,
    splits,
    cases: cases
      .filter((c) => runs.some((r) => r.caseId === c.id))
      .map((c) => {
        const mine = runs.filter((r) => r.caseId === c.id && r.ok);
        return {
          id: c.id,
          split: c.split,
          note: c.note,
          keys: sharedKeys(c).map(({ key, label }) => {
            const raised = mine.filter((r) =>
              r.keys.some(
                (k) =>
                  k.key === key && (k.outcome === "TP" || k.outcome === "FP"),
              ),
            ).length;
            return {
              key,
              label,
              raised: wilson(raised, mine.length),
              relations: tally(
                mine.map(
                  (r) => r.keys.find((k) => k.key === key)?.relation ?? "none",
                ),
              ),
            };
          }),
          correct: wilson(
            mine.filter((r) =>
              r.keys.every((k) => k.outcome === "TP" || k.outcome === "TN"),
            ).length,
            mine.length,
          ),
        };
      }),
    notes: meta.notes ?? [],
  };
}

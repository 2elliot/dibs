// Local validation of the model's Findings before submit_analysis. The reducer validates again
// server-side (docs/API.md rules 3, 5, 8); doing it here first means we never spend a submit on a
// finding the module will drop, and we get a logged reason for each drop.
import { RELATIONS } from "@dibs/protocol";
import type {
  AnalysisInput,
  Finding,
  Findings,
  Relation,
} from "@dibs/protocol";

export interface DroppedFinding {
  finding: Finding;
  reason: string;
  /** A valid finding deliberately ignored because its agreed basis has not changed. */
  ignored?: boolean;
}

/** A kept finding whose citations were trimmed to the lobby's current items on its own key. */
export interface RepairedFinding {
  key: string;
  removedIds: number[];
}

export interface ValidationResult {
  kept: Finding[];
  dropped: DroppedFinding[];
  repaired: RepairedFinding[];
}

/** The model's output is unusable. Not an Anthropic API error: the call itself succeeded. */
export class InvalidFindingsError extends Error {
  override name = "InvalidFindingsError";
}

const NEEDS_CONTRACT: ReadonlySet<Relation> = new Set<Relation>([
  "conflict",
  "dependency",
  "duplicate",
  "compatible",
]);

export function validateFindings(
  raw: Findings,
  input: AnalysisInput,
): ValidationResult {
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray(raw.findings) ||
    raw.findings.length > 100
  ) {
    throw new InvalidFindingsError(
      "invalid model findings: expected a findings array",
    );
  }
  const kept: Finding[] = [];
  const dropped: DroppedFinding[] = [];
  const repaired: RepairedFinding[] = [];

  const vocab = new Set(input.vocabulary.map((v) => v.key));
  const itemById = new Map(input.items.map((it) => [it.id, it]));
  const contractByKey = new Map(input.contracts.map((c) => [c.key, c]));
  const seenKeys = new Set<string>();

  const relations = new Set<string>(RELATIONS);

  for (const finding of raw.findings) {
    if (
      !finding ||
      typeof finding !== "object" ||
      typeof finding.key !== "string" ||
      typeof finding.relation !== "string" ||
      !Array.isArray(finding.citedItemIds) ||
      !finding.citedItemIds.every((id) => Number.isSafeInteger(id) && id > 0) ||
      typeof finding.explanation !== "string" ||
      !finding.explanation.trim() ||
      finding.explanation.length > 4000 ||
      typeof finding.contractText !== "string" ||
      finding.contractText.length > 4000
    )
      throw new InvalidFindingsError("invalid model finding fields");
    const drop = (reason: string) => dropped.push({ finding, reason });

    if (!relations.has(finding.relation)) {
      drop(`unknown relation "${finding.relation}"`);
      continue;
    }
    if (!vocab.has(finding.key)) {
      drop(`key "${finding.key}" is not in the vocabulary`);
      continue;
    }
    if (seenKeys.has(finding.key)) {
      drop(`duplicate finding for key "${finding.key}"`);
      continue;
    }

    // Rule 3: cited ids must exist in the lobby's current items. A stray id (nonexistent, or an
    // item on another key, e.g. the helper cited while explaining a route) is removed; the finding
    // survives if a citation on its own key remains. Required parties come from the reducer, not
    // from citations, so trimming them never changes who must respond.
    const allCited = finding.citedItemIds ?? [];
    if (allCited.length === 0) {
      drop(`${finding.relation} finding cites no items`);
      continue;
    }
    const cited = allCited.filter(
      (id) => itemById.get(id)?.key === finding.key,
    );
    const stray = allCited.filter(
      (id) => itemById.get(id)?.key !== finding.key,
    );
    if (cited.length === 0) {
      drop(`cites nonexistent item or wrong-key id(s) ${stray.join(", ")}`);
      continue;
    }

    // contractText presence.
    const hasText =
      typeof finding.contractText === "string" &&
      finding.contractText.trim() !== "";
    if (NEEDS_CONTRACT.has(finding.relation) && !hasText) {
      drop(`${finding.relation} finding has empty contractText`);
      continue;
    }

    // Rule 8: unchanged basis ids need no new handshake. The reducer has historical rows and
    // performs the authoritative text comparison when a new id is cited.
    const contract = contractByKey.get(finding.key);
    if (contract && contract.source === "agreed") {
      const basis = new Set(contract.basisItemIds);
      // Historical basis items are absent from AnalysisInput; the reducer compares their text.
      const bringsSomethingNew = cited.some((id) => !basis.has(id));
      if (!bringsSomethingNew) {
        dropped.push({
          finding,
          reason: `key ${finding.key} already has an agreed contract`,
          ignored: true,
        });
        continue;
      }
    }

    // Normalize: unowned carries no contract text; citations keep only the valid ids.
    const normalized: Finding = {
      ...finding,
      citedItemIds: cited,
      ...(finding.relation === "unowned" ? { contractText: "" } : {}),
    };
    if (stray.length) repaired.push({ key: finding.key, removedIds: stray });

    seenKeys.add(finding.key);
    kept.push(normalized);
  }

  return { kept, dropped, repaired };
}

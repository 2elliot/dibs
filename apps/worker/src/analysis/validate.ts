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
}

export interface ValidationResult {
  kept: Finding[];
  dropped: DroppedFinding[];
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
  const kept: Finding[] = [];
  const dropped: DroppedFinding[] = [];

  const vocab = new Set(input.vocabulary.map((v) => v.key));
  const itemById = new Map(input.items.map((it) => [it.id, it]));
  const contractByKey = new Map(input.contracts.map((c) => [c.key, c]));
  const seenKeys = new Set<string>();

  const relations = new Set<string>(RELATIONS);

  for (const finding of raw.findings ?? []) {
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

    // Rule 3: cited ids must exist in the lobby's current items.
    const cited = finding.citedItemIds ?? [];
    const missing = cited.filter((id) => !itemById.has(id));
    if (missing.length > 0) {
      drop(`cites nonexistent item id(s) ${missing.join(", ")}`);
      continue;
    }
    if (finding.relation !== "unowned" && cited.length === 0) {
      drop(`${finding.relation} finding cites no items`);
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

    // Rule 8: a key with a current agreed contract is only reopened if the finding cites an item
    // that is NOT in the contract's basis and whose text differs from the basis item for the same
    // participant. Otherwise it's a re-handshake and we drop it.
    const contract = contractByKey.get(finding.key);
    if (contract && contract.source === "agreed") {
      const basis = new Set(contract.basisItemIds);
      const basisByParticipant = new Map<number, string>();
      for (const id of contract.basisItemIds) {
        const it = itemById.get(id);
        if (it) basisByParticipant.set(it.participantId, it.text);
      }
      const bringsSomethingNew = cited.some((id) => {
        if (basis.has(id)) return false;
        const it = itemById.get(id);
        if (!it) return false;
        const prior = basisByParticipant.get(it.participantId);
        return prior === undefined || prior !== it.text;
      });
      if (!bringsSomethingNew) {
        drop(
          `key "${finding.key}" already has an agreed contract and the finding cites nothing new`,
        );
        continue;
      }
    }

    // Normalize: unowned carries no contract text.
    const normalized: Finding =
      finding.relation === "unowned"
        ? { ...finding, contractText: "" }
        : finding;

    seenKeys.add(finding.key);
    kept.push(normalized);
  }

  return { kept, dropped };
}

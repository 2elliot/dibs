// The prompt is the product. It turns an AnalysisInput into the request the model fills via
// FINDINGS_SCHEMA. Design goals (see prompt.design.md):
//   - one finding per SHARED key (a key some participant produces and another requires, or that
//     more than one participant touches); don't invent keys outside the vocabulary;
//   - contractText concrete enough to code against (routes, JSON shapes, header/cookie names,
//     status codes, exported names + signatures + file paths);
//   - cite only real plan_item ids;
//   - call `compatible` when the plans already agree, `unowned` when a requirement has no producer;
//   - treat a developer's stated requirement as non-negotiable (never "both sides compromise").
import { FINDINGS_SCHEMA, LIMITS } from "@dibs/protocol";
import type {
  AnalysisContract,
  AnalysisInput,
  AnalysisItem,
  AnalysisOpenProposal,
  AnalysisRejection,
  VocabularyEntry,
} from "@dibs/protocol";
import type { AnalysisRequest } from "../model/types.ts";

/** ~4000 output tokens per the plan; one place to tune. */
export const MAX_OUTPUT_TOKENS = 8000;

const SYSTEM = `You are the analysis service for "dibs", a tool that coordinates a team whose developers each run a different coding agent on their own machine. Each agent has published a short plan of what it will PRODUCE and what it REQUIRES, keyed by a fixed shared vocabulary. Your job is to compare these plans and, for every SHARED key, decide how the plans relate and write the single contract the affected developers should build against.

A key is shared when more than one participant has an item on it (for example one produces it and another requires it). Also analyze every unowned requirement: a key with at least one requires item and no produces item, even if only one participant touches it. Analyze only keys in the provided vocabulary. Ignore private produced keys with no other participant and no unowned requirement.

For each shared key, choose exactly one relation:
- "conflict": the plans make incompatible assumptions (e.g. one returns a bearer token, another expects a cookie). Write the contract that resolves it.
- "dependency": one side needs something the other must provide, and the details must be pinned down. Write the contract.
- "duplicate": two sides plan to build the same thing; the contract says who owns it and the exact interface.
- "compatible": the plans already agree. contractText states the agreed interface; no one has to change.
- "unowned": something is required but no participant produces it. contractText is "".

Pick the relation by the main problem, in this order, even when details also differ:
1. "duplicate" whenever two or more participants PRODUCE the same key: they each plan to build it. The contract names one owner, gives the exact interface, and says the others import it instead of writing their own.
2. "dependency" when a participant builds on another participant's module or library (exported functions, signatures, file paths, module format, events). The contract pins that interface down so both can build in parallel, even if their current assumptions differ.
3. "conflict" when the plans contradict each other on externally observable behavior: values, routes, methods, transports, or data shapes over the wire.

Rules you must follow:
- contractText must be precise enough to write code against: exact routes and methods, request and response JSON shapes, header or cookie names, status codes, exported function names with signatures, and file paths. No vague language.
- Cite only plan_item ids that appear in the input. The citedItemIds are your evidence; every finding except "unowned" must cite at least one real id.
- A developer's explicitly stated requirement is non-negotiable. Do not propose a contract that silently overrides it; if two stated requirements truly conflict, pick the one the charter favors (or the producer's, for its own output) and say so in the explanation.
- Output one finding per listed analysis key, no duplicates. Include unowned requirements even when only one participant requires them.
- Report through the report_findings tool only.`;

function keysOf(items: AnalysisItem[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const it of items) {
    if (!seen.has(it.key)) {
      seen.add(it.key);
      order.push(it.key);
    }
  }
  return order;
}

function renderVocabulary(vocab: VocabularyEntry[]): string {
  if (vocab.length === 0) return "(none)";
  return vocab.map((v) => `- ${v.key}: ${v.description}`).join("\n");
}

function renderItemsByKey(items: AnalysisItem[]): string {
  const keys = keysOf(items);
  if (keys.length === 0) return "(no plan items yet)";
  const blocks: string[] = [];
  for (const key of keys) {
    const forKey = items.filter((it) => it.key === key);
    const lines = forKey.map(
      (it) =>
        `  [item ${it.id}] ${it.participant} (${it.provider}) ${it.kind}: ${it.text}`,
    );
    blocks.push(`### ${key}\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

function renderContracts(contracts: AnalysisContract[]): string {
  if (contracts.length === 0) return "(none)";
  return contracts
    .map(
      (c) =>
        `- ${c.key} (${c.source}, rev ${c.revision}, basis items ${c.basisItemIds.join(", ") || "none"}): ${c.text}`,
    )
    .join("\n");
}

function renderOpenProposals(proposals: AnalysisOpenProposal[]): string {
  if (proposals.length === 0) return "(none)";
  return proposals
    .map(
      (p) =>
        `- P${p.id} ${p.key} (rev ${p.revision}, cites ${p.citedItemIds.join(", ")}): ${p.contractText}`,
    )
    .join("\n");
}

function renderRejections(rejections: AnalysisRejection[]): string {
  if (rejections.length === 0) return "(none)";
  return rejections
    .map(
      (r) =>
        `- ${r.participant} rejected P${r.proposalId} for ${r.key} (rev ${r.revision}): ${r.reason}`,
    )
    .join("\n");
}

export function buildUserPrompt(input: AnalysisInput): string {
  const shared = keysOf(input.items).filter(
    (key) =>
      new Set(
        input.items.filter((i) => i.key === key).map((i) => i.participantId),
      ).size > 1 ||
      (input.items.some((i) => i.key === key && i.kind === "requires") &&
        !input.items.some((i) => i.key === key && i.kind === "produces")),
  );
  const reviseNote =
    input.jobKind === "revise"
      ? `\nThis is a REVISE job: a proposal was rejected (below). Produce a new contract for the rejected key that addresses the stated reason. Keep every other key unchanged unless its plan items changed.\n`
      : "";

  return `# Charter

${input.charter}

# Shared key vocabulary

${renderVocabulary(input.vocabulary)}

# Current plan items, grouped by key

${renderItemsByKey(input.items)}

# Keys to analyze (shared keys and unowned requirements)

${shared.length ? shared.map((k) => `- ${k}`).join("\n") : "(none yet)"}

# Existing agreed/aligned contracts (do not re-open unless a cited item's text changed)

${renderContracts(input.contracts)}

# Open proposals awaiting responses

${renderOpenProposals(input.openProposals)}

# Rejections to answer

${renderRejections(input.rejections)}
${reviseNote}
Return one finding per listed analysis key through report_findings. Each finding: key, relation, citedItemIds (real ids above, including for unowned), explanation, contractText (concrete; "" only for unowned).`;
}

export function buildAnalysisRequest(input: AnalysisInput): AnalysisRequest {
  // Guard against a plan that blew past the item cap before it reaches the model.
  const overflow =
    input.items.length >
    LIMITS.planItems * input.vocabulary.length + LIMITS.planItems;
  if (overflow) {
    // Not fatal — the model still gets everything — but worth noting in the explanation space.
  }
  return {
    system: SYSTEM,
    user: buildUserPrompt(input),
    schema: FINDINGS_SCHEMA,
    maxTokens: MAX_OUTPUT_TOKENS,
  };
}

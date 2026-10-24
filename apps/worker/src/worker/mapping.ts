// Pure row -> AnalysisInput mapping, split out from the live connection so it can be unit-tested
// with synthetic rows (no SpacetimeDB server needed). The row interfaces mirror the generated
// bindings' camelCase fields; u64 columns arrive as bigint, u32 as number.
import type {
  AnalysisContract,
  AnalysisInput,
  AnalysisItem,
  AnalysisOpenProposal,
  AnalysisRejection,
  JobKind,
  Provider,
  VocabularyEntry,
} from "@dibs/protocol";

export interface RowJob {
  id: number;
  lobbyId: number;
  kind: string;
  state: string;
  inputKey: string;
  leaseExpiresUs: bigint;
  updatedAtUs: bigint;
}
export interface RowLobby {
  id: number;
  charter: string;
  vocabulary: string[];
  vocabularyJson: string;
  fallbackAtUs: bigint;
}
export interface RowPlan {
  id: number;
  lobbyId: number;
  participantId: number;
  revision: number;
  current: boolean;
}
export interface RowPlanItem {
  id: number;
  planId: number;
  lobbyId: number;
  participantId: number;
  kind: string;
  key: string;
  text: string;
  current: boolean;
}
export interface RowParticipant {
  id: number;
  name: string;
  provider: string;
}
export interface RowContract {
  id: number;
  lobbyId: number;
  key: string;
  revision: number;
  text: string;
  source: string;
  basisItemIds: number[];
  current: boolean;
}
export interface RowProposal {
  id: number;
  lobbyId: number;
  key: string;
  revision: number;
  contractText: string;
  citedItemIds: number[];
  requiredPartyIds: number[];
  state: string;
}
export interface RowResponse {
  id: number;
  lobbyId: number;
  proposalId: number;
  revision: number;
  participantId: number;
  decision: string;
  reason: string;
}

export interface LobbyRows {
  job: RowJob[];
  lobby: RowLobby[];
  plan: RowPlan[];
  planItem: RowPlanItem[];
  participant: RowParticipant[];
  contract: RowContract[];
  proposal: RowProposal[];
  response: RowResponse[];
}

/** A `queued` job, or a `leased` job whose lease has expired (so a crashed worker's job retries). */
export function pickLeasableJob(jobs: RowJob[], nowUs: bigint): RowJob | null {
  for (const j of jobs) {
    if (j.state === "queued") return j;
    if (j.state === "leased" && j.leaseExpiresUs < nowUs) return j;
  }
  return null;
}

export function parseVocabulary(lobby: RowLobby): VocabularyEntry[] {
  if (lobby.vocabularyJson) {
    try {
      const parsed = JSON.parse(lobby.vocabularyJson) as VocabularyEntry[];
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to the string list
    }
  }
  return (lobby.vocabulary ?? []).map((key) => ({ key, description: "" }));
}

export function assembleAnalysisInput(
  jobId: number,
  rows: LobbyRows,
): AnalysisInput {
  const job = rows.job.find((j) => j.id === jobId);
  if (!job) throw new Error(`job ${jobId} not found in cache`);
  const lobby = rows.lobby.find((l) => l.id === job.lobbyId);
  if (!lobby) throw new Error(`lobby ${job.lobbyId} not found in cache`);

  const participantById = new Map(rows.participant.map((p) => [p.id, p]));
  const planById = new Map(
    rows.plan.filter((p) => p.current).map((p) => [p.id, p]),
  );

  const items: AnalysisItem[] = rows.planItem
    .filter((it) => it.lobbyId === lobby.id && it.current)
    .map((it) => {
      const participant = participantById.get(it.participantId);
      const plan = planById.get(it.planId);
      return {
        id: it.id,
        planId: it.planId,
        planRevision: plan?.revision ?? 0,
        participantId: it.participantId,
        participant: participant?.name ?? `#${it.participantId}`,
        provider: (participant?.provider ?? "claude") as Provider,
        kind: it.kind as AnalysisItem["kind"],
        key: it.key,
        text: it.text,
      };
    });

  const contracts: AnalysisContract[] = rows.contract
    .filter((c) => c.lobbyId === lobby.id && c.current)
    .map((c) => ({
      id: c.id,
      key: c.key,
      revision: c.revision,
      text: c.text,
      source: c.source as AnalysisContract["source"],
      basisItemIds: c.basisItemIds,
    }));

  const openProposals: AnalysisOpenProposal[] = rows.proposal
    .filter((p) => p.lobbyId === lobby.id && p.state === "proposed")
    .map((p) => ({
      id: p.id,
      key: p.key,
      revision: p.revision,
      contractText: p.contractText,
      citedItemIds: p.citedItemIds,
      requiredPartyIds: p.requiredPartyIds,
    }));

  let rejections: AnalysisRejection[] = [];
  if (job.kind === "revise") {
    const proposalById = new Map(rows.proposal.map((p) => [p.id, p]));
    rejections = rows.response
      .filter((r) => r.lobbyId === lobby.id && r.decision === "reject")
      .map((r) => {
        const proposal = proposalById.get(r.proposalId);
        const participant = participantById.get(r.participantId);
        return {
          proposalId: r.proposalId,
          key: proposal?.key ?? "",
          revision: r.revision,
          participant: participant?.name ?? `#${r.participantId}`,
          reason: r.reason,
        };
      })
      .filter((r) => r.key !== "");
  }

  return {
    lobbyId: lobby.id,
    jobId: job.id,
    jobKind: job.kind as JobKind,
    inputKey: job.inputKey,
    charter: lobby.charter,
    vocabulary: parseVocabulary(lobby),
    items,
    contracts,
    openProposals,
    rejections,
  };
}

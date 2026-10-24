import { describe, it, expect } from "vitest";
import {
  assembleAnalysisInput,
  parseVocabulary,
  pickLeasableJob,
  type LobbyRows,
  type RowJob,
} from "../src/worker/mapping.ts";

function baseRows(): LobbyRows {
  return {
    job: [
      {
        id: 10,
        lobbyId: 1,
        kind: "analyze",
        state: "queued",
        inputKey: "p:1,2;r:",
        leaseExpiresUs: 0n,
        updatedAtUs: 5_000_000n,
      },
    ],
    lobby: [
      {
        id: 1,
        charter: "Implement login.",
        vocabulary: ["auth.session"],
        vocabularyJson: JSON.stringify([
          { key: "auth.session", description: "transport" },
        ]),
        fallbackAtUs: 9_000_000n,
      },
    ],
    plan: [
      { id: 100, lobbyId: 1, participantId: 1, revision: 2, current: true },
      { id: 200, lobbyId: 1, participantId: 2, revision: 1, current: true },
    ],
    planItem: [
      {
        id: 1,
        planId: 100,
        lobbyId: 1,
        participantId: 1,
        kind: "produces",
        key: "auth.session",
        text: "bearer",
        current: true,
      },
      {
        id: 2,
        planId: 200,
        lobbyId: 1,
        participantId: 2,
        kind: "requires",
        key: "auth.session",
        text: "cookie",
        current: true,
      },
      {
        id: 3,
        planId: 100,
        lobbyId: 1,
        participantId: 1,
        kind: "produces",
        key: "old",
        text: "stale",
        current: false,
      },
    ],
    participant: [
      { id: 1, name: "claude", provider: "claude" },
      { id: 2, name: "codex", provider: "codex" },
    ],
    contract: [
      {
        id: 5,
        lobbyId: 1,
        key: "auth.server",
        revision: 1,
        text: "helper",
        source: "agreed",
        basisItemIds: [9],
        current: true,
      },
    ],
    proposal: [
      {
        id: 7,
        lobbyId: 1,
        key: "auth.session",
        revision: 1,
        contractText: "bearer",
        citedItemIds: [1, 2],
        requiredPartyIds: [1, 2],
        state: "proposed",
      },
      {
        id: 8,
        lobbyId: 1,
        key: "x",
        revision: 1,
        contractText: "",
        citedItemIds: [],
        requiredPartyIds: [],
        state: "accepted",
      },
    ],
    response: [
      {
        id: 20,
        lobbyId: 1,
        proposalId: 7,
        revision: 1,
        participantId: 2,
        decision: "reject",
        reason: "need cookie",
      },
    ],
  };
}

describe("pickLeasableJob", () => {
  const now = 10_000_000n;
  it("returns a queued job", () => {
    const jobs: RowJob[] = [
      {
        id: 1,
        lobbyId: 1,
        kind: "analyze",
        state: "queued",
        inputKey: "",
        leaseExpiresUs: 0n,
        updatedAtUs: 0n,
      },
    ];
    expect(pickLeasableJob(jobs, now)?.id).toBe(1);
  });
  it("returns a leased job whose lease expired, but not a live one", () => {
    const expired: RowJob = {
      id: 2,
      lobbyId: 1,
      kind: "analyze",
      state: "leased",
      inputKey: "",
      leaseExpiresUs: 9_000_000n,
      updatedAtUs: 0n,
    };
    const live: RowJob = {
      id: 3,
      lobbyId: 1,
      kind: "analyze",
      state: "leased",
      inputKey: "",
      leaseExpiresUs: 11_000_000n,
      updatedAtUs: 0n,
    };
    expect(pickLeasableJob([live, expired], now)?.id).toBe(2);
    expect(pickLeasableJob([live], now)).toBeNull();
  });
  it("ignores done/failed jobs", () => {
    const jobs: RowJob[] = [
      {
        id: 4,
        lobbyId: 1,
        kind: "analyze",
        state: "done",
        inputKey: "",
        leaseExpiresUs: 0n,
        updatedAtUs: 0n,
      },
    ];
    expect(pickLeasableJob(jobs, now)).toBeNull();
  });
});

describe("parseVocabulary", () => {
  it("prefers vocabularyJson", () => {
    const vocab = parseVocabulary(baseRows().lobby[0]);
    expect(vocab).toEqual([{ key: "auth.session", description: "transport" }]);
  });
  it("falls back to the string list when json is empty", () => {
    const vocab = parseVocabulary({
      id: 1,
      charter: "",
      vocabulary: ["a", "b"],
      vocabularyJson: "",
      fallbackAtUs: 0n,
    });
    expect(vocab).toEqual([
      { key: "a", description: "" },
      { key: "b", description: "" },
    ]);
  });
});

describe("assembleAnalysisInput", () => {
  it("maps current items with plan revision and participant identity", () => {
    const input = assembleAnalysisInput(10, baseRows());
    expect(input.lobbyId).toBe(1);
    expect(input.jobKind).toBe("analyze");
    expect(input.inputKey).toBe("p:1,2;r:");
    // only current items
    expect(input.items.map((i) => i.id).sort()).toEqual([1, 2]);
    const claudeItem = input.items.find((i) => i.id === 1)!;
    expect(claudeItem.participant).toBe("claude");
    expect(claudeItem.provider).toBe("claude");
    expect(claudeItem.planRevision).toBe(2);
  });

  it("includes current contracts and only open proposals", () => {
    const input = assembleAnalysisInput(10, baseRows());
    expect(input.contracts.map((c) => c.key)).toEqual(["auth.server"]);
    expect(input.openProposals.map((p) => p.id)).toEqual([7]); // not the accepted #8
  });

  it("omits rejections for analyze jobs and includes them for revise jobs", () => {
    const analyze = assembleAnalysisInput(10, baseRows());
    expect(analyze.rejections).toHaveLength(0);

    const rows = baseRows();
    rows.job[0].kind = "revise";
    const revise = assembleAnalysisInput(10, rows);
    expect(revise.rejections).toEqual([
      {
        proposalId: 7,
        key: "auth.session",
        revision: 1,
        participant: "codex",
        reason: "need cookie",
      },
    ]);
  });
});

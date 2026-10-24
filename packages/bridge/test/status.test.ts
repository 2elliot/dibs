import { describe, expect, it } from "vitest";
import { canonical, settleCall } from "../src/calls.ts";
import {
  emptyWorld,
  computeStatus,
  keyStatus,
  normalizeWorld,
  phaseOf,
  type World,
} from "../src/world.ts";

function world(patch: Partial<World> = {}): World {
  return {
    ...emptyWorld("claude", "claude"),
    meId: 1,
    online: true,
    offlineSinceUs: undefined,
    lobby: {
      id: 3,
      mode: "dibs",
      state: "running",
      vocabulary: ["auth.session", "events.registration"],
      fallbackAtUs: 10_000_000,
      endsAtUs: 20_000_000,
      startedAtUs: 1,
      buildHash: "abc",
      baseSha: "def",
    },
    participants: [
      {
        id: 1,
        name: "claude",
        provider: "claude",
        role: "agent",
        online: true,
        currentLobbyId: 3,
      },
      {
        id: 2,
        name: "codex",
        provider: "codex",
        role: "agent",
        online: false,
        currentLobbyId: 3,
      },
    ],
    ...patch,
  };
}

describe("status", () => {
  it("canonicalizes objects the way the module does", () => {
    expect(canonical({ b: 1, a: "x" })).toBe('{"a":"x","b":1}');
    expect(canonical([1, { b: 1, a: 2 }])).toBe('[1,{"a":2,"b":1}]');
  });

  it("maps reducer failures", async () => {
    const timeout = await settleCall("r1", () => new Promise(() => {}), 20);
    expect(timeout).toEqual({ status: "pending", requestId: "r1" });
    const dropped = await settleCall("r2", () => {
      const error = new Error("socket closed");
      error.name = "DisconnectedError";
      throw error;
    });
    expect(dropped.status).toBe("offline");
    const unknown = await settleCall("r3", () => {
      const error = new Error("unknown");
      error.name = "UnknownCallResultError";
      throw error;
    });
    expect(unknown.status).toBe("pending");
    const rejected = await settleCall("r4", () =>
      Promise.reject(new Error("unknown vocabulary key")),
    );
    expect(rejected).toMatchObject({
      status: "error",
      error: "unknown vocabulary key",
    });
  });

  it("maps job state to phase", () => {
    expect(phaseOf(null)).toBe("ready");
    expect(phaseOf({ state: "debouncing" })).toBe("waiting_for_peers");
    expect(phaseOf({ state: "queued" })).toBe("analyzing");
    expect(phaseOf({ state: "leased" })).toBe("analyzing");
    expect(phaseOf({ state: "done" })).toBe("ready");
    expect(phaseOf({ state: "failed" })).toBe("ready");
  });

  it("reports every touched key as pending until the phase is ready", () => {
    expect(
      keyStatus(
        "analyzing",
        { source: "agreed" } as never,
        undefined,
        undefined,
      ),
    ).toBe("pending");
    expect(
      keyStatus(
        "ready",
        { source: "agreed" } as never,
        { id: 1 } as never,
        undefined,
      ),
    ).toBe("agreed");
    expect(
      keyStatus("ready", { source: "aligned" } as never, undefined, undefined),
    ).toBe("aligned");
    expect(
      keyStatus("ready", undefined, { id: 1 } as never, { id: 2 } as never),
    ).toBe("proposed");
    expect(keyStatus("ready", undefined, undefined, { id: 2 } as never)).toBe(
      "escalated",
    );
    expect(keyStatus("ready", undefined, undefined, undefined)).toBe("clear");
  });

  it("builds dibs_status from the snapshot", () => {
    const status = computeStatus(
      world({
        items: [
          {
            id: 10,
            planId: 1,
            lobbyId: 3,
            participantId: 1,
            kind: "produces",
            key: "auth.session",
            text: "cookie",
            current: true,
          },
          {
            id: 11,
            planId: 2,
            lobbyId: 3,
            participantId: 2,
            kind: "requires",
            key: "auth.session",
            text: "bearer",
            current: true,
          },
        ],
        plans: [
          {
            id: 1,
            lobbyId: 3,
            participantId: 1,
            revision: 1,
            goal: "login",
            notes: "",
            requestId: "p",
            current: true,
          },
        ],
        job: { id: 1, lobbyId: 3, state: "done", kind: "analyze" },
        proposals: [
          {
            id: 7,
            lobbyId: 3,
            key: "auth.session",
            revision: 1,
            relation: "conflict",
            contractText: "use a cookie",
            rationale: "they disagree",
            citedItemIds: [10, 11],
            requiredPartyIds: [1, 2],
            state: "proposed",
          },
        ],
        messages: [
          {
            id: 5,
            lobbyId: 3,
            fromId: 2,
            to: "all",
            text: "which cookie?",
            createdAtUs: 50,
          },
        ],
      }),
      [],
      0,
    );
    expect(status.phase).toBe("ready");
    expect(status.keys).toEqual([
      {
        key: "auth.session",
        status: "proposed",
        proposalId: 7,
        revision: 1,
        contractText: "use a cookie",
      },
    ]);
    expect(status.awaitingYou[0]?.basis.map((row) => row.participant)).toEqual([
      "claude",
      "codex",
    ]);
    expect(status.messages).toEqual([
      { from: "codex", text: "which cookie?", atUs: 50 },
    ]);
    expect(status.fallbackInSec).toBe(10);
    expect(status.roster).toEqual([
      { name: "claude", provider: "claude", online: true, hasPlan: true },
      { name: "codex", provider: "codex", online: false, hasPlan: false },
    ]);
    const seen = computeStatus(
      world({
        messages: [
          {
            id: 5,
            lobbyId: 3,
            fromId: 2,
            to: "all",
            text: "which cookie?",
            createdAtUs: 50,
          },
        ],
      }),
      [5],
      10_000_000,
    );
    expect(seen.messages).toEqual([]);
    expect(seen.fallbackInSec).toBe(0);
  });

  it("normalizes bigint and snake_case rows", () => {
    const normalized = normalizeWorld(
      {
        participant: [
          {
            id: 1n,
            name: "claude",
            provider: "claude",
            role: "agent",
            online: true,
            current_lobby_id: 4n,
          },
        ],
        lobby: [
          {
            id: 4n,
            mode: "dibs",
            state: "running",
            vocabulary: ["auth.session"],
            fallback_at_us: 5_000_000n,
            ends_at_us: 9n,
            started_at_us: 1n,
            build_hash: "abc",
            base_sha: "def",
          },
        ],
        response: [
          {
            lobby_id: 4,
            proposal_id: 7,
            revision: 1,
            participant_id: 1,
            decision: "accept",
          },
        ],
      },
      "claude",
      "claude",
      4,
      true,
    );
    expect(normalized.meId).toBe(1);
    expect(normalized.lobby?.fallbackAtUs).toBe(5_000_000);
    expect(normalized.responses).toEqual([
      { proposalId: 7, revision: 1, participantId: 1, decision: "accept" },
    ]);
  });
});

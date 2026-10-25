import { describe, expect, it } from "vitest";
import { loadManifest } from "../src/manifest.ts";
import { fixtureDir } from "../src/paths.ts";
import {
  computeMetrics,
  parseDiff,
  transcriptUsage,
  type LobbyDump,
} from "../src/metrics.ts";
import { compare, toCsv, toMarkdown } from "../src/compare.ts";
import { normalizeDump } from "../src/metrics-cli.ts";
import {
  bootstrapMeanDiff,
  fisherExact,
  summarize,
  trialsNeeded,
  wilson,
} from "../src/stats.ts";

const manifest = loadManifest(fixtureDir);
const T0 = Date.parse("2026-10-24T02:50:00Z") * 1000;
const s = (sec: number) => T0 + sec * 1e6;
const checks = (failing: number[] = []) =>
  [1, 2, 3, 4, 5, 6].map((c) => ({
    check: c,
    name: `c${c}`,
    ok: !failing.includes(c),
  }));

function dump(mode: string, lobbyId = 7): LobbyDump {
  return {
    lobby: [
      {
        id: lobbyId,
        scenario: "s2",
        mode,
        baseSha: "f4001dc",
        buildHash: "ac6c",
        startedAtUs: s(0),
        endsAtUs: s(900),
        analyzeAnywayFired: false,
      },
    ],
    participant: [
      {
        id: 1,
        name: "claude",
        provider: "claude",
        role: "agent",
        currentLobbyId: lobbyId,
      },
      {
        id: 2,
        name: "codex",
        provider: "codex",
        role: "agent",
        currentLobbyId: lobbyId,
      },
      {
        id: 3,
        name: "droid",
        provider: "droid",
        role: "agent",
        currentLobbyId: lobbyId,
      },
      {
        id: 9,
        name: "verifier",
        provider: "claude",
        role: "verifier",
        currentLobbyId: null,
      },
    ],
    plan: [
      {
        id: 1,
        lobbyId,
        participantId: 1,
        revision: 1,
        current: true,
        createdAtUs: s(30),
      },
      {
        id: 2,
        lobbyId,
        participantId: 2,
        revision: 1,
        current: false,
        createdAtUs: s(45),
      },
      {
        id: 3,
        lobbyId,
        participantId: 2,
        revision: 2,
        current: true,
        createdAtUs: s(200),
      },
      {
        id: 4,
        lobbyId,
        participantId: 3,
        revision: 1,
        current: true,
        createdAtUs: s(60),
      },
    ],
    planItem: [
      {
        id: 1,
        planId: 1,
        lobbyId,
        participantId: 1,
        kind: "produces",
        key: "auth.session",
        current: true,
      },
      {
        id: 2,
        planId: 3,
        lobbyId,
        participantId: 2,
        kind: "requires",
        key: "auth.session",
        current: true,
      },
      {
        id: 3,
        planId: 4,
        lobbyId,
        participantId: 3,
        kind: "requires",
        key: "auth.server",
        current: true,
      },
      {
        id: 4,
        planId: 1,
        lobbyId,
        participantId: 1,
        kind: "produces",
        key: "auth.server",
        current: true,
      },
      {
        id: 5,
        planId: 2,
        lobbyId,
        participantId: 2,
        kind: "requires",
        key: "auth.session",
        current: false,
      },
    ],
    message: [
      {
        id: 1,
        lobbyId,
        fromId: 2,
        to: "claude",
        text: "x",
        createdAtUs: s(100),
      },
    ],
    job: [{ id: 1, lobbyId, kind: "analyze", state: "done", calls: 2 }],
    proposal: [
      {
        id: 1,
        lobbyId,
        key: "auth.session",
        revision: 1,
        state: "superseded",
        requiredPartyIds: [1, 2],
        createdAtUs: s(90),
      },
      {
        id: 2,
        lobbyId,
        key: "auth.session",
        revision: 2,
        state: "accepted",
        requiredPartyIds: [1, 2],
        createdAtUs: s(150),
      },
    ],
    response: [
      {
        id: 1,
        lobbyId,
        proposalId: 1,
        participantId: 2,
        decision: "reject",
        createdAtUs: s(110),
      },
      {
        id: 2,
        lobbyId,
        proposalId: 2,
        participantId: 1,
        decision: "accept",
        createdAtUs: s(160),
      },
      {
        id: 3,
        lobbyId,
        proposalId: 2,
        participantId: 2,
        decision: "accept",
        createdAtUs: s(170),
      },
    ],
    contract: [
      {
        id: 1,
        lobbyId,
        key: "auth.server",
        source: "aligned",
        current: true,
        createdAtUs: s(95),
      },
      {
        id: 2,
        lobbyId,
        key: "auth.session",
        source: "agreed",
        current: true,
        createdAtUs: s(170),
      },
    ],
    delivery: [
      {
        id: 1,
        lobbyId,
        targetId: 2,
        kind: "proposal",
        queuedAtUs: s(90),
        receivedAtUs: s(91),
        shownAtUs: s(100),
        respondedAtUs: s(110),
      },
      {
        id: 2,
        lobbyId,
        targetId: 1,
        kind: "proposal",
        queuedAtUs: s(150),
        receivedAtUs: s(150.5),
        shownAtUs: s(155),
        respondedAtUs: s(160),
      },
      {
        id: 3,
        lobbyId,
        targetId: 3,
        kind: "aligned",
        queuedAtUs: s(95),
        receivedAtUs: s(96),
        shownAtUs: 0,
        respondedAtUs: 0,
      },
    ],
    head: [
      { id: 1, lobbyId, participantId: 1, sha: "a", createdAtUs: s(600) },
      { id: 2, lobbyId, participantId: 2, sha: "b", createdAtUs: s(700) },
      { id: 3, lobbyId, participantId: 3, sha: "c", createdAtUs: s(650) },
    ],
    // Rows of another lobby are ignored.
    event: [
      { id: 1, lobbyId: 99, atUs: s(1), actor: "x", type: "plan_published" },
    ],
  };
}

const diff = [
  "diff --git a/src/auth/index.js b/src/auth/index.js",
  "--- a/src/auth/index.js",
  "+++ b/src/auth/index.js",
  "@@ -1,2 +1,3 @@",
  "-old",
  "+new",
  "+more",
  "diff --git a/public/app.js b/public/app.js",
  "--- a/public/app.js",
  "+++ b/public/app.js",
  "+ui",
  "diff --git a/src/events/old.js b/src/events/old.js",
  "--- a/src/events/old.js",
  "+++ /dev/null",
  "-gone",
  "-gone2",
].join("\n");

const jsonl = (...lines: unknown[]) =>
  lines.map((l) => JSON.stringify(l)).join("\n");
const claudeLog = jsonl(
  {
    type: "assistant",
    timestamp: "2026-10-24T02:50:10Z",
    message: {
      id: "m1",
      role: "assistant",
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 50,
        output_tokens: 20,
      },
      content: [{ type: "text" }],
    },
  },
  // Same message id on its next content block: counted once.
  {
    type: "assistant",
    timestamp: "2026-10-24T02:50:11Z",
    message: {
      id: "m1",
      role: "assistant",
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 50,
        output_tokens: 20,
      },
      content: [{ type: "tool_use", name: "Edit", input: {} }],
    },
  },
  {
    type: "assistant",
    timestamp: "2026-10-24T02:52:10Z",
    message: {
      id: "m2",
      role: "assistant",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "tool_use", name: "Bash", input: {} }],
    },
  },
  {
    type: "user",
    timestamp: "2026-10-24T02:52:11Z",
    message: { role: "user", content: [{ type: "tool_result" }] },
  },
);
const codexLog = jsonl(
  {
    timestamp: "2026-10-24T02:50:00Z",
    type: "response_item",
    payload: { type: "function_call", name: "shell" },
  },
  {
    timestamp: "2026-10-24T02:51:00Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 500,
          cached_input_tokens: 300,
          output_tokens: 40,
          reasoning_output_tokens: 10,
        },
      },
    },
  },
  {
    timestamp: "2026-10-24T02:52:00Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 900,
          cached_input_tokens: 600,
          output_tokens: 70,
          reasoning_output_tokens: 30,
        },
      },
    },
  },
  // A relaunch: the counter restarts, and the launches add up.
  {
    timestamp: "2026-10-24T02:55:00Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 0,
        },
      },
    },
  },
  {
    timestamp: "2026-10-24T02:55:30Z",
    type: "response_item",
    payload: { type: "custom_tool_call", name: "apply_patch" },
  },
);

describe("stats", () => {
  it("Wilson intervals behave at the edges", () => {
    const all = wilson(6, 6);
    expect(all.rate).toBe(1);
    expect(all.low).toBeCloseTo(0.61, 2);
    expect(all.high).toBe(1);
    const none = wilson(0, 10);
    expect(none.low).toBe(0);
    expect(none.high).toBeCloseTo(0.2775, 3);
    expect(wilson(0, 0).rate).toBeNull();
  });

  it("Fisher's exact test matches the textbook value", () => {
    expect(fisherExact(1, 9, 11, 3)).toBeCloseTo(0.002759, 5);
    expect(fisherExact(1, 0, 0, 1)).toBeCloseTo(1, 6);
  });

  it("summaries, bootstrap and trials needed", () => {
    const sm = summarize([1, 2, 3, 4, null]);
    expect(sm).toMatchObject({ n: 4, mean: 2.5, median: 2.5, min: 1, max: 4 });
    expect(sm.sd).toBeCloseTo(1.291, 3);
    const d = bootstrapMeanDiff([1, 2, 3, 2], [5, 6, 7, 6]);
    expect(d.delta).toBe(4);
    expect(d.low!).toBeGreaterThan(2.5);
    expect(d.high!).toBeLessThan(5.5);
    expect(bootstrapMeanDiff([1], [2])).toMatchObject({ delta: 1, low: null });
    expect(trialsNeeded(0.2, 0.8)).toBe(10);
  });
});

describe("parsers", () => {
  it("counts diff lines per file, deletes included", () => {
    expect(parseDiff(diff)).toEqual([
      { path: "src/auth/index.js", added: 2, removed: 1 },
      { path: "public/app.js", added: 1, removed: 0 },
      { path: "src/events/old.js", added: 0, removed: 2 },
    ]);
  });

  it("reads Claude Code usage once per message", () => {
    const u = transcriptUsage(claudeLog);
    expect(u.format).toBe("claude");
    expect(u).toMatchObject({
      inputTokens: 160,
      cachedInputTokens: 1000,
      outputTokens: 25,
      totalTokens: 1185,
      toolCalls: 2,
    });
    expect((u.lastAtUs! - u.firstAtUs!) / 1e6).toBe(121);
  });

  it("reads Codex's running totals and adds relaunches", () => {
    const u = transcriptUsage(codexLog);
    expect(u.format).toBe("codex");
    expect(u).toMatchObject({
      inputTokens: 1000,
      cachedInputTokens: 600,
      outputTokens: 110,
      toolCalls: 2,
    });
  });

  it("normalizes a snake_case SQL dump", () => {
    const d = normalizeDump({ plan_item: [{ plan_id: 1, lobby_id: 7 }] });
    expect(d.planItem).toEqual([{ planId: 1, lobbyId: 7 }]);
  });
});

describe("computeMetrics", () => {
  const m = computeMetrics({
    lobbyId: 7,
    dump: dump("dibs"),
    report: {
      passed: 6,
      total: 6,
      checks: checks(),
      mergeTreeClean: true,
      outOfArea: { claude: [], codex: ["README.md"], droid: [] },
      durationMs: 41_000,
      oracleHash: "h1",
      missingProviders: [],
    },
    review: {
      clauses: [
        { key: "auth.session", verdict: "conforms" },
        { key: "auth.server", verdict: "conforms" },
        { key: "events.registration", verdict: "violates" },
      ],
      rootCause: null,
    },
    timing: {
      lobbyId: 7,
      createdAt: "",
      providers: [
        {
          provider: "codex",
          verdict: "built-after-contract",
          contractAtUs: s(170),
          contractKind: "contract",
          contractStage: "shown",
          fallbackAtUs: null,
          firstSharedEditAtUs: s(300),
          lastSharedEditAtUs: s(500),
          sharedEditsBefore: 0,
          sharedEditsAfter: 2,
          edits: [],
        },
        {
          provider: "claude",
          verdict: "no-transcript",
          contractAtUs: s(170),
          contractKind: "contract",
          contractStage: "shown",
          fallbackAtUs: null,
          firstSharedEditAtUs: null,
          lastSharedEditAtUs: null,
          sharedEditsBefore: 0,
          sharedEditsAfter: 0,
          edits: [],
        },
      ],
    },
    diff,
    manifest,
    transcripts: { claude: claudeLog, codex: codexLog },
    interventions: 0,
  });

  it("finds the agents and skips the verifier", () => {
    expect(m.agents).toEqual(["claude", "codex", "droid"]);
    expect(m.mode).toBe("dibs");
  });

  it("outcome", () => {
    expect(m.outcome).toMatchObject({
      passed: 6,
      passRate: 1,
      fullPass: true,
      mergeTreeClean: true,
      outOfAreaFiles: 1,
      oracleSec: 41,
      reviewConforms: 2,
      reviewViolations: 1,
    });
  });

  it("time, in seconds after the start", () => {
    expect(m.time).toMatchObject({
      lobbySec: 900,
      firstPlanSec: 30,
      allPlansSec: 60,
      firstProposalSec: 90,
      firstContractSec: 95,
      allSettledSec: 170,
      lastEditSec: 500,
      lastHeadSec: 700,
      fallbackFired: false,
    });
  });

  it("coordination", () => {
    expect(m.coordination).toMatchObject({
      planRevisions: 4,
      planItems: 4,
      messages: 1,
      proposals: 2,
      proposalRounds: 2,
      responses: 3,
      rejects: 1,
      contractsAgreed: 1,
      contractsAligned: 1,
      sharedKeys: 2,
      settledKeys: 2,
      analysisJobs: 1,
      analysisCalls: 2,
      deliveries: 3,
    });
    expect(m.coordination.responseLatency).toEqual({
      n: 2,
      medianMs: 7500,
      maxMs: 10000,
    });
    expect(m.coordination.receiveLatency.n).toBe(3);
    const session = m.keys.find((k) => k.key === "auth.session")!;
    expect(session).toMatchObject({
      producers: ["claude"],
      consumers: ["codex"],
      outcome: "agreed",
      rounds: 2,
      rejects: 1,
      firstProposalSec: 90,
      settledSec: 170,
    });
  });

  it("work by area, and edits around the contract", () => {
    expect(m.work).toMatchObject({
      linesAdded: 3,
      linesRemoved: 3,
      filesChanged: 3,
      sharedEditsBeforeContract: 0,
      sharedEditsAfterContract: 2,
      postContractShare: 1,
    });
    const claude = m.perAgent.find((a) => a.name === "claude")!;
    expect(claude).toMatchObject({
      linesAdded: 2,
      linesRemoved: 1,
      filesChanged: 1,
      sharedEditsBeforeContract: null,
      timingVerdict: "no-transcript",
      planRevisions: 1,
      responses: 1,
    });
    expect(m.perAgent.find((a) => a.name === "codex")).toMatchObject({
      planRevisions: 2,
      messagesSent: 1,
      rejects: 1,
      outOfAreaFiles: 1,
      linesAdded: 1,
    });
  });

  it("cost sums only what was measured", () => {
    expect(m.cost).toMatchObject({
      inputTokens: 1160,
      outputTokens: 135,
      toolCalls: 4,
    });
    expect(m.perAgent.find((a) => a.name === "droid")!.totalTokens).toBeNull();
    expect(m.sources).toMatchObject({
      db: true,
      report: true,
      timing: true,
      review: true,
      diff: true,
      transcripts: ["claude", "codex"],
    });
  });

  it("missing inputs are null, not zero", () => {
    const bare = computeMetrics({
      lobbyId: 5,
      report: { passed: 5, total: 6, checks: checks([6]) },
      mode: "none",
    });
    expect(bare.outcome).toMatchObject({
      passed: 5,
      fullPass: false,
      checks: { "6": false },
    });
    expect(bare.time.firstContractSec).toBeNull();
    expect(bare.coordination.proposals).toBeNull();
    expect(bare.cost.totalTokens).toBeNull();
    expect(bare.mode).toBe("none");
  });
});

describe("compare", () => {
  const lobby = (id: number, mode: string, failing: number[], rounds = 0) =>
    computeMetrics({
      lobbyId: id,
      dump: dump(mode, id),
      report: {
        passed: 6 - failing.length,
        total: 6,
        checks: checks(failing),
        oracleHash: "h1",
      },
      interventions: rounds,
    });
  const all = [
    lobby(1, "none", [6]),
    lobby(2, "none", [6]),
    lobby(3, "none", []),
    lobby(4, "dibs", []),
    lobby(5, "dibs", []),
    lobby(6, "dibs", [], 1),
  ];
  const r = compare(all);

  it("groups by mode and reports rates with intervals", () => {
    expect(r.arms.map((a) => a.arm)).toEqual(["dibs", "none"]);
    const none = r.arms.find((a) => a.arm === "none")!;
    expect(none.fullPass).toMatchObject({ k: 1, n: 3 });
    expect(none.checks["6"]).toMatchObject({ k: 1, n: 3 });
    expect(none.metrics.passRate!.mean).toBeCloseTo(
      ((5 / 6 + 5 / 6 + 1) * 100) / 3,
      6,
    );
  });

  it("diffs none → dibs with Fisher and bootstrap", () => {
    expect(r.diff).toMatchObject({ a: "none", b: "dibs" });
    expect(r.diff!.fullPass.delta).toBeCloseTo(2 / 3, 6);
    expect(r.diff!.fullPass.fisherP).toBeCloseTo(0.4, 6);
    expect(r.diff!.trialsNeededPerArm).toBeGreaterThan(3);
    expect(r.warnings.some((w) => w.includes("5+ per arm"))).toBe(true);
  });

  it("labels override the arm, and renders markdown and CSV", () => {
    const relabelled = compare(all, { labels: { "3": "dibs" } });
    expect(relabelled.arms.find((a) => a.arm === "dibs")!.lobbies).toEqual([
      3, 4, 5, 6,
    ]);
    const md = toMarkdown(r);
    expect(md).toContain("| **Full pass (all checks)** |");
    expect(md).toContain("Fisher p=0.4");
    const csv = toCsv(all).split("\n");
    expect(csv[0]).toMatch(
      /^lobby,arm,passed,total,fullPass,tier_component,tier_server,tier_fullstack,check1/,
    );
    expect(csv[1]).toMatch(/^1,none,5,6,0,/);
  });
});

describe("oracle tiers", () => {
  const withChecks = (id: number, mode: string, failing: number[]) =>
    computeMetrics({
      lobbyId: id,
      report: {
        passed: 6 - failing.length,
        total: 6,
        checks: [1, 2, 3, 4, 5, 6].map((c) => ({
          check: c,
          name: `c${c}`,
          ok: !failing.includes(c),
        })),
      },
      mode,
    });

  it("splits the six checks by whose code they need", () => {
    expect(withChecks(1, "none", [6]).outcome.tiers).toEqual({
      component: true,
      server: true,
      fullstack: false,
    });
    expect(withChecks(2, "none", [4]).outcome.tiers).toEqual({
      component: true,
      server: false,
      fullstack: true,
    });
    expect(
      computeMetrics({
        lobbyId: 3,
        report: { passed: 0, total: 6, checks: [] },
      }).outcome.tiers.fullstack,
    ).toBeNull();
  });

  it("compares every arm against the treatment", () => {
    const r = compare([
      withChecks(1, "none", [6]),
      withChecks(2, "chat", []),
      withChecks(3, "dibs", []),
    ]);
    expect(r.diff).toMatchObject({ a: "none", b: "dibs" });
    expect(r.diffs.map((d) => `${d.a}->${d.b}`).sort()).toEqual([
      "chat->dibs",
      "none->dibs",
    ]);
    expect(r.diff!.tiers.fullstack!.delta).toBe(1);
    expect(r.diff!.tiers.component!.delta).toBe(0);
    // One lobby an arm is too few to plan from.
    expect(r.diff!.trialsNeededPerArm).toBeNull();
    expect(toMarkdown(r)).toContain("Full-stack integration, 3 agents");
  });
});

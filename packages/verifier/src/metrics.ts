// Per-lobby metrics (bench/METRICS.md). The oracle's x/6 says whether the combined code works;
// these numbers say how the team got there: how long it took, how much coordination it cost,
// how much code was written and rewritten, and how many tokens the agents spent.
//
// Inputs are all optional and read from files, so a lobby can be scored long after it ran:
//   db.json       every lobby row (`dibs metrics --export` writes it as the verifier)
//   report.json   `dibs verify`;   timing.json  revision-timing;   review.json  `dibs review`
//   assembled.diff                 the in-area changes `dibs verify` applied
//   transcripts                    each agent's own log (tokens, tool calls, active time)
// A metric whose input is missing is null, never 0, and `sources` says what was read.
//
// Agents are keyed by participant name, not by the three bench providers, so the same file
// works for any agents that join a lobby.
import type { FixtureManifest } from "@dibs/protocol";
import { inArea } from "./manifest.ts";
import type { TimingReport } from "./timing.ts";

export const METRICS_SCHEMA = "dibs.metrics/v1";

/**
 * The S1/S2 oracle's checks, grouped by whose code each one needs. Adding the six up treats
 * "one agent's login is off" the same as "the parts don't fit together"; the tiers keep them apart.
 * - component (1, 2): login and a bad password; Claude's area alone.
 * - server (3, 4, 5): registration; Droid's route calling Claude's auth helper (auth.server).
 * - fullstack (6): the browser flow; Codex's UI against both servers (auth.session,
 *   events.registration). The interface dibs exists to protect.
 */
export const ORACLE_TIERS: { id: string; label: string; checks: number[] }[] = [
  { id: "component", label: "Single agent (checks 1–2)", checks: [1, 2] },
  {
    id: "server",
    label: "Server integration, 2 agents (checks 3–5)",
    checks: [3, 4, 5],
  },
  {
    id: "fullstack",
    label: "Full-stack integration, 3 agents (check 6)",
    checks: [6],
  },
];

// ---------------------------------------------------------------------------------------------
// Inputs

type Row = Record<string, any>;

/** The lobby's rows, table by table, as plain JSON (bigints as numbers). */
export interface LobbyDump {
  lobby?: Row[];
  participant?: Row[];
  plan?: Row[];
  planItem?: Row[];
  message?: Row[];
  job?: Row[];
  proposal?: Row[];
  response?: Row[];
  contract?: Row[];
  delivery?: Row[];
  event?: Row[];
  head?: Row[];
  verification?: Row[];
  review?: Row[];
}

export interface ReportInput {
  passed: number;
  total: number;
  timedOut?: boolean;
  durationMs?: number;
  checks: { check: number; name: string; ok: boolean }[];
  mergeTreeClean?: boolean | null;
  outOfArea?: Record<string, string[]>;
  missingProviders?: string[];
  oracleHash?: string;
  baseSha?: string;
}

export interface ReviewInput {
  clauses?: { key: string; verdict: string }[];
  rootCause?: { key: string; violator: string } | null;
}

export interface TranscriptUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  firstAtUs: number | null;
  lastAtUs: number | null;
  /** Which log shape the numbers came from. */
  format: "claude" | "codex" | "generic" | "none";
}

export interface MetricsInput {
  lobbyId: number;
  dump?: LobbyDump;
  report?: ReportInput;
  timing?: TimingReport;
  review?: ReviewInput;
  diff?: string;
  manifest?: FixtureManifest;
  /** Agent name → raw transcript text (several launches joined). */
  transcripts?: Record<string, string>;
  /** Human keystrokes or relaunches after launch. */
  interventions?: number;
  /** Used when there is no lobby row (an offline lobby): none, chat or dibs. */
  mode?: string;
}

// ---------------------------------------------------------------------------------------------
// Output

export interface Latency {
  n: number;
  medianMs: number | null;
  maxMs: number | null;
}

export interface AgentMetrics {
  name: string;
  provider: string | null;
  firstPlanSec: number | null;
  planRevisions: number;
  planItems: number;
  messagesSent: number;
  proposalsInvolved: number;
  responses: number;
  rejects: number;
  /** Proposal shown → this agent's response. */
  responseLatency: Latency;
  linesAdded: number | null;
  linesRemoved: number | null;
  filesChanged: number | null;
  outOfAreaFiles: number | null;
  sharedEditsBeforeContract: number | null;
  sharedEditsAfterContract: number | null;
  timingVerdict: string | null;
  lastEditSec: number | null;
  headSec: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  toolCalls: number | null;
  activeSec: number | null;
}

export interface KeyMetrics {
  key: string;
  producers: string[];
  consumers: string[];
  /** agreed, aligned, escalated, open, or untouched (no proposal and no contract). */
  outcome: string;
  rounds: number;
  rejects: number;
  firstProposalSec: number | null;
  settledSec: number | null;
}

export interface LobbyMetrics {
  schema: typeof METRICS_SCHEMA;
  lobbyId: number;
  scenario: string | null;
  mode: string | null;
  baseSha: string | null;
  buildHash: string | null;
  oracleHash: string | null;
  agents: string[];
  outcome: {
    passed: number | null;
    total: number | null;
    passRate: number | null;
    /** Every check passed: the combined code works end to end. */
    fullPass: boolean | null;
    /** check number → passed */
    checks: Record<string, boolean>;
    /** ORACLE_TIERS id → every check in the tier passed (null when a check is missing). */
    tiers: Record<string, boolean | null>;
    mergeTreeClean: boolean | null;
    outOfAreaFiles: number | null;
    missingAgents: number | null;
    oracleSec: number | null;
    timedOut: boolean | null;
    reviewConforms: number | null;
    reviewViolations: number | null;
    rootCauseKey: string | null;
    rootCauseViolator: string | null;
  };
  /** Seconds after the lobby started. */
  time: {
    lobbySec: number | null;
    firstPlanSec: number | null;
    allPlansSec: number | null;
    firstProposalSec: number | null;
    firstContractSec: number | null;
    /** Every key with both a producer and a consumer has an agreed or aligned contract. */
    allSettledSec: number | null;
    lastEditSec: number | null;
    lastHeadSec: number | null;
    fallbackFired: boolean | null;
    analyzeAnywayFired: boolean | null;
  };
  coordination: {
    planRevisions: number | null;
    planItems: number | null;
    messages: number | null;
    proposals: number | null;
    proposalRounds: number | null;
    responses: number | null;
    rejects: number | null;
    contractsAgreed: number | null;
    contractsAligned: number | null;
    escalations: number | null;
    sharedKeys: number | null;
    settledKeys: number | null;
    analysisJobs: number | null;
    analysisCalls: number | null;
    analysisFailures: number | null;
    deliveries: number | null;
    receiveLatency: Latency;
    showLatency: Latency;
    responseLatency: Latency;
  };
  work: {
    linesAdded: number | null;
    linesRemoved: number | null;
    filesChanged: number | null;
    sharedEditsBeforeContract: number | null;
    sharedEditsAfterContract: number | null;
    /** Edits after the contract / all shared edits: how much of the work followed the agreement. */
    postContractShare: number | null;
  };
  cost: {
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    toolCalls: number | null;
    /** Sum of each agent's first-to-last transcript line. */
    agentActiveSec: number | null;
  };
  interventions: number | null;
  keys: KeyMetrics[];
  perAgent: AgentMetrics[];
  sources: {
    db: boolean;
    report: boolean;
    timing: boolean;
    review: boolean;
    diff: boolean;
    transcripts: string[];
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers

const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  if (v && typeof v === "object") {
    // A raw SpacetimeDB Timestamp that slipped through.
    const o = v as Record<string, unknown>;
    if ("__timestamp_micros_since_unix_epoch__" in o)
      return Number(o.__timestamp_micros_since_unix_epoch__);
    if ("microsSinceUnixEpoch" in o) return Number(o.microsSinceUnixEpoch);
  }
  return 0;
};
const set = (us: unknown) => num(us) > 0;
const minOf = (xs: number[]) => (xs.length ? Math.min(...xs) : null);
const maxOf = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
const round1 = (x: number) => Math.round(x * 10) / 10;

export function latency(ms: number[]): Latency {
  const xs = ms
    .filter((x) => Number.isFinite(x) && x >= 0)
    .sort((a, b) => a - b);
  if (!xs.length) return { n: 0, medianMs: null, maxMs: null };
  const mid = Math.floor(xs.length / 2);
  const median = xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
  return { n: xs.length, medianMs: Math.round(median), maxMs: xs.at(-1)! };
}

const sumOrNull = (xs: (number | null)[]) =>
  xs.some((x) => x !== null)
    ? xs.reduce<number>((s, x) => s + (x ?? 0), 0)
    : null;

// ---------------------------------------------------------------------------------------------
// Diff: per-file added/removed lines from a unified diff (git diff output).

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

export function parseDiff(diff: string): FileChange[] {
  const files: FileChange[] = [];
  let current: FileChange | null = null;
  for (const line of diff.split(/\r?\n/)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2]!, added: 0, removed: 0 };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      // `+++ /dev/null` on a delete: keep the a/ path from the header.
      continue;
    }
    if (line.startsWith("+")) current.added++;
    else if (line.startsWith("-")) current.removed++;
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// Transcripts: tokens, tool calls and active time. Format-tolerant like timing.ts.

function lineTimeUs(o: any): number | null {
  const t = o?.timestamp ?? o?.ts ?? o?.time ?? o?.created_at ?? o?.createdAt;
  if (typeof t === "string") {
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : ms * 1000;
  }
  if (typeof t === "number" && Number.isFinite(t)) {
    if (t > 1e14) return t;
    if (t > 1e11) return t * 1000;
    if (t > 1e8) return t * 1e6;
  }
  return null;
}

const TOOL_TYPES = new Set([
  "tool_use",
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "tool_call",
]);

function countToolCalls(value: unknown, depth = 0): number {
  if (!value || typeof value !== "object" || depth > 6) return 0;
  if (Array.isArray(value))
    return value.reduce((s, v) => s + countToolCalls(v, depth + 1), 0);
  const o = value as Record<string, unknown>;
  if (typeof o.type === "string" && TOOL_TYPES.has(o.type)) return 1;
  let n = 0;
  for (const v of Object.values(o)) n += countToolCalls(v, depth + 1);
  return n;
}

export function transcriptUsage(text: string): TranscriptUsage {
  const usage: TranscriptUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    firstAtUs: null,
    lastAtUs: null,
    format: "none",
  };
  // Claude Code repeats one API message over several lines (one per content block); count each
  // message id once. Codex reports a running total; keep the largest one per launch and add
  // launches together (a relaunch restarts the counter).
  const claudeSeen = new Map<string, Record<string, number>>();
  let codexLaunchTotal: Record<string, number> | null = null;
  const codexLaunches: Record<string, number>[] = [];
  let generic = { input: 0, cached: 0, output: 0 };

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) continue;
    let o: any;
    try {
      o = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const at = lineTimeUs(o);
    if (at !== null) {
      usage.firstAtUs =
        usage.firstAtUs === null ? at : Math.min(usage.firstAtUs, at);
      usage.lastAtUs =
        usage.lastAtUs === null ? at : Math.max(usage.lastAtUs, at);
    }
    // Tool calls: Claude's assistant content blocks, Codex's response_item payloads.
    if (o?.type === "assistant" || o?.message?.role === "assistant")
      usage.toolCalls += countToolCalls(o.message?.content ?? []);
    else if (o?.type === "response_item")
      usage.toolCalls += countToolCalls(o.payload);
    else if (o?.type !== "event_msg" && o?.type !== "user")
      usage.toolCalls += countToolCalls(o.tool_calls ?? o.toolCalls ?? []);

    // Claude Code: message.usage, deduplicated by message.id.
    const mu = o?.message?.usage;
    if (mu && typeof mu === "object" && "output_tokens" in mu) {
      usage.format = "claude";
      const id = String(o.message.id ?? o.uuid ?? claudeSeen.size);
      claudeSeen.set(id, {
        input: num(mu.input_tokens) + num(mu.cache_creation_input_tokens),
        cached: num(mu.cache_read_input_tokens),
        output: num(mu.output_tokens),
      });
      continue;
    }
    // Codex: event_msg/token_count with a running total.
    const info = o?.payload?.type === "token_count" ? o.payload.info : null;
    if (info?.total_token_usage) {
      usage.format = "codex";
      const t = info.total_token_usage;
      const now = {
        input: num(t.input_tokens),
        cached: num(t.cached_input_tokens),
        output: num(t.output_tokens) + num(t.reasoning_output_tokens),
      };
      if (
        codexLaunchTotal &&
        now.input + now.output <
          codexLaunchTotal.input! + codexLaunchTotal.output!
      )
        codexLaunches.push(codexLaunchTotal);
      codexLaunchTotal = now;
      continue;
    }
    // Anything else that carries a usage object (Droid and other agents).
    const gu = o?.usage ?? o?.tokenUsage ?? o?.token_usage;
    if (gu && typeof gu === "object") {
      const input = num(gu.input_tokens ?? gu.inputTokens ?? gu.prompt_tokens);
      const output = num(
        gu.output_tokens ?? gu.outputTokens ?? gu.completion_tokens,
      );
      if (input || output) {
        if (usage.format === "none") usage.format = "generic";
        generic = {
          input: generic.input + input,
          cached:
            generic.cached +
            num(gu.cache_read_input_tokens ?? gu.cachedInputTokens),
          output: generic.output + output,
        };
      }
    }
  }
  if (codexLaunchTotal) codexLaunches.push(codexLaunchTotal);
  const parts = [...claudeSeen.values(), ...codexLaunches, generic];
  usage.inputTokens = parts.reduce((s, p) => s + p.input!, 0);
  usage.cachedInputTokens = parts.reduce((s, p) => s + p.cached!, 0);
  usage.outputTokens = parts.reduce((s, p) => s + p.output!, 0);
  usage.totalTokens =
    usage.inputTokens + usage.cachedInputTokens + usage.outputTokens;
  return usage;
}

// ---------------------------------------------------------------------------------------------
// The computation

export function computeMetrics(input: MetricsInput): LobbyMetrics {
  const { lobbyId, dump, report, timing, review, diff, manifest } = input;
  const inLobby = (rows: Row[] | undefined) =>
    (rows ?? []).filter((r) => num(r.lobbyId) === lobbyId);
  const lobby = (dump?.lobby ?? []).find((l) => num(l.id) === lobbyId);
  const plans = inLobby(dump?.plan);
  const items = inLobby(dump?.planItem);
  const messages = inLobby(dump?.message);
  const jobs = inLobby(dump?.job);
  const proposals = inLobby(dump?.proposal);
  const responses = inLobby(dump?.response);
  const contracts = inLobby(dump?.contract);
  const deliveries = inLobby(dump?.delivery);
  const heads = inLobby(dump?.head);
  const hasDb = Boolean(dump && lobby);

  const start = lobby && set(lobby.startedAtUs) ? num(lobby.startedAtUs) : null;
  const sec = (us: number | null | undefined) =>
    start !== null && us != null && us > 0 ? round1((us - start) / 1e6) : null;

  // Who took part: agents that planned, were delivered to, or reported a head in this lobby.
  const people = new Map<number, Row>(
    (dump?.participant ?? []).map((p) => [num(p.id), p]),
  );
  const agentIds = new Set<number>();
  for (const r of [...plans, ...heads]) agentIds.add(num(r.participantId));
  for (const d of deliveries) agentIds.add(num(d.targetId));
  for (const p of people.values())
    if (num(p.currentLobbyId) === lobbyId && p.role === "agent")
      agentIds.add(num(p.id));
  for (const id of [...agentIds]) {
    const role = people.get(id)?.role;
    if (role && role !== "agent") agentIds.delete(id);
  }
  const nameOf = (id: number) =>
    String(people.get(id)?.name ?? `participant-${id}`);
  const providerOf = (id: number) =>
    (people.get(id)?.provider as string) ?? null;
  const idByName = new Map([...agentIds].map((id) => [nameOf(id), id]));

  // Agents from files when there's no database: report heads, timing, transcripts.
  const names = new Set<string>([...agentIds].map(nameOf));
  if (!hasDb) {
    for (const p of Object.keys(report?.outOfArea ?? {})) names.add(p);
    for (const p of timing?.providers ?? []) names.add(p.provider);
    for (const p of Object.keys(input.transcripts ?? {})) names.add(p);
  }
  const agents = [...names].sort();
  // The manifest's areas are keyed by provider for the bench; any other agent can be keyed by name.
  const areaOf = (name: string): string[] | null => {
    if (!manifest) return null;
    const areas = manifest.areas as Record<string, string[]>;
    const id = idByName.get(name);
    return (
      areas[name] ??
      (id !== undefined ? areas[providerOf(id) ?? ""] : undefined) ??
      null
    );
  };
  const agentKey = (name: string) => {
    // timing.json and report.json are keyed by provider.
    const id = idByName.get(name);
    return id !== undefined ? (providerOf(id) ?? name) : name;
  };

  // Keys: who produces, who requires, and how each one ended.
  const currentItems = items.filter((i) => i.current !== false);
  const keyNames = new Set<string>([
    ...currentItems.map((i) => String(i.key)),
    ...proposals.map((p) => String(p.key)),
    ...contracts.map((c) => String(c.key)),
  ]);
  const keys: KeyMetrics[] = [...keyNames].sort().map((key) => {
    const its = currentItems.filter((i) => i.key === key);
    const producers = [
      ...new Set(
        its
          .filter((i) => i.kind === "produces")
          .map((i) => nameOf(num(i.participantId))),
      ),
    ].sort();
    const consumers = [
      ...new Set(
        its
          .filter((i) => i.kind === "requires")
          .map((i) => nameOf(num(i.participantId))),
      ),
    ].sort();
    const props = proposals.filter((p) => p.key === key);
    const propIds = new Set(props.map((p) => num(p.id)));
    const cons = contracts.filter((c) => c.key === key);
    const firstContract = minOf(
      cons.map((c) => num(c.createdAtUs)).filter((x) => x > 0),
    );
    const escalated = props.some((p) => p.state === "escalated");
    const current = cons.find((c) => c.current !== false) ?? cons.at(-1);
    const outcome = current
      ? String(current.source)
      : escalated
        ? "escalated"
        : props.length
          ? "open"
          : "untouched";
    return {
      key,
      producers,
      consumers,
      outcome,
      rounds: props.length
        ? Math.max(...props.map((p) => num(p.revision) || 1))
        : 0,
      rejects: responses.filter(
        (r) => propIds.has(num(r.proposalId)) && r.decision === "reject",
      ).length,
      firstProposalSec: sec(
        minOf(props.map((p) => num(p.createdAtUs)).filter((x) => x > 0)),
      ),
      settledSec: sec(firstContract),
    };
  });
  const shared = keys.filter((k) => k.producers.length && k.consumers.length);
  const settled = shared.filter(
    (k) => k.outcome === "agreed" || k.outcome === "aligned",
  );

  // Deliveries: latency through each stage.
  const stageMs = (from: string, to: string, rows = deliveries) =>
    rows
      .filter((d) => set(d[from]) && set(d[to]))
      .map((d) => (num(d[to]) - num(d[from])) / 1000);
  const proposalDeliveries = deliveries.filter((d) => d.kind === "proposal");

  // Diff by agent area.
  const changes = diff !== undefined ? parseDiff(diff) : null;

  // Transcripts.
  const usages = new Map<string, TranscriptUsage>();
  for (const [name, text] of Object.entries(input.transcripts ?? {}))
    usages.set(name, transcriptUsage(text));

  const perAgent: AgentMetrics[] = agents.map((name) => {
    const id = idByName.get(name);
    const mine = <T extends Row>(rows: T[], field = "participantId") =>
      id === undefined ? [] : rows.filter((r) => num(r[field]) === id);
    const myPlans = mine(plans);
    const myResponses = mine(responses);
    const myItems = currentItems.filter(
      (i) => id !== undefined && num(i.participantId) === id,
    );
    const area = areaOf(name);
    const myFiles =
      changes && area ? changes.filter((c) => inArea(c.path, area)) : null;
    const t = timing?.providers.find((p) => p.provider === agentKey(name));
    const u = usages.get(name) ?? usages.get(agentKey(name));
    const myHeads = mine(heads).map((h) => num(h.createdAtUs));
    const out = report?.outOfArea?.[agentKey(name)];
    return {
      name,
      provider: id !== undefined ? providerOf(id) : null,
      firstPlanSec: sec(minOf(myPlans.map((p) => num(p.createdAtUs)))),
      planRevisions: myPlans.length,
      planItems: myItems.length,
      messagesSent: mine(messages, "fromId").length,
      proposalsInvolved: proposals.filter((p) =>
        (p.requiredPartyIds ?? []).map(num).includes(id ?? -1),
      ).length,
      responses: myResponses.length,
      rejects: myResponses.filter((r) => r.decision === "reject").length,
      responseLatency: latency(
        stageMs(
          "shownAtUs",
          "respondedAtUs",
          mine(proposalDeliveries, "targetId"),
        ),
      ),
      linesAdded: myFiles ? myFiles.reduce((s, f) => s + f.added, 0) : null,
      linesRemoved: myFiles ? myFiles.reduce((s, f) => s + f.removed, 0) : null,
      filesChanged: myFiles ? myFiles.length : null,
      outOfAreaFiles: out ? out.length : report?.outOfArea ? 0 : null,
      sharedEditsBeforeContract:
        t && t.verdict !== "no-transcript" ? t.sharedEditsBefore : null,
      sharedEditsAfterContract:
        t && t.verdict !== "no-transcript" ? t.sharedEditsAfter : null,
      timingVerdict: t?.verdict ?? null,
      lastEditSec: sec(t?.lastSharedEditAtUs ?? null),
      headSec: sec(maxOf(myHeads)),
      inputTokens: u ? u.inputTokens : null,
      cachedInputTokens: u ? u.cachedInputTokens : null,
      outputTokens: u ? u.outputTokens : null,
      totalTokens: u ? u.totalTokens : null,
      toolCalls: u ? u.toolCalls : null,
      activeSec:
        u && u.firstAtUs !== null && u.lastAtUs !== null
          ? round1((u.lastAtUs - u.firstAtUs) / 1e6)
          : null,
    };
  });

  const firstPlans = perAgent
    .map((a) => a.firstPlanSec)
    .filter((x): x is number => x !== null);
  const before = sumOrNull(perAgent.map((a) => a.sharedEditsBeforeContract));
  const after = sumOrNull(perAgent.map((a) => a.sharedEditsAfterContract));
  const clauses = review?.clauses ?? null;
  const settledTimes = settled
    .map((k) => k.settledSec)
    .filter((x): x is number => x !== null);
  const endUs = lobby
    ? set(lobby.endsAtUs)
      ? num(lobby.endsAtUs)
      : null
    : null;

  return {
    schema: METRICS_SCHEMA,
    lobbyId,
    scenario: lobby?.scenario ?? null,
    mode: lobby?.mode ?? input.mode ?? null,
    baseSha: lobby?.baseSha ?? report?.baseSha ?? null,
    buildHash: lobby?.buildHash ?? null,
    oracleHash: report?.oracleHash ?? null,
    agents,
    outcome: {
      passed: report ? report.passed : null,
      total: report ? report.total : null,
      passRate: report && report.total ? report.passed / report.total : null,
      fullPass: report ? report.passed === report.total : null,
      checks: Object.fromEntries(
        (report?.checks ?? []).map((c) => [String(c.check), c.ok]),
      ),
      tiers: Object.fromEntries(
        ORACLE_TIERS.map((t) => {
          const got = t.checks.map(
            (c) => report?.checks.find((x) => x.check === c)?.ok,
          );
          return [
            t.id,
            got.some((g) => g === undefined) ? null : got.every(Boolean),
          ];
        }),
      ),
      mergeTreeClean: report?.mergeTreeClean ?? null,
      outOfAreaFiles: report?.outOfArea
        ? Object.values(report.outOfArea).reduce((s, f) => s + f.length, 0)
        : null,
      missingAgents: report?.missingProviders
        ? report.missingProviders.length
        : null,
      oracleSec:
        report?.durationMs !== undefined
          ? round1(report.durationMs / 1000)
          : null,
      timedOut: report?.timedOut ?? null,
      reviewConforms: clauses
        ? clauses.filter((c) => c.verdict === "conforms").length
        : null,
      reviewViolations: clauses
        ? clauses.filter((c) => c.verdict === "violates").length
        : null,
      rootCauseKey: review?.rootCause?.key ?? null,
      rootCauseViolator: review?.rootCause?.violator ?? null,
    },
    time: {
      lobbySec: sec(endUs),
      firstPlanSec: minOf(firstPlans),
      allPlansSec:
        hasDb && agents.length && firstPlans.length === agents.length
          ? maxOf(firstPlans)
          : null,
      firstProposalSec: sec(
        minOf(proposals.map((p) => num(p.createdAtUs)).filter((x) => x > 0)),
      ),
      firstContractSec: sec(
        minOf(contracts.map((c) => num(c.createdAtUs)).filter((x) => x > 0)),
      ),
      allSettledSec:
        hasDb && shared.length && settled.length === shared.length
          ? maxOf(settledTimes)
          : null,
      lastEditSec: maxOf(
        perAgent
          .map((a) => a.lastEditSec)
          .filter((x): x is number => x !== null),
      ),
      lastHeadSec: maxOf(
        perAgent.map((a) => a.headSec).filter((x): x is number => x !== null),
      ),
      fallbackFired: hasDb
        ? deliveries.some((d) => d.kind === "fallback")
        : null,
      analyzeAnywayFired: lobby ? Boolean(lobby.analyzeAnywayFired) : null,
    },
    coordination: {
      planRevisions: hasDb ? plans.length : null,
      planItems: hasDb ? currentItems.length : null,
      messages: hasDb ? messages.length : null,
      proposals: hasDb ? proposals.length : null,
      proposalRounds: hasDb ? keys.reduce((s, k) => s + k.rounds, 0) : null,
      responses: hasDb ? responses.length : null,
      rejects: hasDb
        ? responses.filter((r) => r.decision === "reject").length
        : null,
      contractsAgreed: hasDb
        ? contracts.filter((c) => c.source === "agreed").length
        : null,
      contractsAligned: hasDb
        ? contracts.filter((c) => c.source === "aligned").length
        : null,
      escalations: hasDb
        ? proposals.filter((p) => p.state === "escalated").length
        : null,
      sharedKeys: hasDb ? shared.length : null,
      settledKeys: hasDb ? settled.length : null,
      analysisJobs: hasDb ? jobs.length : null,
      analysisCalls: hasDb ? jobs.reduce((s, j) => s + num(j.calls), 0) : null,
      analysisFailures: hasDb
        ? jobs.filter((j) => j.state === "failed").length
        : null,
      deliveries: hasDb ? deliveries.length : null,
      receiveLatency: latency(stageMs("queuedAtUs", "receivedAtUs")),
      showLatency: latency(stageMs("receivedAtUs", "shownAtUs")),
      responseLatency: latency(
        stageMs("shownAtUs", "respondedAtUs", proposalDeliveries),
      ),
    },
    work: {
      linesAdded: changes
        ? (sumOrNull(perAgent.map((a) => a.linesAdded)) ??
          changes.reduce((s, f) => s + f.added, 0))
        : null,
      linesRemoved: changes
        ? (sumOrNull(perAgent.map((a) => a.linesRemoved)) ??
          changes.reduce((s, f) => s + f.removed, 0))
        : null,
      filesChanged: changes ? changes.length : null,
      sharedEditsBeforeContract: before,
      sharedEditsAfterContract: after,
      postContractShare:
        before !== null && after !== null && before + after > 0
          ? after / (before + after)
          : null,
    },
    cost: {
      inputTokens: sumOrNull(perAgent.map((a) => a.inputTokens)),
      cachedInputTokens: sumOrNull(perAgent.map((a) => a.cachedInputTokens)),
      outputTokens: sumOrNull(perAgent.map((a) => a.outputTokens)),
      totalTokens: sumOrNull(perAgent.map((a) => a.totalTokens)),
      toolCalls: sumOrNull(perAgent.map((a) => a.toolCalls)),
      agentActiveSec: sumOrNull(perAgent.map((a) => a.activeSec)),
    },
    interventions: input.interventions ?? null,
    keys,
    perAgent,
    sources: {
      db: hasDb,
      report: Boolean(report),
      timing: Boolean(timing),
      review: Boolean(review),
      diff: diff !== undefined,
      transcripts: Object.keys(input.transcripts ?? {}).sort(),
    },
  };
}

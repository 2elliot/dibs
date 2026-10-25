// Revision timing (lobby 3 decision, fix 6): early implementation is allowed, so the bench records,
// per agent, whether its last edit to a file in its own non-test area came after the first
// contract delivery it could see. Coding early and revising after the contract is dibs working;
// never revising is a failure the oracle score will show.
//
// Edit times come from the agent's own transcript (JSONL: Claude Code's project log, Codex's
// rollout file under ~/.codex/sessions, Droid's session log). The parser is format-tolerant: it
// walks each line for tool calls ({name, input|arguments|...}) and counts a file as edited when
// an edit-type tool names it, or a shell command writes it (redirect, tee, sed -i, cp/mv target,
// apply_patch headers, writeFile, open(..., "w")). Each counted edit records how it was detected,
// so a reader can audit the result. Contract times come from the `delivery` table.
import { readFileSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { PROVIDERS, type FixtureManifest, type Provider } from "@dibs/protocol";
import { inArea, loadManifest } from "./manifest.ts";
import { fixtureDir, resultsDir } from "./paths.ts";
import { createRecorder, type DeliveryTimes } from "./record.ts";

export interface EditEvent {
  atUs: number;
  path: string;
  tool: string;
  how: "edit-tool" | "patch" | "shell-write";
}

export type TimingVerdict =
  | "built-after-contract" // every shared edit came after the contract
  | "revised-after-contract" // edits before and after
  | "never-revised" // shared edits, all before the contract
  | "no-shared-edits"
  | "no-contract" // never received a contract or aligned delivery
  | "no-transcript";

export interface ProviderTiming {
  provider: Provider;
  verdict: TimingVerdict;
  contractAtUs: number | null;
  contractKind: string | null;
  /** Which delivery stage the time comes from: shown is best, then received, then queued. */
  contractStage: "shown" | "received" | "queued" | null;
  fallbackAtUs: number | null;
  firstSharedEditAtUs: number | null;
  lastSharedEditAtUs: number | null;
  sharedEditsBefore: number;
  sharedEditsAfter: number;
  edits: EditEvent[];
}

export interface TimingReport {
  lobbyId: number;
  createdAt: string;
  providers: ProviderTiming[];
}

/** A provider's shared files: its area without the test globs. */
export function sharedGlobs(
  manifest: FixtureManifest,
  provider: Provider,
): string[] {
  return manifest.areas[provider].filter(
    (glob) => !glob.replace(/^!/, "").startsWith("test/"),
  );
}

function toUs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds, milliseconds or microseconds since the epoch.
    if (value > 1e14) return Math.round(value);
    if (value > 1e11) return Math.round(value * 1000);
    if (value > 1e8) return Math.round(value * 1e6);
    return null;
  }
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms * 1000;
  }
  return null;
}

const TIME_FIELDS = ["timestamp", "ts", "time", "created_at", "createdAt"];

function lineTime(value: unknown, depth = 0): number | null {
  if (!value || typeof value !== "object" || depth > 3) return null;
  const record = value as Record<string, unknown>;
  for (const field of TIME_FIELDS) {
    const us = toUs(record[field]);
    if (us !== null) return us;
  }
  for (const child of Object.values(record)) {
    const us = lineTime(child, depth + 1);
    if (us !== null) return us;
  }
  return null;
}

interface ToolCall {
  tool: string;
  text: string;
  /** Explicit path fields (file_path, path, ...) on an edit-type tool. */
  paths: string[];
  workdir?: string;
}

const INPUT_FIELDS = ["input", "arguments", "parameters", "args", "action"];
const PATH_FIELDS = ["file_path", "filePath", "path", "notebook_path", "file"];
const WORKDIR_FIELDS = ["workdir", "cwd", "working_directory"];

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function collectCalls(value: unknown, out: ToolCall[], depth = 0): void {
  if (!value || typeof value !== "object" || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectCalls(item, out, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  const name = [record.name, record.toolName, record.tool].find(
    (v) => typeof v === "string",
  ) as string | undefined;
  const inputField = INPUT_FIELDS.find((field) => field in record);
  if (name && inputField) {
    const input = parseMaybeJson(record[inputField]);
    const paths: string[] = [];
    let workdir: string | undefined;
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const fields = input as Record<string, unknown>;
      for (const field of PATH_FIELDS)
        if (typeof fields[field] === "string")
          paths.push(fields[field] as string);
      for (const field of WORKDIR_FIELDS)
        if (typeof fields[field] === "string")
          workdir ??= fields[field] as string;
    }
    out.push({
      tool: name,
      text: typeof input === "string" ? input : JSON.stringify(input),
      paths,
      workdir,
    });
    return;
  }
  for (const child of Object.values(record))
    collectCalls(child, out, depth + 1);
}

const EDIT_TOOL = /edit|write|create|patch|replace|notebook/i;

const norm = (path: string) => path.split("\\").join("/");

/** Whether the absolute `path` is inside `root` (both normalised; case-insensitive on drive paths). */
function inside(path: string, root: string): boolean {
  let p = norm(path).replace(/\/+$/, "");
  let r = norm(root).replace(/\/+$/, "");
  if (/^[a-z]:/i.test(r)) {
    p = p.toLowerCase();
    r = r.toLowerCase();
  }
  return p === r || p.startsWith(`${r}/`);
}

/**
 * The repo-relative form of a path token, or null when it can't be a file in the clone: a `..`
 * path, or (with `clone` given) an absolute path outside the clone.
 */
function relativeTo(token: string, clone: string | undefined): string | null {
  let path = norm(token).replace(/^['"`]+|['"`,;:)]+$/g, "");
  if (!path || path.includes("../")) return null;
  const absolute =
    path.startsWith("/") || /^[a-z]:\//i.test(path) || path.startsWith("~/");
  if (absolute) {
    if (clone) {
      if (!inside(path, clone)) return null;
      return norm(path).slice(norm(clone).replace(/\/+$/, "").length + 1);
    }
    const match = /\/((?:src|public|test)\/.+)$/.exec(path);
    return match ? match[1]! : null;
  }
  return path.replace(/^\.\//, "");
}

const PATH_TOKEN = /[^\s'"`<>|;&()=,{}[\]]*\/[^\s'"`<>|;&()=,{}[\]]+/g;

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The ways a shell command writes `token`. */
function shellWrites(text: string, token: string): boolean {
  const t = `['"]?${escape(token)}['"]?`;
  const patterns = [
    new RegExp(`>{1,2}\\s*${t}`),
    new RegExp(`\\btee\\s+(?:-a\\s+)?${t}`),
    new RegExp(
      `\\b(?:sed|perl|ruby)\\s+(?:-\\S*\\s+)*-\\S*i\\S*\\b[^\\n;&|]*${t}`,
    ),
    new RegExp(`\\b(?:cp|mv|install)\\b[^\\n;&|]*\\s${t}\\s*(?:$|[;&|\\n])`),
    new RegExp(`writeFile(?:Sync)?\\(\\s*${t}`),
    new RegExp(`open\\(\\s*${t}\\s*,\\s*['"][wax]`),
  ];
  return patterns.some((pattern) => pattern.test(text));
}

const PATCH_HEADER = /\*\*\* (?:Add|Update|Delete) File:\s*(\S+)/g;

/** Every edit to a file matching `globs` in one transcript, oldest first. */
export function parseTranscript(
  text: string,
  globs: string[],
  options: { clone?: string } = {},
): EditEvent[] {
  const events: EditEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const atUs = lineTime(parsed);
    if (atUs === null) continue;
    const calls: ToolCall[] = [];
    collectCalls(parsed, calls);
    for (const call of calls) {
      // A call that ran in another folder can't have edited the clone (lobby 3, launch 3).
      if (
        options.clone &&
        call.workdir &&
        isAbsolute(norm(call.workdir)) &&
        !inside(call.workdir, options.clone)
      )
        continue;
      const seen = new Set<string>();
      const add = (token: string, how: EditEvent["how"]) => {
        const path = relativeTo(token, options.clone);
        if (!path || seen.has(path) || !inArea(path, globs)) return;
        seen.add(path);
        events.push({ atUs, path, tool: call.tool, how });
      };
      for (const match of call.text.matchAll(PATCH_HEADER))
        add(match[1]!, "patch");
      if (EDIT_TOOL.test(call.tool)) {
        for (const path of call.paths) add(path, "edit-tool");
        continue;
      }
      for (const token of call.text.match(PATH_TOKEN) ?? [])
        if (shellWrites(call.text, token)) add(token, "shell-write");
    }
  }
  return events.sort((a, b) => a.atUs - b.atUs);
}

const CONTRACT_KINDS = new Set(["contract", "aligned"]);

function stageTime(
  d: DeliveryTimes,
): { atUs: number; stage: "shown" | "received" | "queued" } | null {
  if (d.shownAtUs > 0) return { atUs: d.shownAtUs, stage: "shown" };
  if (d.receivedAtUs > 0) return { atUs: d.receivedAtUs, stage: "received" };
  if (d.queuedAtUs > 0) return { atUs: d.queuedAtUs, stage: "queued" };
  return null;
}

export function providerTiming(
  provider: Provider,
  deliveries: DeliveryTimes[],
  edits: EditEvent[] | undefined,
): ProviderTiming {
  const mine = deliveries.filter((d) => d.provider === provider);
  const firstOf = (kinds: (kind: string) => boolean) =>
    mine
      .filter((d) => kinds(d.kind))
      .map((d) => ({ ...stageTime(d), kind: d.kind }))
      .filter(
        (
          d,
        ): d is {
          atUs: number;
          stage: "shown" | "received" | "queued";
          kind: string;
        } => d.atUs !== undefined,
      )
      .sort((a, b) => a.atUs - b.atUs)[0];
  const contract = firstOf((kind) => CONTRACT_KINDS.has(kind));
  const fallback = firstOf((kind) => kind === "fallback");
  const list = edits ?? [];
  const before = contract ? list.filter((e) => e.atUs <= contract.atUs) : list;
  const after = contract ? list.filter((e) => e.atUs > contract.atUs) : [];
  let verdict: TimingVerdict;
  if (!edits) verdict = "no-transcript";
  else if (!contract) verdict = "no-contract";
  else if (!list.length) verdict = "no-shared-edits";
  else if (!after.length) verdict = "never-revised";
  else
    verdict = before.length ? "revised-after-contract" : "built-after-contract";
  return {
    provider,
    verdict,
    contractAtUs: contract?.atUs ?? null,
    contractKind: contract?.kind ?? null,
    contractStage: contract?.stage ?? null,
    fallbackAtUs: fallback?.atUs ?? null,
    firstSharedEditAtUs: list[0]?.atUs ?? null,
    lastSharedEditAtUs: list.at(-1)?.atUs ?? null,
    sharedEditsBefore: before.length,
    sharedEditsAfter: after.length,
    edits: list,
  };
}

export function revisionTiming(options: {
  lobbyId: number;
  manifest: FixtureManifest;
  deliveries: DeliveryTimes[];
  transcripts: Partial<Record<Provider, { text: string; clone?: string }>>;
}): TimingReport {
  const providers = PROVIDERS.filter(
    (p) =>
      options.transcripts[p] ||
      options.deliveries.some((d) => d.provider === p),
  ).map((provider) => {
    const transcript = options.transcripts[provider];
    const edits = transcript
      ? parseTranscript(
          transcript.text,
          sharedGlobs(options.manifest, provider),
          {
            clone: transcript.clone,
          },
        )
      : undefined;
    return providerTiming(provider, options.deliveries, edits);
  });
  return {
    lobbyId: options.lobbyId,
    createdAt: new Date().toISOString(),
    providers,
  };
}

const clock = (us: number | null) =>
  us === null ? "-" : new Date(us / 1000).toISOString().slice(11, 19);

/** `provider=value` pairs from repeated flags; a repeated provider keeps every value. */
function pairs(
  values: string[] | undefined,
  flag: string,
): Partial<Record<Provider, string[]>> {
  const out: Partial<Record<Provider, string[]>> = {};
  for (const value of values ?? []) {
    const at = value.indexOf("=");
    const provider = value.slice(0, at) as Provider;
    if (at < 1 || !PROVIDERS.includes(provider))
      throw new Error(
        `--${flag} needs <claude|codex|droid>=<path>, got ${value}`,
      );
    (out[provider] ??= []).push(value.slice(at + 1));
  }
  return out;
}

const USAGE =
  "usage: revision-timing <lobbyId> --transcript <provider>=<jsonl> [--transcript ... (repeat a provider for several launches)] [--clone <provider>=<path>] [--deliveries <json>] [--local] [--json]";

export async function main(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      transcript: { type: "string", multiple: true },
      clone: { type: "string", multiple: true },
      deliveries: { type: "string" },
      local: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const lobbyId = Number(positionals[0]);
  if (!Number.isInteger(lobbyId) || lobbyId <= 0) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const transcriptPaths = pairs(values.transcript, "transcript");
  const clones = pairs(values.clone, "clone");
  const results = resultsDir(lobbyId);
  mkdirSync(results, { recursive: true });
  let deliveries: DeliveryTimes[];
  if (values.deliveries) {
    deliveries = JSON.parse(
      readFileSync(values.deliveries, "utf8"),
    ) as DeliveryTimes[];
  } else {
    const recorder = await createRecorder(results, { local: values.local });
    try {
      const rows = await recorder.deliveries(lobbyId);
      if (!rows)
        throw new Error(
          `no database connection (${recorder.description}); pass --deliveries <json>`,
        );
      deliveries = rows;
    } finally {
      recorder.close();
    }
  }
  const transcripts: Partial<
    Record<Provider, { text: string; clone?: string }>
  > = {};
  // Several launches of one agent (lobby 3: Codex ran three times) are read as one log.
  for (const [provider, paths] of Object.entries(transcriptPaths) as [
    Provider,
    string[],
  ][])
    transcripts[provider] = {
      text: paths.map((path) => readFileSync(path, "utf8")).join("\n"),
      clone: clones[provider]?.at(-1),
    };
  const report = revisionTiming({
    lobbyId,
    manifest: loadManifest(fixtureDir),
    deliveries,
    transcripts,
  });
  const path = join(results, "timing.json");
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`lobby ${lobbyId}: revision timing (UTC)`);
  for (const p of report.providers) {
    console.log(
      `  ${p.provider.padEnd(6)} ${p.verdict.padEnd(22)} contract ${clock(p.contractAtUs)}${p.contractStage ? ` (${p.contractKind}, ${p.contractStage})` : ""}  edits ${p.sharedEditsBefore} before / ${p.sharedEditsAfter} after, last ${clock(p.lastSharedEditAtUs)}`,
    );
  }
  console.log(`timing: ${path}`);
}

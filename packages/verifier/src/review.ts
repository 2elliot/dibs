// `dibs review <lobbyId>`: the Droid SDK's clause-by-clause review of the assembled code (plan
// §7, our Factory entry). Advisory: it never changes the verification's pass/fail.
//
//   npm run dibs -- review <lobbyId> [--runner sdk|exec|fake] [--contracts <file.json>]
//
// Needs a `dibs verify` of the same lobby first (it reads bench/results/<id>/report.json and
// assembled.diff, and the tree in bench/.work/lobby-<id>/tree).
//
// Runners:
//   sdk  (default) @factory/droid-sdk from /node: autonomyLevel Off, no permission handler (so
//        every approval request is cancelled), JSON-schema output with REVIEW_SCHEMA. Needs
//        `droid` on PATH and FACTORY_API_KEY.
//   exec `droid exec --cwd <copy> -f review.md -o json`. Fallback only: ask Factory whether it
//        counts; no schema flag, so the JSON is extracted and validated here.
//   fake Deterministic, offline; for tests and dry runs.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  REVIEW_SCHEMA,
  type FixtureManifest,
  type Provider,
  type ReviewFindings,
  type ReviewKind,
} from "@dibs/protocol";
import { loadManifest } from "./manifest.ts";
import { fixtureDir, resultsDir, workDir } from "./paths.ts";
import { createRecorder, type Recorder } from "./record.ts";
import { validate } from "./schema.ts";
import { assembledTreePath, type VerifyReport } from "./verify.ts";

export interface Clause {
  key: string;
  text: string;
  /** "agreed" / "aligned" contract, or the charter's interface description. */
  source: "agreed" | "aligned" | "charter";
}

export interface ReviewInput {
  lobbyId: number;
  kind: ReviewKind;
  clauses: Clause[];
  report: VerifyReport;
  diff: string;
  /** A throwaway copy of the assembled tree; the runner may only read it. */
  cwd: string;
  prompt: string;
}

export interface ReviewOutput {
  findings: unknown;
  model: string;
  sessionId: string;
}

export interface ReviewRunner {
  readonly name: string;
  run(input: ReviewInput): Promise<ReviewOutput>;
}

const MAX_DIFF_CHARS = 60_000;

/** The charter's three interfaces, used as the clauses when a lobby has no contracts (None/Chat). */
export function charterClauses(manifest: FixtureManifest): Clause[] {
  return manifest.vocabulary.map((entry) => ({
    key: entry.key,
    text: entry.description,
    source: "charter",
  }));
}

export function reviewPrompt(
  clauses: Clause[],
  report: VerifyReport,
  diff: string,
): string {
  const checks = report.checks
    .map(
      (c) =>
        `- ${c.ok ? "PASS" : "FAIL"} ${c.check}. ${c.name}${c.ok || !c.message ? "" : ` — ${c.message}`}`,
    )
    .join("\n");
  const clippedDiff =
    diff.length > MAX_DIFF_CHARS
      ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)`
      : diff;
  return `You are reviewing code that three coding agents wrote together in this repository (claude: src/auth/**, codex: public/** except index.html, droid: src/events/**). This is a read-only review: do not edit, create or run anything.

For each clause below, decide whether the code conforms to it, violates it, or the clause doesn't apply. Give file:line evidence from the current files for every verdict that isn't not_applicable. If any oracle check failed, set rootCause to the clause key whose violation explains the failure, the provider whose area broke it (claude, codex or droid; "unknown" if you can't tell), and a short explanation. If every check passed, rootCause is null.

## Clauses
${clauses.map((c, i) => `${i + 1}. [${c.key}] (${c.source}) ${c.text}`).join("\n")}

## Hidden oracle result: ${report.passed}/${report.total}
${checks}

## Diff of the assembled code against the base
\`\`\`diff
${clippedDiff}
\`\`\`

Answer with JSON that matches the given schema: summary (one or two sentences), clauses (one entry per clause above, same key), rootCause.`;
}

/** A copy of the assembled tree without node_modules, .git or any agent config (no .factory hooks). */
export function throwawayCopy(tree: string): string {
  const copy = join(tmpdir(), `dibs-review-${process.pid}-${Date.now()}`);
  cpSync(tree, copy, {
    recursive: true,
    filter: (src) =>
      !/[\\/](node_modules|\.git|\.factory|\.claude|\.codex)([\\/]|$)/.test(
        src.slice(tree.length),
      ),
  });
  return copy;
}

// ---- Runners --------------------------------------------------------------------------------

/** Offline and deterministic: verdicts from the oracle result and simple text checks. */
export class FakeReviewRunner implements ReviewRunner {
  readonly name = "fake";
  async run(input: ReviewInput): Promise<ReviewOutput> {
    const failed = input.report.checks.filter((c) => !c.ok);
    const read = (path: string) => {
      try {
        return readFileSync(join(input.cwd, path), "utf8");
      } catch {
        return "";
      }
    };
    const server = read("src/auth/routes.js") + read("src/auth/index.js");
    const ui = read("public/app.js");
    const serverBearer = /authorization|bearer/i.test(server);
    const uiBearer = /authorization|bearer/i.test(ui);
    const transportMismatch = serverBearer !== uiBearer;
    const clauses = input.clauses.map((clause) => {
      const violates =
        failed.length > 0 && clause.key === "auth.session" && transportMismatch;
      return {
        clause: clause.text,
        key: clause.key,
        verdict: violates ? ("violates" as const) : ("conforms" as const),
        evidence: [
          {
            file:
              clause.key === "auth.session"
                ? "public/app.js"
                : clause.key === "auth.server"
                  ? "src/auth/index.js"
                  : "src/events/routes.js",
            line: 1,
            note: violates
              ? `server uses ${serverBearer ? "a bearer token" : "a cookie"}, the UI ${uiBearer ? "sends a bearer token" : "relies on the cookie"}`
              : "fake review: no problem found",
          },
        ],
      };
    });
    const findings: ReviewFindings = {
      summary:
        failed.length === 0
          ? `All ${input.report.total} checks passed; the code follows every clause.`
          : transportMismatch
            ? `Check ${failed.map((c) => c.check).join(", ")} failed: the server and the UI use different session transports.`
            : `Check ${failed.map((c) => c.check).join(", ")} failed; the fake review can't name a cause.`,
      clauses,
      rootCause:
        failed.length === 0
          ? null
          : {
              key: transportMismatch ? "auth.session" : "unknown",
              violator: (transportMismatch
                ? serverBearer
                  ? "codex"
                  : "claude"
                : "unknown") as Provider | "unknown",
              explanation: transportMismatch
                ? serverBearer
                  ? "The server expects Authorization: Bearer, but the UI never sends it."
                  : "The UI sends a bearer token, but the server only reads its cookie."
                : "No single clause explains the failure.",
            },
    };
    return { findings, model: "fake", sessionId: "" };
  }
}

/**
 * The Factory Droid SDK (checked against @factory/droid-sdk 0.10.0). Read-only: autonomy Off and
 * no permissionHandler, so every approval request is cancelled. Loaded lazily so the other
 * runners work where the SDK can't install.
 */
export class DroidSdkRunner implements ReviewRunner {
  readonly name = "sdk";
  async run(input: ReviewInput): Promise<ReviewOutput> {
    const sdk = await import("@factory/droid-sdk/node");
    if (!process.env.FACTORY_API_KEY)
      throw new Error("FACTORY_API_KEY isn't set");
    const result = await sdk.run(input.prompt, {
      cwd: input.cwd,
      autonomyLevel: sdk.AutonomyLevel.Off,
      outputFormat: {
        type: "json_schema",
        schema: REVIEW_SCHEMA as unknown as Record<string, unknown>,
      },
    });
    if (!result.success) {
      throw new Error(
        `The Droid session failed (${result.subtype}): ${String((result as { error?: unknown }).error ?? result.text)}`,
      );
    }
    if (
      result.structuredOutput === undefined ||
      result.structuredOutput === null
    ) {
      throw new Error("The Droid session returned no structured output");
    }
    return {
      findings: result.structuredOutput,
      model: "droid",
      sessionId: result.sessionId,
    };
  }
}

/** First balanced {...} block in a string, parsed. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  for (
    let end = text.lastIndexOf("}");
    end > start && start >= 0;
    end = text.lastIndexOf("}", end - 1)
  ) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // Try a shorter span.
    }
  }
  throw new Error("No JSON object in the Droid output");
}

/** `droid exec` fallback. Exit 0 doesn't mean success, so the output is always validated. */
export class DroidExecRunner implements ReviewRunner {
  readonly name = "exec";
  async run(input: ReviewInput): Promise<ReviewOutput> {
    const promptFile = join(
      tmpdir(),
      `dibs-review-${process.pid}-${Date.now()}.md`,
    );
    writeFileSync(
      promptFile,
      `${input.prompt}\n\nReply with only the JSON object, matching this JSON Schema:\n${JSON.stringify(REVIEW_SCHEMA)}\n`,
    );
    try {
      const result = spawnSync(
        "droid",
        ["exec", "--cwd", input.cwd, "-f", promptFile, "-o", "json"],
        {
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          timeout: 10 * 60 * 1000,
          shell: process.platform === "win32",
        },
      );
      if (result.error) throw result.error;
      const outer = extractJson(result.stdout) as Record<string, unknown>;
      const text =
        typeof outer.result === "string" ? outer.result : JSON.stringify(outer);
      const findings =
        typeof outer.summary === "string" ? outer : extractJson(text);
      return {
        findings,
        model: String(outer.model ?? "droid exec"),
        sessionId: String(outer.session_id ?? outer.sessionId ?? ""),
      };
    } finally {
      rmSync(promptFile, { force: true });
    }
  }
}

export function runnerByName(name: string): ReviewRunner {
  if (name === "sdk") return new DroidSdkRunner();
  if (name === "exec") return new DroidExecRunner();
  if (name === "fake") return new FakeReviewRunner();
  throw new Error(`Unknown runner "${name}" (sdk, exec or fake)`);
}

// ---- The command ----------------------------------------------------------------------------

export async function reviewLobby(options: {
  lobbyId: number;
  runner: ReviewRunner;
  clauses?: Clause[];
  kind?: ReviewKind;
  verificationId?: number;
  manifest?: FixtureManifest;
  work?: string;
  results?: string;
  recorder?: Recorder;
}): Promise<{ findings: ReviewFindings; reviewPath: string }> {
  const results = options.results ?? resultsDir(options.lobbyId);
  const reportPath = join(results, "report.json");
  if (!existsSync(reportPath)) {
    throw new Error(
      `No ${reportPath}: run dibs verify ${options.lobbyId} first`,
    );
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as VerifyReport;
  const diff = readFileSync(join(results, "assembled.diff"), "utf8");
  const tree = assembledTreePath(options.work ?? workDir(), options.lobbyId);
  if (!existsSync(tree))
    throw new Error(`No assembled tree at ${tree}: run dibs verify again`);
  const clauses = options.clauses?.length
    ? options.clauses
    : charterClauses(options.manifest ?? loadManifest(fixtureDir));
  const kind: ReviewKind =
    options.kind ??
    (report.passed === report.total ? "conformance" : "diagnosis");
  const cwd = throwawayCopy(tree);
  let output: ReviewOutput;
  try {
    output = await options.runner.run({
      lobbyId: options.lobbyId,
      kind,
      clauses,
      report,
      diff,
      cwd,
      prompt: reviewPrompt(clauses, report, diff),
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  const problems = validate(REVIEW_SCHEMA, output.findings);
  if (problems.length) {
    writeFileSync(
      join(results, "review.invalid.json"),
      `${JSON.stringify(output, null, 2)}\n`,
    );
    throw new Error(
      `The review doesn't match REVIEW_SCHEMA:\n  ${problems.slice(0, 10).join("\n  ")}`,
    );
  }
  const findings = output.findings as ReviewFindings;
  const reviewPath = join(results, "review.json");
  mkdirSync(results, { recursive: true });
  writeFileSync(
    reviewPath,
    `${JSON.stringify({ lobbyId: options.lobbyId, kind, runner: options.runner.name, model: output.model, sessionId: output.sessionId, findings }, null, 2)}\n`,
  );
  const recorder = options.recorder ?? (await createRecorder(results));
  await recorder.recordReview({
    lobbyId: options.lobbyId,
    verificationId: options.verificationId ?? 0,
    kind,
    summary: findings.summary,
    findingsJson: JSON.stringify(findings),
    model: output.model,
    sessionId: output.sessionId,
  });
  return { findings, reviewPath };
}

export async function main(args: string[]): Promise<void> {
  try {
    await run(args);
  } catch (error) {
    console.error(
      `dibs ${"review"}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}

async function run(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      runner: { type: "string", default: "sdk" },
      contracts: { type: "string" },
      kind: { type: "string" },
      "verification-id": { type: "string" },
    },
  });
  const lobbyId = Number(positionals[0]);
  if (!Number.isInteger(lobbyId) || lobbyId <= 0) {
    console.error(
      "usage: dibs review <lobbyId> [--runner sdk|exec|fake] [--contracts <file.json: [{key,text,source}]>] [--kind conformance|diagnosis]",
    );
    process.exitCode = 2;
    return;
  }
  const clauses = values.contracts
    ? (JSON.parse(readFileSync(values.contracts, "utf8")) as Clause[])
    : undefined;
  const { findings, reviewPath } = await reviewLobby({
    lobbyId,
    runner: runnerByName(values.runner ?? "sdk"),
    clauses,
    kind: values.kind as ReviewKind | undefined,
    verificationId: values["verification-id"]
      ? Number(values["verification-id"])
      : undefined,
  });
  console.log(findings.summary);
  for (const clause of findings.clauses) {
    console.log(`  ${clause.verdict.padEnd(14)} ${clause.key}`);
  }
  if (findings.rootCause) {
    console.log(
      `  root cause: ${findings.rootCause.key} (${findings.rootCause.violator}) ${findings.rootCause.explanation}`,
    );
  }
  console.log(`review: ${reviewPath}`);
}

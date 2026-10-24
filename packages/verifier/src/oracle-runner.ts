// Runs the oracle (a node:test file) against an assembled tree and parses its TAP output into
// per-check results. The oracle starts the app itself, on ports in issue 4's range.
import { execFile } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir, PORT_RANGE, repoRoot } from "./paths.ts";

export interface OracleCheck {
  check: number;
  name: string;
  ok: boolean;
  message?: string;
}

export interface OracleReport {
  exitCode: number;
  timedOut: boolean;
  passed: number;
  total: number;
  checks: OracleCheck[];
  durationMs: number;
}

export const ORACLE_TOTAL = 6;
export const ORACLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The fixture's dependencies, shared into a tree that has none (assembled trees come from git).
 * Agents can't add dependencies, so the fixture's own install is the right one.
 */
export function linkFixtureModules(tree: string, fromFixture = fixtureDir) {
  if (existsSync(join(tree, "node_modules"))) return;
  const modules = join(fromFixture, "node_modules");
  if (!existsSync(modules)) {
    throw new Error(
      `${modules} is missing: run "npm ci --prefix ${fromFixture}" once`,
    );
  }
  // A junction on Windows needs no admin rights.
  symlinkSync(modules, join(tree, "node_modules"), "junction");
}

export function parseTap(output: string): OracleCheck[] {
  const checks: OracleCheck[] = [
    ...output.matchAll(/^(not ok|ok) \d+ - (\d)\. (.+)$/gm),
  ].map((m) => ({
    check: Number(m[2]),
    name: m[3]!.trim(),
    ok: m[1] === "ok",
  }));
  // A failed check's message: the YAML block after its "not ok" line. Long messages come as
  // `error: |-` followed by indented lines.
  const lines = output.split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = /^not ok \d+ - (\d)\./.exec(line);
    if (!match) return;
    const check = checks.find((c) => c.check === Number(match[1]));
    for (let i = index + 1; i < Math.min(lines.length, index + 30); i++) {
      const error = /^\s+error: (.*)$/.exec(lines[i]!);
      if (!error) continue;
      const value = error[1]!.trim();
      const text =
        value === "|-" || value === "|" ? (lines[i + 1] ?? "").trim() : value;
      if (check) check.message = text.replace(/^['"]|['"]$/g, "");
      break;
    }
  });
  return checks.sort((a, b) => a.check - b.check);
}

export function runOracle(
  oracleFile: string,
  tree: string,
  { timeoutMs = ORACLE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<OracleReport & { output: string }> {
  const started = Date.now();
  return new Promise((done) => {
    execFile(
      process.execPath,
      ["--test", "--test-reporter=tap", "--test-concurrency=1", oracleFile],
      {
        // Inside the repo, so the oracle resolves the root @playwright/test.
        cwd: repoRoot,
        env: {
          ...process.env,
          DIBS_TREE: tree,
          DIBS_PORT_MIN: String(PORT_RANGE.min),
          DIBS_PORT_MAX: String(PORT_RANGE.max),
        },
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        const checks = parseTap(output);
        const code = (error as { code?: unknown } | null)?.code;
        done({
          exitCode: error ? (typeof code === "number" ? code : 1) : 0,
          timedOut: Boolean((error as { killed?: boolean } | null)?.killed),
          passed: checks.filter((c) => c.ok).length,
          total: ORACLE_TOTAL,
          checks,
          durationMs: Date.now() - started,
          output,
        });
      },
    );
  });
}

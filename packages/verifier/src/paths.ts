// Where things live. Everything is relative to the repo root, overridable for tests.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DIBS_HOME_ENV } from "@dibs/protocol";

export const repoRoot = resolve(import.meta.dirname, "../../..");
export const benchDir = process.env.DIBS_BENCH_DIR
  ? resolve(process.env.DIBS_BENCH_DIR)
  : join(repoRoot, "bench");
export const fixtureDir = process.env.DIBS_FIXTURE_DIR
  ? resolve(process.env.DIBS_FIXTURE_DIR)
  : join(repoRoot, "fixture");

/** Scratch space under bench/ (gitignored). Inside the repo so the decrypted oracle resolves the root @playwright/test. */
export const workDir = () => join(benchDir, ".work");
export const resultsDir = (lobbyId: string | number) =>
  join(benchDir, "results", String(lobbyId));
export const oracleDir = () => join(benchDir, "oracle");
export const encryptedOraclePath = () => join(benchDir, "oracle.enc");

export function dibsHome(): string {
  return process.env[DIBS_HOME_ENV] ?? join(homedir(), ".dibs");
}

/** Issue 4's port range (CLAUDE.md: issue N uses 41N0–41N9). */
export const PORT_RANGE = { min: 4140, max: 4149 } as const;

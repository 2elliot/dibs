// `dibs verify <lobbyId>`: combine the three agents' work by area and run the hidden oracle on
// it (plan §7). Runs on M3, which has the oracle key.
//
//   npm run dibs -- verify <lobbyId> --remote <dibs-fixture-lobbies URL or path>
//       [--base <sha>] [--expect-hash <sha256>] [--json]
//
// Exit code: 0 when the oracle passes 6/6, 1 when it doesn't, 2 for usage errors. Writes
// bench/results/<lobbyId>/{report.json, oracle.log, assembled.diff, verification.json} and
// keeps the assembled tree in bench/.work/lobby-<id>/tree for `dibs review`.
//
// The remote defaults to DIBS_LOBBIES_REMOTE. The base defaults to the heads' common ancestor
// (the lobby's baseSha comes from the DB after [module-ready]).
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { FixtureManifest, Provider } from "@dibs/protocol";
import {
  assemble,
  assembledDiff,
  commonBase,
  fetchHeads,
  mergeTreeClean,
  type Heads,
} from "./git.ts";
import { loadManifest } from "./manifest.ts";
import { loadKey, sha256, unpack } from "./oracle-crypto.ts";
import {
  linkFixtureModules,
  ORACLE_TIMEOUT_MS,
  runOracle,
  type OracleReport,
} from "./oracle-runner.ts";
import {
  benchDir,
  encryptedOraclePath,
  fixtureDir,
  resultsDir,
  workDir,
} from "./paths.ts";
import { createRecorder, verificationRow, type Recorder } from "./record.ts";

export interface VerifyReport extends OracleReport {
  lobbyId: number;
  baseSha: string;
  assembledFrom: Heads;
  missingProviders: Provider[];
  applied: Partial<Record<Provider, string[]>>;
  outOfArea: Partial<Record<Provider, string[]>>;
  treeHash: string;
  mergeTreeClean: boolean | null;
  oracleHash: string;
  verifiedAt: string;
  verifier: string;
}

export interface VerifyOptions {
  lobbyId: number;
  remote: string;
  baseSha?: string;
  manifest?: FixtureManifest;
  /** Defaults: bench/oracle.enc, bench/oracle.hash, the M3 key. */
  oracleEnc?: string;
  expectHash?: string;
  key?: Buffer;
  /** Where the fixture's node_modules come from. */
  fixture?: string;
  work?: string;
  results?: string;
  recorder?: Recorder;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/** The assembled tree stays here after a verify, for `dibs review`. */
export const assembledTreePath = (work: string, lobbyId: number) =>
  join(work, `lobby-${lobbyId}`, "tree");

export async function verifyLobby(options: VerifyOptions): Promise<{
  report: VerifyReport;
  reportPath: string;
  verificationId: number | null;
}> {
  const log = options.log ?? ((line: string) => console.error(line));
  const fixture = options.fixture ?? fixtureDir;
  const manifest = options.manifest ?? loadManifest(fixture);
  const work = options.work ?? workDir();
  const results = options.results ?? resultsDir(options.lobbyId);
  const oracleEnc = options.oracleEnc ?? encryptedOraclePath();
  const expectHash =
    options.expectHash ??
    (existsSync(join(benchDir, "oracle.hash"))
      ? readFileSync(join(benchDir, "oracle.hash"), "utf8").trim()
      : undefined);
  const recorder = options.recorder ?? (await createRecorder(results));
  mkdirSync(results, { recursive: true });

  // 1. Fetch the heads.
  const cacheGitDir = join(work, "lobbies.git");
  const heads = fetchHeads(options.remote, options.lobbyId, cacheGitDir);
  const providers = Object.keys(heads) as Provider[];
  if (providers.length === 0) {
    throw new Error(
      `No lobby/${options.lobbyId}/<provider> branches in ${options.remote}`,
    );
  }
  const missingProviders = (["claude", "codex", "droid"] as Provider[]).filter(
    (p) => !heads[p],
  );
  if (missingProviders.length) {
    log(`warning: no head for ${missingProviders.join(", ")}`);
  }
  const baseSha = options.baseSha ?? commonBase(cacheGitDir, heads);
  log(
    `lobby ${options.lobbyId}: base ${baseSha.slice(0, 10)}, heads ${providers.join(", ")}`,
  );

  // 2. Assemble by area; merge-tree is info only.
  const tree = assembledTreePath(work, options.lobbyId);
  const assembly = assemble({ cacheGitDir, baseSha, heads, manifest, tree });
  const clean = mergeTreeClean(
    cacheGitDir,
    heads,
    join(work, `merge-${randomUUID()}`),
  );
  writeFileSync(join(results, "assembled.diff"), assembledDiff(tree, baseSha));
  for (const provider of providers) {
    const outside = assembly.outOfArea[provider] ?? [];
    if (outside.length) {
      log(
        `${provider}: ${outside.length} out-of-area file(s) ignored: ${outside.join(", ")}`,
      );
    }
  }

  // 3. Decrypt the oracle into a temp dir, check its hash, run it on a fresh port.
  linkFixtureModules(tree, fixture);
  // Always inside the repo (bench/.work), so the oracle resolves the root @playwright/test.
  const oracleTmp = join(workDir(), `oracle-${randomUUID()}`);
  let oracleHash: string;
  let run: Awaited<ReturnType<typeof runOracle>>;
  try {
    oracleHash = unpack(
      oracleEnc,
      oracleTmp,
      options.key ?? loadKey(),
      expectHash,
    );
    run = await runOracle(join(oracleTmp, "oracle.test.mjs"), tree, {
      timeoutMs: options.timeoutMs ?? ORACLE_TIMEOUT_MS,
    });
  } finally {
    rmSync(oracleTmp, { recursive: true, force: true });
  }
  const { output, ...oracle } = run;
  writeFileSync(join(results, "oracle.log"), output);

  // 4. Report, then record_verification.
  const report: VerifyReport = {
    lobbyId: options.lobbyId,
    baseSha,
    assembledFrom: assembly.assembledFrom,
    missingProviders,
    applied: assembly.applied,
    outOfArea: assembly.outOfArea,
    treeHash: assembly.treeHash,
    mergeTreeClean: clean,
    oracleHash,
    ...oracle,
    verifiedAt: new Date().toISOString(),
    verifier: hostname(),
  };
  const reportPath = join(results, "report.json");
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(reportPath, reportText);
  const verificationId = await recorder.recordVerification(
    verificationRow(options.lobbyId, assembly.assembledFrom, {
      treeHash: assembly.treeHash,
      mergeTreeClean: clean ?? true,
      oracleHash,
      exitCode: report.exitCode,
      passed: report.passed,
      total: report.total,
      reportHash: sha256(reportText),
    }),
  );
  if (verificationId !== null) await recorder.markVerified(options.lobbyId);
  return { report, reportPath, verificationId };
}

export async function main(args: string[]): Promise<void> {
  try {
    await run(args);
  } catch (error) {
    console.error(
      `dibs ${"verify"}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}

async function run(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      remote: { type: "string" },
      base: { type: "string" },
      "expect-hash": { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const lobbyId = Number(positionals[0]);
  const remote = values.remote ?? process.env.DIBS_LOBBIES_REMOTE;
  if (!Number.isInteger(lobbyId) || lobbyId <= 0 || !remote) {
    console.error(
      "usage: dibs verify <lobbyId> --remote <lobbies repo URL or path> [--base <sha>] [--expect-hash <sha256>] [--json]",
    );
    process.exitCode = 2;
    return;
  }
  const { report, reportPath } = await verifyLobby({
    lobbyId,
    remote:
      /^[a-z]+:\/\//i.test(remote) || remote.includes("@")
        ? remote
        : resolve(remote),
    baseSha: values.base,
    expectHash: values["expect-hash"],
  });
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `lobby ${lobbyId}: ${report.passed}/${report.total}${report.timedOut ? " (timed out)" : ""}, merge-tree ${report.mergeTreeClean === null ? "n/a" : report.mergeTreeClean ? "clean" : "conflicts"}`,
    );
    for (const check of report.checks) {
      console.log(
        `  ${check.ok ? "✓" : "✗"} ${check.check}. ${check.ok ? check.name : (check.message ?? check.name)}`,
      );
    }
    for (const [provider, files] of Object.entries(report.outOfArea)) {
      if (files?.length)
        console.log(`  ${provider}: out of area ${files.join(", ")}`);
    }
    console.log(`report: ${reportPath}`);
  }
  process.exitCode = report.passed === report.total ? 0 : 1;
}

// Oracle mutation testing (bench/EVALUATION.md §3): "how do we know the hidden test isn't rigged?"
// Takes a known-good solution (lobby 7, 6/6), breaks one behaviour at a time (bench/oracle-mutants.json),
// and checks the oracle fails exactly the checks it should and still passes the rest.
// Runs on M3 (needs the oracle key).
//
//   npx tsx bench/scripts/oracle-mutants.ts [--lobby 7] [--remote <lobbies repo>] [--only <id>]
//
// Writes bench/results/oracle-mutants.json. Exit 0 when the unmutated control passes 6/6 and every
// mutant is killed as specified.
import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  assemble,
  commonBase,
  fetchHeads,
  removeWorktree,
} from "../../packages/verifier/src/git.ts";
import { loadManifest } from "../../packages/verifier/src/manifest.ts";
import { loadKey, unpack } from "../../packages/verifier/src/oracle-crypto.ts";
import {
  linkFixtureModules,
  runOracle,
} from "../../packages/verifier/src/oracle-runner.ts";
import {
  applyMutant,
  type Mutant,
} from "../../packages/verifier/src/mutants.ts";
import {
  benchDir,
  encryptedOraclePath,
  fixtureDir,
  workDir,
} from "../../packages/verifier/src/paths.ts";

const { values } = parseArgs({
  options: {
    lobby: { type: "string", default: "7" },
    remote: {
      type: "string",
      default:
        process.env.DIBS_LOBBIES_REMOTE ??
        "https://github.com/2elliot/dibs.git",
    },
    only: { type: "string" },
  },
});
const { mutants } = JSON.parse(
  readFileSync(join(benchDir, "oracle-mutants.json"), "utf8"),
) as { mutants: Mutant[] };
const selected = values.only
  ? mutants.filter((m) => m.id === values.only)
  : mutants;

const work = workDir();
const cacheGitDir = join(work, "lobbies.git");
const heads = fetchHeads(values.remote, values.lobby, cacheGitDir);
const baseSha = commonBase(cacheGitDir, heads);
const control = join(work, `mutants-${values.lobby}-control`);
assemble({
  cacheGitDir,
  baseSha,
  heads,
  manifest: loadManifest(fixtureDir),
  tree: control,
});

const oracleTmp = join(work, `oracle-${randomUUID()}`);
const expectHash = readFileSync(join(benchDir, "oracle.hash"), "utf8").trim();
const oracleHash = unpack(
  encryptedOraclePath(),
  oracleTmp,
  loadKey(),
  expectHash,
);
const oracleFile = join(oracleTmp, "oracle.test.mjs");

const passedChecks = (r: Awaited<ReturnType<typeof runOracle>>) =>
  [1, 2, 3, 4, 5, 6].filter((n) => r.checks.find((c) => c.check === n)?.ok);

const rows: Record<string, unknown>[] = [];
let failures = 0;
try {
  linkFixtureModules(control);
  const base = await runOracle(oracleFile, control);
  const controlOk = base.passed === 6;
  if (!controlOk) failures++;
  console.log(
    `${controlOk ? "✓" : "✗"} control (lobby ${values.lobby}, unmutated)  ${base.passed}/6`,
  );
  rows.push({ id: "control", passed: passedChecks(base), ok: controlOk });

  for (const m of selected) {
    const tree = join(work, `mutant-${m.id}`);
    rmSync(tree, { recursive: true, force: true });
    mkdirSync(tree, { recursive: true });
    cpSync(control, tree, {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|\.git)$/.test(src),
    });
    rmSync(join(tree, "node_modules"), { recursive: true, force: true });
    applyMutant(tree, m);
    linkFixtureModules(tree);
    const r = await runOracle(oracleFile, tree);
    const passed = passedChecks(r);
    const failed = [1, 2, 3, 4, 5, 6].filter((n) => !passed.includes(n));
    const killed = m.mustFail.every((n) => failed.includes(n));
    const localized = m.mustPass.every((n) => passed.includes(n));
    const ok = killed && localized;
    if (!ok) failures++;
    console.log(
      `${ok ? "✓" : "✗"} ${m.id.padEnd(30)} failed [${failed.join(",")}]  expected fail [${m.mustFail.join(",")}] pass [${m.mustPass.join(",")}]`,
    );
    rows.push({
      id: m.id,
      description: m.description,
      failed,
      passed,
      mustFail: m.mustFail,
      mustPass: m.mustPass,
      killed,
      localized,
      ok,
    });
    rmSync(tree, { recursive: true, force: true });
  }
} finally {
  rmSync(oracleTmp, { recursive: true, force: true });
  removeWorktree(cacheGitDir, control);
}
mkdirSync(join(benchDir, "results"), { recursive: true });
const out = join(benchDir, "results", "oracle-mutants.json");
writeFileSync(
  out,
  `${JSON.stringify({ schema: "dibs.oracle-mutants-result/v1", createdAt: new Date().toISOString(), lobby: Number(values.lobby), oracleHash, results: rows }, null, 2)}\n`,
);
console.log(
  failures
    ? `${failures} unexpected result(s)`
    : "Every mutant was caught by the expected checks.",
);
console.log(`written: ${out}`);
process.exit(failures ? 1 : 0);

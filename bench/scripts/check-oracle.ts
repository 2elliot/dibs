// Gate 0 (c): runs the plaintext oracle against the empty fixture and the three references.
//   npx tsx bench/scripts/check-oracle.ts
// Expected: scaffold 0/6, cookie 6/6, bearer 6/6, mismatch 5/6 with check 6 (the UI) failing.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  fixtureDir,
  oracleDir,
  workDir,
} from "../../packages/verifier/src/paths.ts";
import {
  linkFixtureModules,
  runOracle,
} from "../../packages/verifier/src/oracle-runner.ts";

const EXPECT: Record<string, (ok: boolean[]) => boolean> = {
  scaffold: (ok) => ok.every((v) => !v),
  cookie: (ok) => ok.every(Boolean),
  bearer: (ok) => ok.every(Boolean),
  mismatch: (ok) => ok.slice(0, 5).every(Boolean) && !ok[5],
};

const oracleFile = join(oracleDir(), "oracle.test.mjs");
if (!existsSync(oracleFile)) {
  console.error(
    `No plaintext oracle at ${oracleFile}: run oracle-unpack first`,
  );
  process.exit(1);
}

let failures = 0;
for (const name of Object.keys(EXPECT)) {
  const tree = join(workDir(), `check-${name}`);
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  cpSync(fixtureDir, tree, {
    recursive: true,
    filter: (src) =>
      !/[\\/](node_modules|\.git)([\\/]|$)/.test(src.slice(fixtureDir.length)),
  });
  if (name !== "scaffold") {
    cpSync(join(oracleDir(), "references", name), tree, { recursive: true });
  }
  linkFixtureModules(tree);
  const report = await runOracle(oracleFile, tree);
  const ok = [1, 2, 3, 4, 5, 6].map(
    (n) => report.checks.find((c) => c.check === n)?.ok ?? false,
  );
  const good = EXPECT[name]!(ok);
  if (!good) failures++;
  console.log(
    `${good ? "✓" : "✗"} ${name.padEnd(9)} ${report.passed}/6  ${ok.map((v) => (v ? "✓" : "✗")).join("")}`,
  );
  for (const check of report.checks.filter((c) => !c.ok)) {
    console.log(`    ${check.check}. ${check.message ?? check.name}`);
  }
  rmSync(tree, { recursive: true, force: true });
}
console.log(
  failures
    ? `${failures} unexpected result(s)`
    : "Oracle behaves as specified.",
);
process.exit(failures ? 1 : 0);

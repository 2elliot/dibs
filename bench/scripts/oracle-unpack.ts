// Decrypts bench/oracle.enc into bench/oracle/ (gitignored), checking its hash.
//   npx tsx bench/scripts/oracle-unpack.ts [--out <dir>] [--expect-hash <sha256>]
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadKey, unpack } from "../../packages/verifier/src/oracle-crypto.ts";
import {
  encryptedOraclePath,
  oracleDir,
} from "../../packages/verifier/src/paths.ts";

const { values } = parseArgs({
  options: { out: { type: "string" }, "expect-hash": { type: "string" } },
});
const out = values.out ? resolve(values.out) : oracleDir();
if (existsSync(out) && readdirSync(out).length > 0) {
  console.error(`${out} isn't empty; move it aside first`);
  process.exit(1);
}
const hash = unpack(
  encryptedOraclePath(),
  out,
  loadKey(),
  values["expect-hash"],
);
console.log(`Unpacked to ${out}. oracleHash ${hash}`);

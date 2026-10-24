// Encrypts bench/oracle/ (oracle.test.mjs + references) into bench/oracle.enc and writes
// bench/oracle.hash. Uses DIBS_ORACLE_KEY or ~/.dibs/oracle.key, creating the key file if
// there is none. Commit oracle.enc and oracle.hash; never the key or bench/oracle/.
//   npx tsx bench/scripts/oracle-pack.ts
import { existsSync } from "node:fs";
import {
  loadOrCreateKey,
  pack,
} from "../../packages/verifier/src/oracle-crypto.ts";
import {
  encryptedOraclePath,
  oracleDir,
} from "../../packages/verifier/src/paths.ts";

if (!existsSync(oracleDir())) {
  console.error(
    `${oracleDir()} doesn't exist: run oracle-unpack first, or restore the plaintext oracle`,
  );
  process.exit(1);
}
const { key, created } = loadOrCreateKey();
if (created)
  console.log(
    `New oracle key written to ${created}. Back it up; it never goes in a repo.`,
  );
const hash = pack(oracleDir(), encryptedOraclePath(), key);
console.log(`oracle.enc written. oracleHash ${hash}`);

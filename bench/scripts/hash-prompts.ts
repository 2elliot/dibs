// Freeze 1: hashes every prompt file and every composed launch prompt into
// bench/prompts/manifest.json. Run after any prompt edit and commit the result.
//   npx tsx bench/scripts/hash-prompts.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  promptsDir,
  promptsManifest,
} from "../../packages/verifier/src/prompts.ts";

const file = join(promptsDir(), "manifest.json");
const text = `${JSON.stringify(promptsManifest(), null, 2)}\n`;
if (process.argv.includes("--check")) {
  const same = readFileSync(file, "utf8").replace(/\r\n/g, "\n") === text;
  console.log(
    same
      ? "manifest.json is current"
      : "manifest.json is stale: run hash-prompts",
  );
  process.exit(same ? 0 : 1);
}
writeFileSync(file, text);
console.log(`promptsHash ${JSON.parse(text).promptsHash}`);

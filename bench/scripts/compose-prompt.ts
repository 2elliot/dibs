// Prints one agent's launch prompt.
//   npx tsx bench/scripts/compose-prompt.ts --scenario s2 --mode dibs --provider claude
//   npx tsx bench/scripts/compose-prompt.ts --scenario s2 --mode none --provider codex --pilot
import { parseArgs } from "node:util";
import { composePrompt } from "../../packages/verifier/src/prompts.ts";

const { values } = parseArgs({
  options: {
    scenario: { type: "string" },
    mode: { type: "string" },
    provider: { type: "string" },
    pilot: { type: "boolean", default: false },
  },
});
if (!values.scenario || !values.mode || !values.provider) {
  console.error(
    "usage: compose-prompt --scenario s1|s2|n --mode none|chat|dibs --provider claude|codex|droid [--pilot]",
  );
  process.exit(2);
}
process.stdout.write(
  `${composePrompt({ scenario: values.scenario, mode: values.mode, provider: values.provider, pilot: values.pilot })}\n`,
);

// Dry-run tool: `npm run analyze -w @dibs/worker -- <plans.json> [--fake] [--json]`.
// Prints the prompt the worker would send. With a key set (and without --fake) it also calls the
// real model and prints the findings; with --fake it replays a `recordedFindings` field from the
// plans file if present. Fixtures live in test/fixtures/.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AnalysisInput, Findings } from "@dibs/protocol";
import { buildAnalysisRequest } from "../analysis/prompt.ts";
import { runAnalysis } from "../analysis/analyze.ts";
import { AnthropicModelClient } from "../model/anthropic.ts";
import { FakeModelClient } from "../model/fake.ts";
import { loadConfig } from "../config.ts";

interface PlansFile extends AnalysisInput {
  /** Optional: canned findings the fake replays, so the tool runs end-to-end without a key. */
  recordedFindings?: Findings;
}

function parseArgs(argv: string[]): {
  file?: string;
  fake: boolean;
  json: boolean;
} {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const file = args.find((a) => !a.startsWith("--"));
  return { file, fake: flags.has("--fake"), json: flags.has("--json") };
}

async function main(): Promise<void> {
  const { file, fake, json } = parseArgs(process.argv);
  if (!file) {
    console.error(
      "usage: npm run analyze -w @dibs/worker -- <plans.json> [--fake] [--json]",
    );
    process.exit(2);
  }
  // `npm run -w` runs with cwd = the workspace dir; INIT_CWD is where the user invoked npm (repo
  // root), so a path they typed relative to the repo root still resolves.
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const plans = JSON.parse(
    readFileSync(resolve(baseDir, file), "utf8"),
  ) as PlansFile;
  const req = buildAnalysisRequest(plans);

  if (json) {
    process.stdout.write(
      JSON.stringify({ system: req.system, user: req.user }, null, 2) + "\n",
    );
  } else {
    process.stdout.write("===== SYSTEM =====\n" + req.system + "\n\n");
    process.stdout.write("===== USER =====\n" + req.user + "\n");
  }

  const config = loadConfig();
  if (fake) {
    if (!plans.recordedFindings) {
      console.error(
        "\n[--fake] no `recordedFindings` in the plans file; nothing to replay.",
      );
      return;
    }
    const outcome = await runAnalysis(
      plans,
      FakeModelClient.fromFindings(plans.recordedFindings),
    );
    printFindings(outcome.kept, outcome.dropped);
    return;
  }
  if (!config.anthropicApiKey) {
    console.error(
      "\n[no ANTHROPIC_API_KEY] printed the prompt only. Add --fake to replay recorded findings.",
    );
    return;
  }
  const model = new AnthropicModelClient({
    apiKey: config.anthropicApiKey,
    model: config.anthropicModel,
  });
  const outcome = await runAnalysis(plans, model);
  console.error(
    `\nmodel ${outcome.model}: ${outcome.usage.inputTokens} in / ${outcome.usage.outputTokens} out, ${outcome.latencyMs} ms`,
  );
  printFindings(outcome.kept, outcome.dropped);
}

function printFindings(
  kept: Findings["findings"],
  dropped: { finding: { key: string }; reason: string }[],
): void {
  process.stdout.write(
    "\n===== FINDINGS (kept) =====\n" + JSON.stringify(kept, null, 2) + "\n",
  );
  if (dropped.length) {
    process.stdout.write(
      "\n===== DROPPED =====\n" +
        dropped.map((d) => `- ${d.finding.key}: ${d.reason}`).join("\n") +
        "\n",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

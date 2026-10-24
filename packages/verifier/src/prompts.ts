// The frozen launch prompt for one agent: its role, then the scenario's charter, then the mode
// text (the only difference between treatments). Prompt files live in bench/prompts/.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { MODES, PROVIDERS, type Mode, type Provider } from "@dibs/protocol";
import { benchDir } from "./paths.ts";

export const promptsDir = () => join(benchDir, "prompts");

export interface ScenarioConfig {
  label: string;
  charter: string;
  vocabulary: string[];
  roles: Record<Provider, string>;
  areas: Record<Provider, string[]>;
  oracle: boolean;
}

export interface ScenariosFile {
  modes: Record<Mode, string>;
  /** The sentence the 09:00 pilot removes from the charter. */
  pilotRemoves: string;
  [scenario: string]: ScenarioConfig | Record<Mode, string> | string;
}

export function loadScenarios(): ScenariosFile {
  return JSON.parse(
    readFileSync(join(promptsDir(), "scenarios.json"), "utf8"),
  ) as ScenariosFile;
}

export function scenarioNames(scenarios = loadScenarios()): string[] {
  return Object.keys(scenarios).filter(
    (key) => key !== "modes" && key !== "pilotRemoves",
  );
}

const read = (file: string) =>
  readFileSync(join(promptsDir(), file), "utf8").trim();

export function charterFor(scenario: string, pilot = false): string {
  const scenarios = loadScenarios();
  const config = scenarios[scenario] as ScenarioConfig | undefined;
  if (!config || !scenarioNames(scenarios).includes(scenario)) {
    throw new Error(`Unknown scenario "${scenario}"`);
  }
  let charter = read(config.charter);
  if (pilot) {
    const sentence = scenarios.pilotRemoves;
    if (!charter.includes(sentence)) {
      throw new Error("The pilot sentence isn't in the charter");
    }
    charter = charter.replace(` ${sentence}`, "").replace(sentence, "").trim();
  }
  return charter;
}

export function composePrompt({
  scenario,
  mode,
  provider,
  pilot = false,
}: {
  scenario: string;
  mode: string;
  provider: string;
  pilot?: boolean;
}): string {
  const scenarios = loadScenarios();
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new Error(`Unknown mode "${mode}"`);
  }
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Unknown provider "${provider}"`);
  }
  const charter = charterFor(scenario, pilot);
  const config = scenarios[scenario] as ScenarioConfig;
  const modeText = read(scenarios.modes[mode as Mode]);
  return [read(config.roles[provider as Provider]), charter, modeText]
    .filter(Boolean)
    .join("\n\n");
}

const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** Freeze 1: hashes of every prompt file and every composed launch prompt. */
export function promptsManifest() {
  const dir = promptsDir();
  const fileHashes = Object.fromEntries(
    files(dir)
      .filter((path) => !path.endsWith("manifest.json"))
      .map(
        (path) =>
          [
            relative(dir, path).split("\\").join("/"),
            // Hash with LF endings so Windows checkouts give the same hash.
            sha256(readFileSync(path, "utf8").replace(/\r\n/g, "\n")),
          ] as const,
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const composed: Record<string, string> = {};
  for (const scenario of scenarioNames()) {
    for (const mode of MODES) {
      for (const provider of PROVIDERS) {
        composed[`${scenario}/${mode}/${provider}`] = sha256(
          composePrompt({ scenario, mode, provider }),
        );
      }
    }
  }
  return {
    promptsHash: sha256(JSON.stringify(fileHashes)),
    files: fileHashes,
    composed,
  };
}

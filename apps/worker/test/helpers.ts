import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AnalysisInput, Findings } from "@dibs/protocol";

const here = dirname(fileURLToPath(import.meta.url));

export interface Fixture extends AnalysisInput {
  recordedFindings: Findings;
}

export function loadFixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(join(here, "fixtures", `${name}.json`), "utf8"),
  ) as Fixture;
}

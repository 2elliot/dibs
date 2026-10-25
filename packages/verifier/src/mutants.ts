// Oracle mutants (bench/oracle-mutants.json, bench/scripts/oracle-mutants.ts): one exact edit each.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Mutant {
  id: string;
  description: string;
  file: string;
  find: string;
  replace: string;
  /** Checks the oracle must fail on this mutant. */
  mustFail: number[];
  /** Checks it must still pass: the failure is localized. */
  mustPass: number[];
}

/** Applies one exact edit; throws unless `find` occurs exactly once (a mutant that misses is not a pass). */
export function applyMutant(tree: string, m: Mutant): void {
  const path = join(tree, m.file);
  const text = readFileSync(path, "utf8");
  const count = text.split(m.find).length - 1;
  if (count !== 1)
    throw new Error(`${m.id}: expected 1 match in ${m.file}, found ${count}`);
  writeFileSync(path, text.replace(m.find, m.replace));
}

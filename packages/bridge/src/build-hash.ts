import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Directory of packages/bridge, whether this file is running from src/ via tsx or dist/bridge.mjs. */
export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const base = path.basename(here);
  if (base === "src" || base === "dist") return path.resolve(here, "..");
  return here;
}

/**
 * Hash of the built bridge and hook. `dibs session prep` compares it with lobby.buildHash
 * so a machine cannot join a trial on a different build.
 */
export function localBuildHash(root = packageRoot()): string {
  const hash = createHash("sha256");
  for (const rel of ["dist/bridge.mjs", "dist/dibs-hook.mjs"]) {
    hash.update(rel);
    hash.update("\0");
    const abs = path.join(root, rel);
    hash.update(fs.existsSync(abs) ? fs.readFileSync(abs) : "-");
    hash.update("\0");
  }
  return hash.digest("hex");
}

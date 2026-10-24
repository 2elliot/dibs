// fixture/dibs.json: the key vocabulary, each provider's area and the frozen files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDERS, type FixtureManifest, type Provider } from "@dibs/protocol";

export function loadManifest(dir: string): FixtureManifest {
  const manifest = JSON.parse(
    readFileSync(join(dir, "dibs.json"), "utf8"),
  ) as FixtureManifest;
  for (const provider of PROVIDERS) {
    if (!Array.isArray(manifest.areas?.[provider])) {
      throw new Error(`${dir}/dibs.json has no area for ${provider}`);
    }
  }
  return manifest;
}

/** `**` matches any number of path segments, `*` anything except `/`, `?` one character. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Globs in order; a leading `!` excludes. A path is in the area if some include matches and no exclude does. */
export function inArea(path: string, globs: string[]): boolean {
  const normalized = path.split("\\").join("/");
  let included = false;
  for (const glob of globs) {
    if (glob.startsWith("!")) {
      if (globToRegExp(glob.slice(1)).test(normalized)) return false;
    } else if (globToRegExp(glob).test(normalized)) {
      included = true;
    }
  }
  return included;
}

export function inProviderArea(
  manifest: FixtureManifest,
  provider: Provider,
  path: string,
): boolean {
  return (
    !manifest.frozen.includes(path) && inArea(path, manifest.areas[provider])
  );
}

// Test helpers: a local "lobbies" repo whose lobby/<id>/<provider> branches are built from the
// reference solutions, the way `dibs session` would push them after a trial.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { PROVIDERS, type Provider } from "@dibs/protocol";
import { git } from "../src/git.ts";
import { loadManifest, inProviderArea } from "../src/manifest.ts";
import { benchDir, fixtureDir } from "../src/paths.ts";

export const referencesDir = join(benchDir, "oracle", "references");
export const hasPlaintextOracle = existsSync(
  join(benchDir, "oracle", "oracle.test.mjs"),
);
/** Check 6 needs Chromium; set DIBS_TEST_UI=1 where it's installed to assert it too. */
export const testUi = process.env.DIBS_TEST_UI === "1";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

export function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), `dibs-i4-${prefix}-`));
}

/**
 * A repo with the fixture on `main` and, per lobby, one branch per provider holding that
 * provider's area from the named reference. `extra` adds files to a provider's branch
 * (out-of-area edits, say).
 */
export function makeLobbiesRepo(
  lobbies: Record<
    number,
    {
      reference: Partial<Record<Provider, string>>;
      extra?: Partial<Record<Provider, Record<string, string>>>;
    }
  >,
) {
  const repo = tempDir("lobbies");
  cpSync(fixtureDir, repo, {
    recursive: true,
    filter: (src) =>
      !/[\\/](node_modules|\.git)([\\/]|$)/.test(src.slice(fixtureDir.length)),
  });
  git(["init", "-q", "-b", "main"], repo);
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "fixture"], repo);
  const base = git(["rev-parse", "HEAD"], repo);
  const manifest = loadManifest(fixtureDir);
  for (const [lobbyId, spec] of Object.entries(lobbies)) {
    for (const provider of PROVIDERS) {
      const reference = spec.reference[provider];
      if (!reference) continue;
      git(["checkout", "-q", "-B", `lobby/${lobbyId}/${provider}`, base], repo);
      const refDir = join(referencesDir, reference);
      for (const file of files(refDir)) {
        const path = relative(refDir, file).split("\\").join("/");
        if (!inProviderArea(manifest, provider, path)) continue;
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        cpSync(file, join(repo, path));
      }
      for (const [path, content] of Object.entries(
        spec.extra?.[provider] ?? {},
      )) {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), content);
      }
      git(["add", "-A"], repo);
      git(["commit", "-q", "-m", `${provider} work`], repo);
    }
  }
  git(["checkout", "-q", "main"], repo);
  return { repo, base };
}

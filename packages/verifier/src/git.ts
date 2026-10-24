// Git plumbing for `dibs verify`: fetch the lobby heads, assemble by area, and the info-only
// merge-tree check. Plain `git` from PATH, no shell, so it behaves the same on Windows.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PROVIDERS,
  type AssembledFrom,
  type FixtureManifest,
  type Provider,
} from "@dibs/protocol";
import { inProviderArea } from "./manifest.ts";

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "dibs verify",
  GIT_AUTHOR_EMAIL: "verify@dibs.invalid",
  GIT_COMMITTER_NAME: "dibs verify",
  GIT_COMMITTER_EMAIL: "verify@dibs.invalid",
};

export function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function gitBuffer(args: string[], cwd?: string): Buffer {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export type Heads = Partial<Record<Provider, string>>;

export const lobbyBranch = (lobbyId: string | number, provider: Provider) =>
  `lobby/${lobbyId}/${provider}`;

/** Fetches lobby/<id>/* from `remote` into a bare cache repo. Returns each provider's head SHA. */
export function fetchHeads(
  remote: string,
  lobbyId: string | number,
  cacheGitDir: string,
): Heads {
  if (!existsSync(join(cacheGitDir, "HEAD"))) {
    mkdirSync(cacheGitDir, { recursive: true });
    git(["init", "--bare", "-q", cacheGitDir]);
  }
  git([
    `--git-dir=${cacheGitDir}`,
    "fetch",
    "--no-tags",
    "--force",
    "--quiet",
    remote,
    `+refs/heads/lobby/${lobbyId}/*:refs/heads/lobby/${lobbyId}/*`,
  ]);
  const heads: Heads = {};
  for (const provider of PROVIDERS) {
    const ref = `refs/heads/${lobbyBranch(lobbyId, provider)}`;
    const result = spawnSync(
      "git",
      [`--git-dir=${cacheGitDir}`, "rev-parse", "--verify", "-q", ref],
      { env: GIT_ENV, encoding: "utf8" },
    );
    if (result.status === 0) heads[provider] = result.stdout.trim();
  }
  return heads;
}

/** The newest commit every head descends from: the lobby's base when the DB doesn't give it. */
export function commonBase(cacheGitDir: string, heads: Heads): string {
  const shas = Object.values(heads);
  if (shas.length === 1) {
    return git([`--git-dir=${cacheGitDir}`, "rev-parse", `${shas[0]}^`]);
  }
  return git([`--git-dir=${cacheGitDir}`, "merge-base", "--octopus", ...shas]);
}

export interface Assembly {
  tree: string;
  baseSha: string;
  assembledFrom: AssembledFrom;
  /** Files taken from each head (added/modified written, deleted removed). */
  applied: Partial<Record<Provider, string[]>>;
  /** Changed files outside each provider's area: ignored, counted. */
  outOfArea: Partial<Record<Provider, string[]>>;
  treeHash: string;
}

/** Assembles by area into a fresh worktree of the cache repo at `baseSha` (plan §7 step 2). */
export function assemble({
  cacheGitDir,
  baseSha,
  heads,
  manifest,
  tree,
}: {
  cacheGitDir: string;
  baseSha: string;
  heads: Heads;
  manifest: FixtureManifest;
  tree: string;
}): Assembly {
  removeWorktree(cacheGitDir, tree);
  mkdirSync(dirname(tree), { recursive: true });
  git([
    `--git-dir=${cacheGitDir}`,
    "worktree",
    "add",
    "--detach",
    "--quiet",
    tree,
    baseSha,
  ]);
  const assembledFrom: AssembledFrom = {};
  const applied: Assembly["applied"] = {};
  const outOfArea: Assembly["outOfArea"] = {};
  for (const provider of PROVIDERS) {
    const head = heads[provider];
    if (!head) continue;
    assembledFrom[provider] = head;
    applied[provider] = [];
    outOfArea[provider] = [];
    const changes = git([
      `--git-dir=${cacheGitDir}`,
      "diff",
      "--name-status",
      "--no-renames",
      "-z",
      baseSha,
      head,
    ])
      .split("\0")
      .filter(Boolean);
    for (let i = 0; i + 1 < changes.length; i += 2) {
      const status = changes[i]!;
      const path = changes[i + 1]!;
      if (!inProviderArea(manifest, provider, path)) {
        outOfArea[provider]!.push(path);
        continue;
      }
      const target = join(tree, path);
      if (status.startsWith("D")) {
        rmSync(target, { force: true });
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(
          target,
          gitBuffer([`--git-dir=${cacheGitDir}`, "show", `${head}:${path}`]),
        );
      }
      applied[provider]!.push(path);
    }
  }
  git(["add", "-A"], tree);
  const treeHash = git(["write-tree"], tree);
  return { tree, baseSha, assembledFrom, applied, outOfArea, treeHash };
}

/** The assembled tree's diff against the base, for the review. */
export function assembledDiff(tree: string, baseSha: string): string {
  return git(["diff", "--cached", "--no-color", baseSha], tree);
}

export function removeWorktree(cacheGitDir: string, tree: string) {
  if (existsSync(tree)) {
    spawnSync(
      "git",
      [`--git-dir=${cacheGitDir}`, "worktree", "remove", "--force", tree],
      { env: GIT_ENV },
    );
    rmSync(tree, { recursive: true, force: true });
  }
  spawnSync("git", [`--git-dir=${cacheGitDir}`, "worktree", "prune"], {
    env: GIT_ENV,
  });
}

/** 0 = clean, 1 = conflicts, anything else = merge-tree --write-tree isn't supported (git < 2.38). */
function mergeTreePair(
  cacheGitDir: string,
  a: string,
  b: string,
): { status: number; tree: string } {
  const result = spawnSync(
    "git",
    [`--git-dir=${cacheGitDir}`, "merge-tree", "--write-tree", a, b],
    { env: GIT_ENV, encoding: "utf8" },
  );
  return {
    status: result.status ?? 2,
    tree: (result.stdout ?? "").split("\n")[0]!.trim(),
  };
}

/**
 * Info only: would `git merge` of all the heads have succeeded without conflicts?
 * Uses `git merge-tree --write-tree` (git ≥ 2.38), merging pairwise; falls back to an
 * octopus merge in a throwaway worktree on older git. Null if there's nothing to merge.
 */
export function mergeTreeClean(
  cacheGitDir: string,
  heads: Heads,
  scratch: string,
): boolean | null {
  const shas = Object.values(heads);
  if (shas.length < 2) return null;
  let current = shas[0]!;
  for (const next of shas.slice(1)) {
    const { status, tree } = mergeTreePair(cacheGitDir, current, next);
    if (status === 1) return false;
    if (status !== 0) return octopusClean(cacheGitDir, shas, scratch);
    current = git([
      `--git-dir=${cacheGitDir}`,
      "commit-tree",
      tree,
      "-p",
      current,
      "-p",
      next,
      "-m",
      "dibs verify: merge-tree check",
    ]);
  }
  return true;
}

function octopusClean(
  cacheGitDir: string,
  shas: string[],
  scratch: string,
): boolean {
  removeWorktree(cacheGitDir, scratch);
  git([
    `--git-dir=${cacheGitDir}`,
    "worktree",
    "add",
    "--detach",
    "--quiet",
    scratch,
    shas[0]!,
  ]);
  try {
    const result = spawnSync(
      "git",
      ["merge", "--no-commit", "--no-ff", "--quiet", ...shas.slice(1)],
      { cwd: scratch, env: GIT_ENV, encoding: "utf8" },
    );
    return result.status === 0;
  } finally {
    spawnSync("git", ["merge", "--abort"], { cwd: scratch, env: GIT_ENV });
    removeWorktree(cacheGitDir, scratch);
  }
}

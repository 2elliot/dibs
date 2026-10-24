// SessionStart hook for working on dibs itself: tells Claude what the rest of the team is
// doing. Reads each lane's status file and the newest decisions from origin/main, so you
// see what teammates merged even before you pull. Must never fail or hang a session.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const LANES = ["plugin", "core", "demo"];
const MAX_CHARS = 9000;
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

function git(...args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch {
    return null;
  }
}

git("fetch", "origin", "main", "--quiet");
const remote = git("rev-parse", "--verify", "--quiet", "origin/main") ? "origin/main" : null;

function readShared(path) {
  if (remote) {
    const text = git("show", `${remote}:${path}`);
    if (text !== null) return text;
  }
  const local = join(root, path);
  return existsSync(local) ? readFileSync(local, "utf8") : null;
}

function latestDecisions(count) {
  const dir = join(root, "docs", "decisions");
  const listing = remote
    ? git("ls-tree", "--name-only", remote, "docs/decisions/")?.split("\n")
    : existsSync(dir)
      ? readdirSync(dir).map((name) => `docs/decisions/${name}`)
      : [];
  return (listing ?? [])
    .filter((path) => path.endsWith(".md") && !path.endsWith("README.md"))
    .sort()
    .reverse()
    .slice(0, count);
}

const out = [
  `# Team context${remote ? " (from origin/main)" : " (local copy, couldn't reach origin)"}`,
];

const branch = git("branch", "--show-current") ?? "";
const lane = LANES.find((name) => branch.startsWith(`${name}/`));
if (lane) {
  out.push(
    `You're on \`${branch}\`, so this session works in the **${lane}** lane. Only edit files that lane owns (see CLAUDE.md) and \`docs/status/${lane}.md\`.`,
  );
} else if (branch === "main") {
  out.push(
    "You're on `main`. Create a lane branch (`plugin/…`, `core/…` or `demo/…`) before editing anything.",
  );
} else {
  out.push(
    `You're on \`${branch}\`, which doesn't name a lane. Ask which lane this work belongs to before editing.`,
  );
}

if (remote) {
  const behind = Number(git("rev-list", "--count", `HEAD..${remote}`) ?? 0);
  if (behind > 0)
    out.push(`This branch is ${behind} commit(s) behind main. Run /sync before starting.`);
}

for (const name of LANES) {
  const status = readShared(`docs/status/${name}.md`);
  if (status) out.push("", status.trim());
}

const decisions = latestDecisions(5);
if (decisions.length > 0) {
  out.push("", "## Latest decisions", ...decisions.map((path) => `- ${path}`));
}

let text = out.join("\n");
if (text.length > MAX_CHARS)
  text = `${text.slice(0, MAX_CHARS)}\n…(truncated; read docs/status/ directly)`;
process.stdout.write(text);

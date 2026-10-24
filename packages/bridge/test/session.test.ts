import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { localBuildHash, packageRoot } from "../src/build-hash.ts";
import { git } from "../src/git.ts";
import { forwardSlash, pidAlive } from "../src/home.ts";
import { killTree, resolveCommand, spawnAgent } from "../src/proc.ts";
import { providerCommand, renderProvider } from "../src/providers.ts";
import { prep, startSession } from "../src/session.ts";

const exec = promisify(execFile);
const repo = path.resolve(packageRoot(), "../..");

function temp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

async function fixture(): Promise<{
  root: string;
  clone: string;
  bare: string;
  base: string;
}> {
  const root = temp("dibs-session-");
  const clone = path.join(root, "clone");
  const bare = path.join(root, "bare.git");
  fs.mkdirSync(clone);
  await git(clone, ["init", "-b", "main"]);
  fs.mkdirSync(path.join(clone, "src", "auth"), { recursive: true });
  fs.writeFileSync(
    path.join(clone, "dibs.json"),
    JSON.stringify({
      vocabulary: [{ key: "auth.session", description: "session" }],
      areas: {
        claude: ["src/auth/**"],
        codex: ["public/**"],
        droid: ["src/events/**"],
      },
      frozen: ["README.md", "dibs.json"],
    }),
  );
  fs.writeFileSync(path.join(clone, "README.md"), "frozen\n");
  fs.writeFileSync(path.join(clone, "src", "auth", "index.js"), "export {}\n");
  await git(clone, ["add", "-A"]);
  await git(clone, [
    "-c",
    "user.name=dibs",
    "-c",
    "user.email=dibs@localhost",
    "commit",
    "-m",
    "base",
  ]);
  const base = await git(clone, ["rev-parse", "HEAD"]);
  await git(root, ["init", "--bare", bare]);
  return { root, clone, bare, base };
}

function agentScript(root: string): string {
  const file = path.join(root, "agent.mjs");
  fs.writeFileSync(
    file,
    `import fs from "node:fs";
import path from "node:path";
const clone = process.env.DIBS_CLONE;
const home = process.env.DIBS_HOME;
const participant = process.env.DIBS_PARTICIPANT;
const lobbyId = Number(process.env.DIBS_LOBBY_ID);
fs.mkdirSync(path.join(home, participant), { recursive: true });
fs.writeFileSync(path.join(home, participant, "hook-alive.json"), JSON.stringify({ lobbyId, provider: "claude", sessionId: "fake", atUs: Date.now() * 1000 }));
fs.mkdirSync(path.join(clone, "src", "auth"), { recursive: true });
fs.writeFileSync(path.join(clone, "src", "auth", "login.js"), "export const login = () => {};\\n");
fs.writeFileSync(path.join(clone, "notes.txt"), "leak\\n");
if (process.env.DIBS_FAKE_HOLD === "1") setInterval(() => {}, 1000);
`,
  );
  return file;
}

describe("dibs session", () => {
  it("preps a clone, launches an agent, and pushes the final commit", async () => {
    const { root, clone, bare, base } = await fixture();
    const home = temp("dibs-home-");
    const codexHome = temp("dibs-codex-");
    const common = {
      home,
      participant: "claude",
      provider: "claude" as const,
      clonePath: clone,
      lobbiesUrl: bare,
      offline: true,
      codexHome,
      mode: "dibs" as const,
      baseSha: base,
      buildHash: localBuildHash(),
      fallbackAtUs: Date.now() * 1000 + 60_000_000,
      endsAtUs: Date.now() * 1000 + 600_000_000,
      startedAtUs: Date.now() * 1000,
      prompt: "Implement the fixture and use dibs.",
    };
    await prep({ ...common, lobbyId: 7 });
    const settings = fs.readFileSync(
      path.join(home, "claude", "claude.settings.json"),
      "utf8",
    );
    fs.writeFileSync(path.join(clone, "DIRTY.txt"), "nope");
    await prep({ ...common, lobbyId: 8 });
    expect(fs.existsSync(path.join(clone, "DIRTY.txt"))).toBe(false);
    expect(
      fs.readFileSync(
        path.join(home, "claude", "claude.settings.json"),
        "utf8",
      ),
    ).toBe(settings);
    expect(settings).not.toContain("lobby");
    const parsed = JSON.parse(settings) as {
      hooks: {
        PostToolUse: { hooks: { command: string; args: string[] }[] }[];
      };
    };
    expect(parsed.hooks.PostToolUse[0]?.hooks[0]?.command).toBe("node");
    expect(parsed.hooks.PostToolUse[0]?.hooks[0]?.args).toContain(
      "--participant",
    );
    expect(
      fs.readFileSync(
        path.join(clone, ".claude", "commands", "dibs.md"),
        "utf8",
      ),
    ).toContain("dibs_status");
    const report = await startSession({
      home,
      participant: "claude",
      codexHome,
      agentCommand: [process.execPath, agentScript(root)],
    });
    expect(report.outOfAreaFiles).toContain("notes.txt");
    expect(report.outOfAreaFiles).not.toContain("src/auth/login.js");
    expect(report.reported).toBe(false);
    const remote = await git(root, [
      "ls-remote",
      bare,
      "refs/heads/lobby/8/claude",
    ]);
    expect(remote.startsWith(report.sha)).toBe(true);
  });

  it("refuses the dibs checkout and a mismatched build", async () => {
    const { clone, bare, base } = await fixture();
    const home = temp("dibs-home-");
    const codexHome = temp("dibs-codex-");
    const baseOptions = {
      home,
      participant: "claude",
      provider: "claude" as const,
      lobbiesUrl: bare,
      offline: true,
      codexHome,
      mode: "dibs" as const,
      baseSha: base,
      buildHash: localBuildHash(),
      fallbackAtUs: 1,
      endsAtUs: 2,
      prompt: "x",
      lobbyId: 1,
    };
    await expect(prep({ ...baseOptions, clonePath: repo })).rejects.toThrow(
      /dibs checkout/,
    );
    await expect(
      prep({ ...baseOptions, clonePath: clone, buildHash: "deadbeef" }),
    ).rejects.toThrow(/build hash mismatch/);
  });

  it("merges the Codex trust block without dropping other config", async () => {
    const { clone, bare, base } = await fixture();
    const home = temp("dibs-home-");
    const codexHome = temp("dibs-codex-");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt"\n');
    const options = {
      home,
      participant: "codex",
      provider: "codex" as const,
      lobbyId: 2,
      clonePath: clone,
      lobbiesUrl: bare,
      offline: true,
      codexHome,
      mode: "chat" as const,
      baseSha: base,
      buildHash: localBuildHash(),
      fallbackAtUs: 1,
      endsAtUs: 2,
      prompt: "x",
    };
    await prep(options);
    await prep({ ...options, lobbyId: 3 });
    const trust = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    expect(trust).toContain('model = "gpt"');
    expect(trust.match(/dibs:trust:start/g)).toHaveLength(1);
    // Codex keys trust by the native real path; on Windows a forward-slash key is ignored.
    expect(trust).toContain(`[projects.'${fs.realpathSync.native(clone)}']`);
    expect(
      fs.readFileSync(path.join(clone, ".codex", "config.toml"), "utf8"),
    ).toContain("--provider");
  });

  it("names DIBS_HOME in every bridge and hook command", () => {
    const home = temp("dibs-home-");
    const clone = temp("dibs-clone-");
    for (const provider of ["claude", "codex", "droid"] as const) {
      const files = renderProvider({
        participant: provider,
        provider,
        clonePath: clone,
        home,
        codexHome: temp("dibs-codex-"),
      });
      const commands = files.filter((f) => f.body.includes("--provider"));
      expect(commands.length).toBeGreaterThan(0);
      for (const file of commands) {
        // Codex starts MCP servers with a filtered environment, so DIBS_HOME can't be inherited.
        const runs = file.body.split("--provider").length - 1;
        const homes = file.body.split(forwardSlash(home)).length - 1;
        expect(homes, file.path).toBe(runs);
      }
    }
  });

  it("launches provider CLIs without carrying memory between lobbies", () => {
    const settings = JSON.parse(
      fs.readFileSync(
        path.join(packageRoot(), "templates", "claude.settings.json"),
        "utf8",
      ),
    ) as { autoMemoryEnabled?: boolean };
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(providerCommand("codex", {}, "go").join(" ")).toContain(
      "-c features.memories=false",
    );
  });

  it.runIf(process.platform === "win32")(
    "runs an npm .cmd shim through node",
    () => {
      const bin = temp("dibs-shim-");
      const shim = path.join(bin, "fakecli.cmd");
      fs.writeFileSync(
        shim,
        '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\fake\\bin\\cli.js" %*\r\n',
      );
      const previous = process.env.DIBS_FAKECLI_BIN;
      process.env.DIBS_FAKECLI_BIN = shim;
      try {
        expect(resolveCommand("fakecli")).toEqual([
          process.execPath,
          path.join(bin, "node_modules", "fake", "bin", "cli.js"),
        ]);
      } finally {
        if (previous === undefined) delete process.env.DIBS_FAKECLI_BIN;
        else process.env.DIBS_FAKECLI_BIN = previous;
      }
    },
  );

  it("stops a process tree", async () => {
    const root = temp("dibs-kill-");
    const child = spawnAgent(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      {
        cwd: root,
        env: process.env,
        logPath: path.join(root, "agent.log"),
      },
    );
    expect(pidAlive(child.pid)).toBe(true);
    await killTree(child.pid);
    await child.exited;
    expect(pidAlive(child.pid)).toBe(false);
  });

  it("runs prep through the dibs CLI", async () => {
    const { clone, bare, base } = await fixture();
    const home = temp("dibs-home-");
    const codexHome = temp("dibs-codex-");
    const tsx = path.join(repo, "node_modules", "tsx", "dist", "cli.mjs");
    const { stdout } = await exec(
      process.execPath,
      [
        tsx,
        path.join(repo, "packages", "cli", "src", "dibs.ts"),
        "session",
        "prep",
        "11",
        "--participant",
        "claude",
        "--provider",
        "claude",
        "--clone",
        clone,
        "--lobbies",
        bare,
        "--offline",
        "--mode",
        "dibs",
        "--base",
        base,
        "--build-hash",
        localBuildHash(),
        "--fallback-at-us",
        "10",
        "--ends-at-us",
        "20",
        "--prompt",
        "ship it",
        "--home",
        home,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, DIBS_HOME: home, DIBS_CODEX_HOME: codexHome },
        cwd: repo,
      },
    );
    expect(stdout).toContain("lobby 11");
    expect(fs.existsSync(path.join(home, "claude", "session.json"))).toBe(true);
  });
});

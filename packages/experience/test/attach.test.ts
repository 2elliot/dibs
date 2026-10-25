import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import {
  planAttachment,
  applyAttachment,
  detachAttachment,
} from "../src/attach.ts";
import {
  encodeJoin,
  decodeJoin,
  projectHome,
  operationLock,
  main,
} from "../src/main.ts";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-attach-"));
  const project = path.join(root, "ordinary project");
  fs.mkdirSync(project);
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, "bridge.mjs"), "");
  fs.writeFileSync(path.join(runtime, "dibs-hook.mjs"), "");
  return { root, project, runtime, home: path.join(root, "state") };
}
describe("ordinary project attachment", () => {
  test("incomplete setup cannot claim that the remote project was closed", async () => {
    const { root, project } = setup();
    const previous = process.env.DIBS_HOME;
    process.env.DIBS_HOME = path.join(root, "state-home");
    try {
      const home = projectHome(project, "claude");
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(
        path.join(home, "state.json"),
        JSON.stringify({
          version: 1,
          project,
          provider: "claude",
          operation: "create",
        }),
      );
      await expect(
        main(["close", "--provider", "claude", "--project", project]),
      ).rejects.toThrow("Setup is incomplete");
    } finally {
      if (previous === undefined) delete process.env.DIBS_HOME;
      else process.env.DIBS_HOME = previous;
    }
  });
  test("mutation locks exclude concurrent commands and recover an interrupted stale lock", () => {
    const { home } = setup();
    const release = operationLock(home);
    expect(() => operationLock(home)).toThrow("Another dibs command");
    release();
    const file = path.join(home, "operation.lock");
    fs.writeFileSync(file, "");
    expect(() => operationLock(home)).toThrow("Another dibs command");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    const recovered = operationLock(home);
    recovered();
    expect(fs.existsSync(file)).toBe(false);
  });
  test("Claude preserves other MCP servers, hooks and permissions; detach preserves later user edits", () => {
    const { project, runtime, home } = setup();
    fs.mkdirSync(path.join(project, ".claude"));
    fs.writeFileSync(path.join(project, "work.txt"), "uncommitted work");
    fs.writeFileSync(
      path.join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { existing: { command: "existing" } } }),
    );
    fs.writeFileSync(
      path.join(project, ".claude/settings.local.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "existing" }] }],
        },
        permissions: { allow: ["Read"] },
      }),
    );
    const plan = planAttachment(project, "claude", home, runtime);
    applyAttachment(plan);
    const mcp = JSON.parse(
      fs.readFileSync(path.join(project, ".mcp.json"), "utf8"),
    );
    expect(mcp.mcpServers.existing.command).toBe("existing");
    expect(mcp.mcpServers.dibs.args).toContain(home);
    const file = path.join(project, ".claude/settings.local.json");
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    settings.userAdded = true;
    fs.writeFileSync(file, JSON.stringify(settings));
    expect(detachAttachment(home)).toEqual([]);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after.userAdded).toBe(true);
    expect(after.permissions.allow).toEqual(["Read"]);
    expect(after.hooks.SessionStart).toHaveLength(1);
    expect(fs.readFileSync(path.join(project, "work.txt"), "utf8")).toBe(
      "uncommitted work",
    );
    expect(fs.existsSync(path.join(project, ".git"))).toBe(false);
  });
  test("Codex preserves TOML comments and unrelated settings; never writes trust", () => {
    const { root, project, runtime, home } = setup();
    fs.mkdirSync(path.join(project, ".codex"));
    const file = path.join(project, ".codex/config.toml");
    const original =
      '# keep this comment\nmodel = "user-choice"\n[mcp_servers.docs]\ncommand = "docs"\n';
    fs.writeFileSync(file, original);
    applyAttachment(planAttachment(project, "codex", home, runtime));
    const installed = fs.readFileSync(file, "utf8");
    expect(installed.startsWith(original)).toBe(true);
    expect((parse(installed).mcp_servers as any).dibs.command).toBe(
      process.execPath,
    );
    fs.appendFileSync(file, "\n[custom]\nkeep = true\n");
    detachAttachment(home);
    expect(fs.readFileSync(file, "utf8")).toBe(
      original + "\n[custom]\nkeep = true\n",
    );
    expect(fs.existsSync(path.join(root, "config.toml"))).toBe(false);
  });
  test("malformed or occupied settings fail before any writes", () => {
    const { project, runtime, home } = setup();
    fs.mkdirSync(path.join(project, ".codex"));
    const file = path.join(project, ".codex/config.toml");
    fs.writeFileSync(file, "broken = [");
    expect(() => planAttachment(project, "codex", home, runtime)).toThrow(
      "Cannot parse",
    );
    expect(fs.readFileSync(file, "utf8")).toBe("broken = [");
    fs.writeFileSync(file, '[mcp_servers.dibs]\ncommand="someone-else"\n');
    expect(() => planAttachment(project, "codex", home, runtime)).toThrow(
      "existing dibs",
    );
    expect(fs.existsSync(home)).toBe(false);
  });
  test("a concurrent edit aborts setup and rolls back only unchanged installed files", () => {
    const { project, runtime, home } = setup();
    const plan = planAttachment(project, "claude", home, runtime);
    fs.mkdirSync(path.join(project, ".claude"));
    fs.writeFileSync(
      path.join(project, ".claude/settings.local.json"),
      '{"new":true}',
    );
    expect(() => applyAttachment(plan)).toThrow("changed during setup");
    expect(fs.existsSync(path.join(project, ".mcp.json"))).toBe(false);
    expect(
      fs.readFileSync(
        path.join(project, ".claude/settings.local.json"),
        "utf8",
      ),
    ).toBe('{"new":true}');
  });
  test("join tokens carry their server and reject unsafe addresses; projects have independent state", () => {
    const { project, root } = setup();
    const code = "a".repeat(48);
    expect(decodeJoin(encodeJoin("https://example.com", code))).toEqual({
      server: "https://example.com",
      code,
    });
    expect(() => encodeJoin("http://remote.invalid", code)).toThrow();
    expect(() => decodeJoin("abc")).toThrow("Invalid join");
    expect(projectHome(project, "claude", root)).not.toBe(
      projectHome(project, "codex", root),
    );
  });
  test.each(["claude", "codex"] as const)(
    "%s recovers partial configuration writes with the original detach ownership",
    (provider) => {
      const { project, runtime, home } = setup();
      const plan = planAttachment(project, provider, home, runtime);
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(
        path.join(home, "attachment.json"),
        JSON.stringify(plan),
      );
      const first = plan.changes[0]!;
      fs.mkdirSync(path.dirname(first.file), { recursive: true });
      fs.writeFileSync(first.file, first.after);
      // A restart must preserve the original before/owned-edit journal instead
      // of interpreting the installed dibs entries as user-owned configuration.
      const recovered = planAttachment(project, provider, home, runtime);
      expect(recovered.changes[0]!.before).toBeNull();
      applyAttachment(recovered);
      // Repeating after every file was written is also safe if state.json was
      // not yet marked attached when the process stopped.
      applyAttachment(planAttachment(project, provider, home, runtime));
      expect(detachAttachment(home)).toEqual([]);
      for (const change of plan.changes)
        expect(fs.existsSync(change.file)).toBe(false);
    },
  );
});

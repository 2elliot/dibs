// Run through npm run so npm_execpath resolves on Windows and Unix alike.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run npm run smoke:package -w @dibs/experience.");
const npm = (args, cwd = repo) =>
  execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-installed-"));
const packed = JSON.parse(
  npm([
    "pack",
    "--workspace",
    "@dibs/experience",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    scratch,
  ]),
);
const archive = path.join(scratch, packed[0].filename);
const prefix = path.join(scratch, "unrelated-install");
npm([
  "install",
  "--prefix",
  prefix,
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  archive,
]);
const project = path.join(scratch, "empty-project");
fs.mkdirSync(project);
// npm exec actually invokes the installed bin, including the Unix symlink.
// Direct `node dist/cli.mjs` would miss bin-entrypoint and archive mistakes.
const help = npm(
  ["exec", "--offline", "--prefix", prefix, "--", "dibs", "--help"],
  project,
);
assert.match(help, /dibs create --provider claude\|codex\|droid/);
assert.match(help, /dibs join <code> --provider claude\|codex\|droid/);
const installed = path.join(prefix, "node_modules", "@dibs", "experience");
const metadata = JSON.parse(
  fs.readFileSync(path.join(installed, "package.json"), "utf8"),
);
assert.equal(
  Object.keys(metadata.dependencies ?? {}).length,
  0,
  "Runtime must not fetch monorepo packages",
);
for (const file of ["cli.mjs", "bridge.mjs", "dibs-hook.mjs", "service.json"])
  assert.ok(fs.statSync(path.join(installed, "dist", file)).size > 0);
const defaults = JSON.parse(
  fs.readFileSync(path.join(installed, "dist/service.json"), "utf8"),
);
if (process.env.DIBS_DEFAULT_SERVER)
  assert.equal(defaults.server, process.env.DIBS_DEFAULT_SERVER);
const bin = path.join(
  prefix,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "dibs.cmd" : "dibs",
);
assert.ok(fs.existsSync(bin));
console.log(
  "Packed archive installs and its native bin runs outside the source checkout.",
);

if (process.env.DIBS_TEST_URI) {
  // Source helpers provision a fresh local server-side module only. All user
  // commands below execute the relocated packed CLI without tsx/source imports.
  const { prepare, fresh, uri } =
    await import("../../spacetime/test/harness.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/sdk/client/stdio.js");
  const h = await fresh(await prepare());
  const http = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ dbUri: uri, dbName: h.dbName }));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const service = `http://127.0.0.1:${http.address().port}`;
  const peerProject = path.join(scratch, "another-empty-project");
  fs.mkdirSync(peerProject);
  const droidProject = path.join(scratch, "a-third-empty-project");
  fs.mkdirSync(droidProject);
  const home = path.join(scratch, "private-state");
  const env = { ...process.env, DIBS_HOME: home };
  const exec = promisify(execFile);
  const run = async (args, cwd) =>
    (
      await exec(
        process.execPath,
        [
          npmCli,
          "exec",
          "--offline",
          "--prefix",
          prefix,
          "--",
          "dibs",
          ...args,
        ],
        { cwd, env, timeout: 30000 },
      )
    ).stdout;
  let transport, client;
  try {
    await h.admin.reducers.configureProjects({
      enabled: true,
      maxActiveRooms: 10,
      maxRoomsPerDay: 20,
      maxLeasesPerDay: 100,
    });
    const output = await run(
      [
        "create",
        "--provider",
        "claude",
        "--brief",
        "Packaged API and frontend",
        "--server",
        service,
      ],
      project,
    );
    const code = output.match(/dibs1_[A-Za-z0-9_-]+/)?.[0];
    assert.ok(code, "Packaged create did not produce a join code");
    await run(["join", code, "--provider", "codex"], peerProject);
    await run(["join", code, "--provider", "droid"], droidProject);
    const status = JSON.parse(
      await run(["status", "--provider", "codex", "--json"], peerProject),
    );
    assert.equal(status.roster.length, 3);
    // Each provider's own config file must launch the installed bridge.
    for (const [cwd, file] of [
      [project, ".mcp.json"],
      [droidProject, ".factory/mcp.json"],
    ]) {
      const config = JSON.parse(fs.readFileSync(path.join(cwd, file), "utf8"))
        .mcpServers.dibs;
      assert.ok(
        config.args[0].startsWith(installed),
        `${file} must use installed package assets`,
      );
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd,
        env,
        stderr: "pipe",
      });
      client = new Client({ name: "installed-package-smoke", version: "1" });
      await client.connect(transport);
      const deadline = Date.now() + 15000;
      let connected = false;
      while (Date.now() < deadline) {
        const result = await client.callTool({
          name: "dibs_status",
          arguments: {},
        });
        const data = JSON.parse(
          result.content.find((x) => x.type === "text").text,
        );
        if (data.status === "ok" && data.roster.length === 3) {
          connected = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(
        connected,
        `Installed bridge from ${file} did not connect to its project membership`,
      );
      await client.close();
      client = undefined;
      await transport.close();
      transport = undefined;
    }
    await run(["leave", "--provider", "droid"], droidProject);
    assert.ok(!fs.existsSync(path.join(droidProject, ".factory/hooks.json")));
    await run(["leave", "--provider", "codex"], peerProject);
    await run(["close", "--provider", "claude"], project);
    assert.ok(!fs.existsSync(path.join(project, ".mcp.json")));
    console.log(
      "Installed create/join/status, packaged MCP connections, leave and close pass for Claude, Codex and Droid in three ordinary directories.",
    );
  } finally {
    if (client) await client.close();
    if (transport) await transport.close();
    await new Promise((resolve) => http.close(resolve));
    h.close();
  }
}

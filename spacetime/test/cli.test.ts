import { afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { saveConfig, saveToken, dibsHome } from "@dibs/client/node";
import { EXPORTED_TABLES, PROTOCOL_VERSION } from "@dibs/protocol";
import { fresh, prepare, uri, type Harness } from "./harness.ts";
let path: string, h: Harness;
beforeAll(async () => {
  path = await prepare();
});
beforeEach(async () => {
  h = await fresh(path);
  await saveConfig({ dbUri: uri, dbName: h.dbName });
  await saveToken("admin", h.tokens.admin);
});
afterEach(() => h?.close());
function cli(args: string[]) {
  if (args[0] === "sim" && !args.includes("--uri"))
    args = [...args, "--uri", uri];
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "packages/cli/src/dibs.ts", ...args],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { ...process.env },
      encoding: "utf8",
      timeout: 25000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}
const last = (value: string) => value.trim().split(/\r?\n/).at(-1)!;
test("CLI invite → join → lobby create/start → export → stop uses saved local state", async () => {
  const code = last(cli(["admin", "invite", "cli-peer", "codex", "agent"]));
  expect(code).toMatch(/^[a-f0-9]{48}$/);
  expect(
    cli([
      "join",
      "--uri",
      uri,
      "--db",
      h.dbName,
      "--participant",
      "cli-peer",
      "--code",
      code,
    ]),
  ).toContain("Joined as cli-peer");
  const manifest = join(dibsHome(), "manifest.json"),
    charter = join(dibsHome(), "charter.txt");
  await writeFile(
    manifest,
    JSON.stringify({
      vocabulary: [{ key: "auth.session", description: "session" }],
    }),
  );
  await writeFile(charter, "CLI integration test");
  const id = last(
    cli([
      "lobby",
      "create",
      "--scenario",
      "cli",
      "--mode",
      "chat",
      "--base",
      "a".repeat(40),
      "--manifest",
      manifest,
      "--charter",
      charter,
      "--build",
      "test-v1",
    ]),
  );
  expect(id).toMatch(/^\d+$/);
  expect(cli(["lobby", "start", id])).toContain("running");
  const output = join(dibsHome(), "nested", "events.json");
  cli(["export", id, "--db", h.dbName, "--out", output, "--label", "CLI test"]);
  const data = JSON.parse(await readFile(output, "utf8"));
  expect(data.protocolVersion).toBe(PROTOCOL_VERSION);
  expect(data.label).toBe("CLI test");
  expect(Object.keys(data.tables)).toEqual([...EXPORTED_TABLES]);
  expect(data.tables.lobby[0].state).toBe("running");
  expect(typeof data.tables.lobby[0].startedAtUs).toBe("number");
  expect(typeof data.tables.participant[0].identity).toBe("string");
  expect(data.tables.participant[0].currentLobbyId).toBeNull();
  expect(cli(["lobby", "stop", id])).toContain("stopped");
  expect(() =>
    cli([
      "admin",
      "invite",
      "bad-role",
      "claude",
      "agent",
      "--participant",
      "cli-peer",
    ]),
  ).toThrow("not admin");
  expect(() => cli(["export", "999999", "--out", output])).toThrow(
    "unknown lobby",
  );
});
test("production-timing simulator reaches verified, aligned and escalated on repeated runs", async () => {
  for (const scenario of ["s2", "aligned", "escalate"]) {
    const out = join(dibsHome(), `sim-${scenario}.json`);
    const log = cli([
      "sim",
      "--db",
      h.dbName,
      "--scenario",
      scenario,
      "--out",
      out,
    ]);
    const data = JSON.parse(await readFile(out, "utf8"));
    expect(log).toContain("SIMULATION");
    expect(data.label).toContain("SIMULATION");
    if (scenario === "escalate") {
      expect(
        data.tables.proposal.map((p: { state: string }) => p.state),
      ).toEqual(["rejected", "escalated"]);
      expect(data.tables.contract).toHaveLength(0);
    } else {
      expect(data.tables.lobby[0].state).toBe("verified");
      expect(data.tables.verification).toHaveLength(1);
      expect(data.tables.review[0].model).toBe("fake");
      expect(data.tables.contract[0].source).toBe(
        scenario === "aligned" ? "aligned" : "agreed",
      );
      expect(data.tables.proposal).toHaveLength(scenario === "aligned" ? 0 : 1);
    }
  }
}, 45000);
test("simulator options leave real integration checkpoints and never publish remotely", async () => {
  for (const stop of ["plans", "proposal", "agreed"]) {
    const out = join(dibsHome(), `checkpoint-${stop}.json`);
    cli(["sim", "--db", h.dbName, "--stop-after", stop, "--out", out]);
    const data = JSON.parse(await readFile(out, "utf8"));
    expect(data.tables.lobby[0].state).toBe("running");
    expect(data.tables.verification).toHaveLength(0);
    if (stop === "plans") {
      expect(data.tables.job[0].state).toBe("queued");
      expect(data.tables.proposal).toHaveLength(0);
    }
    if (stop === "proposal")
      expect(data.tables.proposal[0].state).toBe("proposed");
    if (stop === "agreed")
      expect(data.tables.contract[0].source).toBe("agreed");
  }
  const out = join(dibsHome(), "no-agents.json");
  cli([
    "sim",
    "--db",
    h.dbName,
    "--agents",
    "none",
    "--worker",
    "none",
    "--out",
    out,
  ]);
  const data = JSON.parse(await readFile(out, "utf8"));
  expect(data.tables.plan).toHaveLength(0);
  expect(data.tables.job).toHaveLength(0);
  const workerOut = join(dibsHome(), "real-worker.json");
  cli(["sim", "--db", h.dbName, "--worker", "none", "--out", workerOut]);
  const workerData = JSON.parse(await readFile(workerOut, "utf8"));
  expect(workerData.tables.job[0].state).toBe("queued");
  expect(workerData.tables.proposal).toHaveLength(0);
  expect(() =>
    cli([
      "sim",
      "--uri",
      "https://maincloud.spacetimedb.com",
      "--db",
      "dibs-i1-test",
    ]),
  ).toThrow("loopback");
  expect(() => cli(["sim", "--db", "another-issue"])).toThrow("dibs-i1-");
}, 45000);

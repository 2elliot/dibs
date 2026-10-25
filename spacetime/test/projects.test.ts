import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fresh, prepare, uri, type Harness } from "./harness.ts";
import { waitFor } from "../../packages/cli/src/commands/common.ts";
import { ownerSql, spacetime } from "../../packages/cli/src/commands/local.ts";
import {
  main as projectMain,
  projectHome,
  encodeJoin,
} from "../../packages/experience/src/main.ts";
import {
  connectSession,
  loadDbBuilder,
  RemoteStore,
} from "../../packages/bridge/src/spacetime.ts";
import { createBridge } from "../../packages/bridge/src/mcp.ts";
import { syncOnce } from "../../packages/bridge/src/inbox.ts";
// @ts-expect-error The zero-dependency native hook is JavaScript, outside this test TS project.
import { runHook } from "../../packages/bridge/hook/dibs-hook.mjs";

let modulePath: string, h: Harness;
const code = () => randomBytes(24).toString("hex");
const args = (joinCode = code()) => ({
  code: joinCode,
  provider: "claude",
  brief: "Build a frontend and an API together",
  vocabularyJson: '[{"key":"project.interface","description":"Shared API"}]',
  protocol: "project-v1",
});
beforeAll(async () => {
  modulePath = await prepare();
});
beforeEach(async () => {
  h = await fresh(modulePath);
  await h.admin.reducers.configureProjects({
    enabled: true,
    maxActiveRooms: 10,
    maxRoomsPerDay: 20,
    maxLeasesPerDay: 100,
  });
});
afterEach(() => {
  h?.close();
  vi.restoreAllMocks();
});
async function project() {
  const owner = await h.stranger();
  const input = args();
  await owner.reducers.createProject(input);
  const row = await waitFor(() =>
    [...h.admin.db.lobby.iter()].find((l) => l.scenario === "project"),
  );
  return { owner, input, lobbyId: row.id };
}
describe("ordinary project rooms on a real database", () => {
  test("operator gate, idempotent create and private capabilities survive an additive upgrade", async () => {
    await h.admin.reducers.configureProjects({
      enabled: false,
      maxActiveRooms: 10,
      maxRoomsPerDay: 20,
      maxLeasesPerDay: 100,
    });
    const owner = await h.stranger();
    const input = args();
    await expect(owner.reducers.createProject(input)).rejects.toThrow(
      "not enabled",
    );
    await h.admin.reducers.configureProjects({
      enabled: true,
      maxActiveRooms: 10,
      maxRoomsPerDay: 20,
      maxLeasesPerDay: 100,
    });
    await owner.reducers.createProject(input);
    await owner.reducers.createProject({
      ...input,
      vocabularyJson: JSON.stringify([
        { description: "Shared API", key: "project.interface" },
      ]),
    });
    const lobby = await waitFor(() =>
      [...h.admin.db.lobby.iter()].find((l) => l.scenario === "project"),
    );
    expect(
      [...h.admin.db.lobby.iter()].filter((l) => l.scenario === "project"),
    ).toHaveLength(1);
    const output = JSON.stringify(
      [...h.admin.db.request.iter(), ...h.admin.db.event.iter(), lobby],
      (_, v) => (typeof v === "bigint" ? String(v) : v),
    );
    expect(output).not.toContain(input.code);
    const stranger = await h.stranger();
    const privateRead = new Promise<unknown>((resolve, reject) => {
      stranger
        .subscriptionBuilder()
        .onApplied(() => reject(new Error("Private room was exposed")))
        .onError((ctx) => resolve(ctx.event))
        .subscribe("SELECT * FROM project_room");
    });
    await expect(privateRead).resolves.toBeDefined();
    // Republish with retained rows. No --delete-data is used; identities, plans,
    // room capabilities and benchmark rows must survive the migration path.
    spacetime([
      "publish",
      "--server",
      uri,
      "--module-path",
      modulePath,
      "--yes",
      "--delete-data=never",
      h.dbName,
    ]);
    const rows = ownerSql(uri, h.dbName, "SELECT lobby_id FROM project_room");
    expect(rows.some((r) => Number(r[0]) === lobby.id)).toBe(true);
    await owner.reducers.resumeProject({
      lobbyId: lobby.id,
      protocol: "project-v1",
    });
  });
  test("provider seats are atomic, capability-gated and identity-bound; benchmark joins cannot bypass them", async () => {
    const { input, lobbyId, owner } = await project();
    const a = await h.stranger(),
      b = await h.stranger();
    const join = {
      code: input.code,
      provider: "codex",
      protocol: "project-v1",
    };
    const outcomes = await Promise.allSettled([
      a.reducers.joinProject(join),
      b.reducers.joinProject(join),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = outcomes[0].status === "fulfilled" ? a : b;
    const loser = winner === a ? b : a;
    await winner.reducers.joinProject(join);
    await expect(
      loser.reducers.resumeProject({ lobbyId, protocol: "project-v1" }),
    ).rejects.toThrow("Not a member");
    await expect(
      loser.reducers.joinProject({ ...join, code: code() }),
    ).rejects.toThrow("Invalid project join");
    await expect(
      h.peer.codex.reducers.joinLobby({ lobbyId, buildHash: "project-v1" }),
    ).rejects.toThrow("project membership");
    await winner.reducers.leaveProject({ lobbyId });
    const benchmark = await h.lobby("dibs", [], false);
    await expect(
      winner.reducers.joinLobby({ lobbyId: benchmark, buildHash: "test-v1" }),
    ).rejects.toThrow("Project identities cannot join benchmark");
    await expect(loser.reducers.joinProject(join)).rejects.toThrow(
      "already taken",
    );
    await winner.reducers.resumeProject({ lobbyId, protocol: "project-v1" });
    await expect(winner.reducers.closeProject({ lobbyId })).rejects.toThrow(
      "creator",
    );
    await owner.reducers.closeProject({ lobbyId });
    await expect(
      winner.reducers.resumeProject({ lobbyId, protocol: "project-v1" }),
    ).rejects.toThrow("closed or expired");
    await expect(
      owner.reducers.publishPlan({
        requestId: randomUUID(),
        goal: "late",
        produces: [],
        requires: [],
        notes: "",
      }),
    ).rejects.toThrow();
  });
  test("one room seats Claude, Codex and Droid, and rejects other providers", async () => {
    const { input, lobbyId } = await project();
    const join = (provider: string) => ({
      code: input.code,
      provider,
      protocol: "project-v1",
    });
    const codex = await h.stranger(),
      droid = await h.stranger(),
      other = await h.stranger();
    await codex.reducers.joinProject(join("codex"));
    await droid.reducers.joinProject(join("droid"));
    await expect(other.reducers.joinProject(join("gemini"))).rejects.toThrow(
      "Claude, Codex and Droid",
    );
    await expect(other.reducers.joinProject(join("droid"))).rejects.toThrow(
      "already taken",
    );
    const seats = await waitFor(() => {
      const providers = [...h.admin.db.participant.iter()]
        .filter((p) => p.currentLobbyId === lobbyId)
        .map((p) => p.provider)
        .sort();
      return providers.length === 3 && providers;
    });
    expect(seats).toEqual(["claude", "codex", "droid"]);
  });
  test("global creation/analysis budgets terminate unavailable jobs without allocating another lease", async () => {
    await h.admin.reducers.configureProjects({
      enabled: true,
      maxActiveRooms: 1,
      maxRoomsPerDay: 1,
      maxLeasesPerDay: 1,
    });
    const { owner, lobbyId } = await project();
    const other = await h.stranger();
    await expect(other.reducers.createProject(args())).rejects.toThrow(
      "creation budget",
    );
    const publish = async (goal: string) => {
      await owner.reducers.publishPlan({
        requestId: randomUUID(),
        goal,
        produces: [{ key: "project.interface", text: goal }],
        requires: [],
        notes: "",
      });
      return waitFor(() =>
        [...h.admin.db.job.iter()].find(
          (j) => j.lobbyId === lobbyId && j.state === "queued",
        ),
      );
    };
    const job = await publish("version one");
    const token = randomUUID();
    await h.peer.worker.reducers.leaseJob({ jobId: job.id, leaseToken: token });
    const leased = await waitFor(() =>
      [...h.admin.db.job.iter()].find(
        (j) => j.id === job.id && j.state === "leased",
      ),
    );
    await h.peer.worker.reducers.submitAnalysis({
      jobId: job.id,
      leaseToken: token,
      inputKey: leased.inputKey,
      findingsJson: '{"findings":[]}',
    });
    const next = await publish("version two");
    await h.peer.worker.reducers.leaseJob({
      jobId: next.id,
      leaseToken: randomUUID(),
    });
    const failed = await waitFor(() =>
      [...h.admin.db.job.iter()].find(
        (j) => j.id === next.id && j.state === "failed",
      ),
    );
    expect(failed.calls).toBe(1);
    expect(failed.error).toContain("budget");
    expect(
      [...h.admin.db.delivery.iter()].some(
        (d) => d.lobbyId === lobbyId && d.summary.includes("budget"),
      ),
    ).toBe(true);
  });
  test("two non-Git directories attach, exchange real bridge tools/hooks, agree, detach and resume", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-project-e2e-"));
    const claudeDir = path.join(root, "claude-project"),
      codexDir = path.join(root, "codex-project");
    fs.mkdirSync(claudeDir);
    fs.mkdirSync(codexDir);
    fs.writeFileSync(path.join(claudeDir, "user-work.txt"), "preserve me");
    process.env.DIBS_HOME = path.join(root, "home");
    const http = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ dbUri: uri, dbName: h.dbName }));
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const server = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const remotes: Awaited<ReturnType<typeof connectSession>>[] = [];
    const clients: Client[] = [];
    try {
      await projectMain([
        "create",
        "--provider",
        "claude",
        "--project",
        claudeDir,
        "--server",
        server,
        "--brief",
        "API and frontend",
      ]);
      const claudeHome = projectHome(claudeDir, "claude");
      const read = (home: string) =>
        JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
      const owner = read(claudeHome),
        joinCode = encodeJoin(server, owner.code);
      await projectMain([
        "join",
        joinCode,
        "--provider",
        "codex",
        "--project",
        codexDir,
      ]);
      const codexHome = projectHome(codexDir, "codex"),
        peer = read(codexHome);
      for (const [home, state] of [
        [claudeHome, owner],
        [codexHome, peer],
      ] as const) {
        const remote = await connectSession({
          builder: await loadDbBuilder(),
          uri,
          database: h.dbName,
          token: state.token,
          participant: state.participant,
          provider: state.provider,
          lobbyId: state.lobbyId,
          buildHash: "different-build-is-fine",
          project: true,
        });
        remotes.push(remote);
        const store = new RemoteStore(remote);
        const bridge = createBridge(store, {
          mode: "dibs",
          dir: path.join(home, state.provider),
        });
        const [a, b] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: state.provider, version: "test" });
        await bridge.connect(a);
        await client.connect(b);
        clients.push(client);
      }
      await clients[0].callTool({
        name: "dibs_plan",
        arguments: {
          goal: "API",
          produces: [
            {
              key: "project.interface",
              statement: "GET /greeting returns {message:string}",
            },
          ],
          requires: [],
        },
      });
      await clients[1].callTool({
        name: "dibs_plan",
        arguments: {
          goal: "Frontend",
          produces: [],
          requires: [
            {
              key: "project.interface",
              assumption: "GET /hello returns {text:string}",
            },
          ],
        },
      });
      const job = await waitFor(() =>
        [...h.admin.db.job.iter()].find(
          (j) => j.lobbyId === owner.lobbyId && j.state === "queued",
        ),
      );
      const leaseToken = randomUUID();
      await h.peer.worker.reducers.leaseJob({ jobId: job.id, leaseToken });
      const leased = await waitFor(() =>
        [...h.admin.db.job.iter()].find(
          (j) => j.id === job.id && j.state === "leased",
        ),
      );
      const items = [...h.admin.db.planItem.iter()].filter(
        (i) => i.lobbyId === owner.lobbyId && i.current,
      );
      await h.peer.worker.reducers.submitAnalysis({
        jobId: job.id,
        leaseToken,
        inputKey: leased.inputKey,
        findingsJson: JSON.stringify({
          findings: [
            {
              key: "project.interface",
              relation: "conflict",
              contractText: "GET /greeting returns JSON {message:string}.",
              citedItemIds: items.map((i) => i.id),
              explanation: "Agree the route and response.",
            },
          ],
        }),
      });
      const proposal = await waitFor(() =>
        [...h.admin.db.proposal.iter()].find(
          (p) => p.lobbyId === owner.lobbyId && p.state === "proposed",
        ),
      );
      for (let i = 0; i < clients.length; i++) {
        const state = i === 0 ? owner : peer,
          home = i === 0 ? claudeHome : codexHome,
          dir = i === 0 ? claudeDir : codexDir;
        await waitFor(() =>
          remotes[i]!.world().proposals.some((p) => p.id === proposal.id)
            ? true
            : undefined,
        );
        syncOnce(
          path.join(home, state.provider),
          new RemoteStore(remotes[i]!),
          { marking: new Set() },
        );
        const output = await runHook({
          argv: [
            "--provider",
            state.provider,
            "--participant",
            state.provider,
            "--home",
            home,
          ],
          input: {
            hook_event_name: "SessionStart",
            cwd: dir,
            session_id: "native-boundary-test",
          },
        });
        expect(output).toContain("dibs_plan");
        const status = await clients[i]!.callTool({
          name: "dibs_status",
          arguments: {},
        });
        expect(JSON.stringify(status)).toContain("GET /greeting");
        await clients[i]!.callTool({
          name: "dibs_respond",
          arguments: {
            proposalId: proposal.id,
            revision: proposal.revision,
            decision: "accept",
            reason: "",
          },
        });
      }
      await waitFor(() =>
        [...h.admin.db.contract.iter()].find(
          (c) => c.lobbyId === owner.lobbyId && c.source === "agreed",
        ),
      );
      expect(
        fs.readFileSync(path.join(claudeDir, "user-work.txt"), "utf8"),
      ).toBe("preserve me");
      expect(fs.existsSync(path.join(codexDir, ".git"))).toBe(false);
      for (const client of clients) await client.close();
      clients.length = 0;
      for (const remote of remotes) remote.close();
      remotes.length = 0;
      await projectMain([
        "leave",
        "--provider",
        "codex",
        "--project",
        codexDir,
      ]);
      expect(fs.existsSync(path.join(codexDir, ".codex/config.toml"))).toBe(
        false,
      );
      await projectMain([
        "join",
        joinCode,
        "--provider",
        "codex",
        "--project",
        codexDir,
      ]);
      expect(read(codexHome).token).toBe(peer.token);
      await projectMain([
        "close",
        "--provider",
        "claude",
        "--project",
        claudeDir,
      ]);
    } finally {
      for (const client of clients) await client.close();
      for (const remote of remotes) remote.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }, 60000);
});

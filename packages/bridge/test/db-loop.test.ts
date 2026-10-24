// Real-database loop for issue 2 phase B. Skipped unless DIBS_DB=1 and a local
// server is already published as dibs-i2-bridge (issue 2's database, port 4120).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { connect, type DbConnection } from "@dibs/client";
import { describe, expect, it } from "vitest";
import { localBuildHash } from "../src/build-hash.ts";
import { syncOnce, type SyncState } from "../src/inbox.ts";
import { createBridge } from "../src/mcp.ts";
import {
  connectSession,
  loadDbBuilder,
  RemoteStore,
} from "../src/spacetime.ts";
import { runHook } from "../hook/dibs-hook.mjs";

const uri = process.env.DIBS_DB_URI ?? "http://127.0.0.1:4120";
const dbName = "dibs-i2-bridge";
const enabled = process.env.DIBS_DB === "1";

describe("database loop", () => {
  it.skipIf(!enabled)(
    "a bridge plan, a fake peer, and a fake worker agree a contract",
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-loop-"));
      const clone = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-loop-clone-"));
      const run = randomUUID().slice(0, 8);
      const claude = `c${run}`;
      const codex = `x${run}`;
      const worker = `w${run}`;
      const hash = localBuildHash();
      const open: DbConnection[] = [];
      const admin = await claim(
        // The first run claims the module's own admin invite; later runs need a fresh name.
        await inviteCode(`a${run}`, "admin", "claude", "admin"),
      );
      open.push(admin);
      await subscribeAll(admin);
      const claudeCode = randomUUID();
      const codexCode = randomUUID();
      const workerCode = randomUUID();
      await admin.reducers.createInvite({
        code: claudeCode,
        name: claude,
        provider: "claude",
        role: "agent",
      });
      await admin.reducers.createInvite({
        code: codexCode,
        name: codex,
        provider: "codex",
        role: "agent",
      });
      await admin.reducers.createInvite({
        code: workerCode,
        name: worker,
        provider: "claude",
        role: "worker",
      });
      const codexConn = await claim(codexCode);
      const workerConn = await claim(workerCode);
      open.push(codexConn, workerConn);
      await admin.reducers.createLobby({
        scenario: `bridge-${run}`,
        mode: "dibs",
        baseSha: "0".repeat(40),
        vocabularyJson: JSON.stringify([
          {
            key: "auth.session",
            description: "How the browser stays logged in",
          },
        ]),
        charter: "Bridge integration loop.",
        buildHash: hash,
      });
      const lobby = await waitFor(() =>
        [...admin.db.lobby.iter()].find(
          (row) => row.scenario === `bridge-${run}`,
        ),
      );
      const lobbyId = Number(lobby.id);
      await admin.reducers.startLobby({ lobbyId });
      await waitFor(() => admin.db.lobby.id.find(lobbyId)?.state === "running");
      await codexConn.reducers.joinLobby({ lobbyId, buildHash: hash });
      const claudeSession = await connect({ uri, dbName });
      await claudeSession.conn.reducers.claimInvite({ code: claudeCode });
      writeParticipant(home, claude, "claude", lobbyId, clone, lobby);
      fs.writeFileSync(path.join(home, claude, "token"), claudeSession.token);
      claudeSession.conn.disconnect();
      fs.writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ dbUri: uri, dbName }),
      );
      const session = await connectSession({
        builder: await loadDbBuilder(),
        uri,
        database: dbName,
        token: fs.readFileSync(path.join(home, claude, "token"), "utf8").trim(),
        participant: claude,
        provider: "claude",
        lobbyId,
        buildHash: hash,
        log: () => undefined,
      });
      const store = new RemoteStore(session);
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const bridge = createBridge(store, {
        mode: "dibs",
        dir: path.join(home, claude),
      });
      await bridge.connect(serverTransport);
      const client = new Client({ name: "loop", version: "0" });
      await client.connect(clientTransport);
      try {
        const planned = JSON.parse(
          text(
            await client.callTool({
              name: "dibs_plan",
              arguments: {
                goal: "Implement authentication",
                produces: [
                  {
                    key: "auth.session",
                    statement: "Login returns a bearer token in Authorization.",
                  },
                ],
                requires: [],
              },
            }),
          ),
        ) as { status: string };
        expect(planned.status).toBe("ok");
        await codexConn.reducers.publishPlan({
          requestId: randomUUID(),
          goal: "Implement the browser",
          produces: [],
          requires: [
            {
              key: "auth.session",
              text: "Login sets an HttpOnly session cookie.",
            },
          ],
          notes: "",
        });
        const job = await waitFor(
          () =>
            [...admin.db.job.iter()].find(
              (row) =>
                Number(row.lobbyId) === lobbyId && row.state === "queued",
            ),
          20000,
        );
        const leaseToken = randomUUID();
        await workerConn.reducers.leaseJob({ jobId: job.id, leaseToken });
        const cited = [...admin.db.planItem.iter()]
          .filter((row) => Number(row.lobbyId) === lobbyId && row.current)
          .map((row) => Number(row.id));
        await workerConn.reducers.submitAnalysis({
          jobId: job.id,
          leaseToken,
          inputKey: job.inputKey,
          findingsJson: JSON.stringify({
            findings: [
              {
                key: "auth.session",
                relation: "conflict",
                citedItemIds: cited,
                explanation:
                  "One side uses a bearer token and the other a cookie.",
                contractText: "Use an HttpOnly session cookie.",
              },
            ],
          }),
        });
        const proposal = await waitFor(() =>
          store
            .world()
            .proposals.find(
              (row) => row.state === "proposed" && row.key === "auth.session",
            ),
        );
        syncOnce(path.join(home, claude), store, {
          marking: new Set(),
        } satisfies SyncState);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const printed = await runHook({
          argv: [
            "--participant",
            claude,
            "--provider",
            "claude",
            "--home",
            home,
          ],
          input: {
            hook_event_name: "UserPromptSubmit",
            cwd: clone,
            session_id: "loop",
          },
        });
        expect(printed).toContain("auth.session");
        const response = JSON.parse(
          text(
            await client.callTool({
              name: "dibs_respond",
              arguments: {
                proposalId: proposal.id,
                revision: proposal.revision,
                decision: "accept",
                reason: "",
              },
            }),
          ),
        ) as { status: string };
        expect(response.status).toBe("ok");
        await codexConn.reducers.respond({
          requestId: randomUUID(),
          proposalId: proposal.id,
          revision: proposal.revision,
          decision: "accept",
          reason: "",
        });
        await waitFor(() =>
          [...admin.db.contract.iter()].find(
            (row) =>
              Number(row.lobbyId) === lobbyId &&
              row.current &&
              row.source === "agreed",
          ),
        );
        const sql = spacetime([
          "sql",
          "--server",
          uri,
          "--format",
          "json",
          dbName,
          `SELECT source FROM contract WHERE lobby_id = ${lobbyId}`,
        ]);
        expect(sql).toContain("agreed");
      } finally {
        session.close();
        for (const conn of open) conn.disconnect();
      }
    },
    60000,
  );
});

async function claim(code: string): Promise<DbConnection> {
  const session = await connect({ uri, dbName });
  await session.conn.reducers.claimInvite({ code });
  return session.conn;
}

async function inviteCode(
  name: string,
  role: string,
  provider: string,
  existing: string,
): Promise<string> {
  const rows = JSON.parse(
    spacetime([
      "sql",
      "--server",
      uri,
      "--format",
      "json",
      dbName,
      `SELECT code, used FROM invite WHERE name = '${existing}'`,
    ]),
  )[0].rows as [string, boolean][];
  const open = rows.find((row) => row[1] === false);
  if (open) return String(open[0]).replaceAll('"', "");
  const code = randomUUID();
  spacetime([
    "call",
    "--server",
    uri,
    dbName,
    "create_invite",
    JSON.stringify(code),
    JSON.stringify(name),
    JSON.stringify(provider),
    JSON.stringify(role),
  ]);
  return code;
}

function writeParticipant(
  home: string,
  name: string,
  provider: string,
  lobbyId: number,
  clone: string,
  lobby: {
    baseSha: string;
    startedAtUs: bigint;
    fallbackAtUs: bigint;
    endsAtUs: bigint;
  },
): void {
  const dir = path.join(home, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "session.json"),
    JSON.stringify({
      participant: name,
      provider,
      lobbyId,
      mode: "dibs",
      clonePath: clone,
      baseSha: lobby.baseSha,
      startedAtUs: Number(lobby.startedAtUs),
      fallbackAtUs: Number(lobby.fallbackAtUs),
      endsAtUs: Number(lobby.endsAtUs),
    }),
  );
}

function subscribeAll(conn: DbConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("subscription timed out")),
      10000,
    );
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        clearTimeout(timer);
        resolve();
      })
      .onError((ctx) => {
        clearTimeout(timer);
        reject(ctx.event);
      })
      .subscribeToAllTables();
  });
}

async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs = 10000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error("timed out waiting for the database");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function spacetime(args: string[]): string {
  const exe = path.join(
    process.env.LOCALAPPDATA ?? "",
    "SpacetimeDB",
    "spacetime.exe",
  );
  return execFileSync(exe, args, { encoding: "utf8", timeout: 60000 });
}

function text(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] })
    .content;
  return content?.find((item) => item.type === "text")?.text ?? "{}";
}

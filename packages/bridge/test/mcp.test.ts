import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LIMITS } from "@dibs/protocol";
import { describe, expect, it } from "vitest";
import { pidAlive } from "../src/home.ts";
import { createBridge } from "../src/mcp.ts";
import { MemoryStore } from "../src/memory.ts";

const bundle = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/bridge.mjs",
);

async function clientFor(
  store: MemoryStore,
  mode: "none" | "chat" | "dibs",
  dir: string,
) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createBridge(store, { mode, dir });
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

function text(result: unknown): unknown {
  const content = (result as { content?: { type: string; text?: string }[] })
    .content;
  const block = content?.find((item) => item.type === "text");
  return JSON.parse(block?.text ?? "{}");
}

describe("MCP bridge", () => {
  it("registers the tools for the lobby mode, with the Codex annotations", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-mcp-"));
    const store = new MemoryStore({
      participant: "claude",
      provider: "claude",
      lobbyId: 3,
      mode: "dibs",
    });
    await store.connect();
    const dibs = await clientFor(store, "dibs", dir);
    const listed = await dibs.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "dibs_message",
      "dibs_plan",
      "dibs_respond",
      "dibs_status",
    ]);
    const status = listed.tools.find((tool) => tool.name === "dibs_status");
    expect(status?.annotations).toMatchObject({
      destructiveHint: false,
      readOnlyHint: true,
    });
    expect(
      listed.tools.find((tool) => tool.name === "dibs_plan")?.annotations,
    ).toMatchObject({ destructiveHint: false });
    const none = await clientFor(
      new MemoryStore({
        participant: "claude",
        provider: "claude",
        lobbyId: 3,
        mode: "none",
      }),
      "none",
      dir,
    );
    expect((await none.listTools()).tools.map((tool) => tool.name)).toEqual([
      "dibs_plan",
    ]);
  });

  it("publishes once for a repeated call and wakes a long-poll", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-mcp-"));
    const store = new MemoryStore({
      participant: "claude",
      provider: "claude",
      lobbyId: 3,
      mode: "dibs",
    });
    await store.connect();
    store.addPeer("codex");
    const client = await clientFor(store, "dibs", dir);
    const plan = {
      goal: "login",
      produces: [{ key: "auth.session", statement: "set a cookie named sid" }],
      requires: [],
    };
    const first = text(
      await client.callTool({ name: "dibs_plan", arguments: plan }),
    ) as { status: string; result: { revision: number } };
    const second = text(
      await client.callTool({ name: "dibs_plan", arguments: plan }),
    ) as { result: { revision: number } };
    expect(first.status).toBe("ok");
    expect(second.result.revision).toBe(first.result.revision);
    const pending = client.callTool({
      name: "dibs_status",
      arguments: { waitSec: 2 },
    });
    const started = Date.now();
    setTimeout(() => store.receiveMessage("codex", "use a cookie"), 80);
    const status = text(await pending) as { messages: { text: string }[] };
    expect(Date.now() - started).toBeLessThan(1500);
    expect(status.messages.map((message) => message.text)).toEqual([
      "use a cookie",
    ]);
    const again = text(
      await client.callTool({ name: "dibs_status", arguments: { waitSec: 0 } }),
    ) as { messages: unknown[] };
    expect(again.messages).toEqual([]);
  });

  it("advertises the plan limits and lists the vocabulary for an unknown key", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-mcp-"));
    const store = new MemoryStore({
      participant: "codex",
      provider: "codex",
      lobbyId: 3,
      mode: "dibs",
    });
    await store.connect();
    const client = await clientFor(store, "dibs", dir);
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "dibs_plan",
    );
    expect(JSON.stringify(tool?.inputSchema)).toContain(
      `"maxLength":${LIMITS.textChars}`,
    );
    const unknown = text(
      await client.callTool({
        name: "dibs_plan",
        arguments: {
          goal: "browser",
          produces: [{ key: "frontend.client", statement: "client.js" }],
        },
      }),
    ) as { error: string; vocabulary: string[] };
    expect(unknown.error).toBe("unknown vocabulary key");
    expect(unknown.vocabulary).toContain("auth.session");
    const long = await client.callTool({
      name: "dibs_plan",
      arguments: {
        goal: "browser",
        requires: [
          { key: "auth.session", assumption: "x".repeat(LIMITS.textChars + 1) },
        ],
      },
    });
    expect(long.isError).toBe(true);
  });

  it("answers initialize before a database is available and then exits", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-stdio-"));
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-stdio-clone-"));
    const dir = path.join(home, "claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "session.json"),
      JSON.stringify({
        participant: "claude",
        provider: "claude",
        lobbyId: 3,
        mode: "dibs",
        clonePath: clone,
        baseSha: "abc",
        startedAtUs: 1,
        fallbackAtUs: 0,
        endsAtUs: 0,
      }),
    );
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (typeof value === "string") env[key] = value;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        bundle,
        "--participant",
        "claude",
        "--provider",
        "claude",
        "--home",
        home,
        "--store",
        "spacetime",
      ],
      env,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const client = new Client({ name: "test", version: "0" });
    const started = Date.now();
    await client.connect(transport);
    expect(Date.now() - started).toBeLessThan(3000);
    expect((await client.listTools()).tools.length).toBe(4);
    const pid = transport.pid;
    await client.close();
    const deadline = Date.now() + 5000;
    while (pid && pidAlive(pid) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pid ? pidAlive(pid) : false).toBe(false);
    expect(stderr).toContain("config.json");
    expect(stderr).not.toMatch(/^\s*\{/);
  });
});

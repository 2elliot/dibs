// Headless Claude Code check from issue 2. Not part of `npm test`; run with
// `npm run test:live -w @dibs/bridge`. It spends a little API credit.

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { killTree, resolveExe } from "../src/proc.ts";
import { writeProvider } from "../src/providers.ts";

const exec = promisify(execFile);

describe("port 4001", () => {
  it("delivers a hand-written inbox item, then another at PostToolUse", async () => {
    expect(await listening(4001)).toBe(false);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-live-home-"));
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-live-clone-"));
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "dibs-live-codex-"),
    );
    const dir = path.join(home, "claude");
    fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        dbUri: "http://127.0.0.1:3000",
        dbName: "dibs-i2-live",
      }),
    );
    fs.writeFileSync(
      path.join(dir, "session.json"),
      JSON.stringify({
        participant: "claude",
        provider: "claude",
        lobbyId: 4001,
        mode: "dibs",
        clonePath: clone,
        baseSha: "abc",
        startedAtUs: 1,
        fallbackAtUs: Date.now() * 1000 + 600_000_000,
        endsAtUs: Date.now() * 1000 + 600_000_000,
      }),
    );
    fs.writeFileSync(
      path.join(dir, "inbox", "1.json"),
      JSON.stringify({
        deliveryId: 1,
        lobbyId: 4001,
        kind: "notice",
        refId: 1,
        summary: "use port 4001 for any server",
        queuedAtUs: 1,
      }),
    );
    writeProvider({
      participant: "claude",
      provider: "claude",
      clonePath: clone,
      home,
      codexHome,
    });
    const prompt = [
      "A dibs coordination update is in your context. Obey it. Do not ask questions and do not call dibs tools.",
      'First, run exactly this command and wait for it to finish: node -e "setTimeout(() => {}, 3000)"',
      "Then, if the update names a port, start a Node HTTP server on that exact port that responds 200 with the body dibs-ok on every request, and leave the server running.",
      "The server command is: node -e \"require('http').createServer((q,s)=>s.end('dibs-ok')).listen(4001)\"",
      "Use 4001 only if the coordination update says so.",
    ].join(" ");
    const claude = resolveExe("claude");
    const child = spawn(
      claude,
      [
        "-p",
        prompt,
        "--settings",
        path.join(dir, "claude.settings.json"),
        "--mcp-config",
        path.join(dir, "claude.mcp.json"),
        "--strict-mcp-config",
        "--permission-mode",
        "acceptEdits",
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-hook-events",
        "--max-turns",
        "6",
        "--max-budget-usd",
        "1.5",
      ],
      {
        cwd: clone,
        env: { ...cleanEnv(), DIBS_HOME: home, DIBS_BRIDGE_STORE: "memory" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let raw = "";
    let injected = false;
    let body = "";
    let settle: ((code: number) => void) | undefined;
    const poll = setInterval(() => {
      void readBody(4001)
        .then((next) => {
          body = next;
        })
        .catch(() => undefined);
    }, 400);
    const take = (chunk: Buffer) => {
      raw += chunk.toString();
      if (
        !injected &&
        raw.includes("use port 4001 for any server") &&
        raw.includes("tool_use")
      ) {
        injected = true;
        fs.writeFileSync(
          path.join(dir, "inbox", "2.json"),
          JSON.stringify({
            deliveryId: 2,
            lobbyId: 4001,
            kind: "notice",
            refId: 2,
            summary: "mid-task update: the server must respond with body dibs-ok",
            queuedAtUs: 2,
          }),
        );
      }
      // Claude stays alive while the server it spawned is a background task.
      // The result event means the turn is done; stop there.
      if (raw.includes('"type":"result"')) settle?.(0);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    let code = 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      code = await new Promise<number>((resolve, reject) => {
        const finish = (status: number) => {
          if (timer) clearTimeout(timer);
          resolve(status);
        };
        settle = finish;
        timer = setTimeout(() => {
          reject(new Error(`claude did not finish\n${raw.slice(-4000)}`));
        }, 90_000);
        child.once("error", (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (status) => finish(status ?? 1));
      });
      if (!body) body = await readBody(4001).catch(() => "");
    } finally {
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      if (child.pid) await killTree(child.pid).catch(() => undefined);
      await releasePort(4001);
    }
    const excerpt = raw
      .split(/\r?\n/)
      .filter(
        (line) =>
          line.includes("hook") ||
          line.includes("4001") ||
          line.includes("mid-task") ||
          line.includes("additionalContext"),
      )
      .slice(-40)
      .join("\n");
    expect(injected, excerpt).toBe(true);
    expect(code, excerpt).toBe(0);
    expect(raw, excerpt).toContain("use port 4001 for any server");
    expect(raw, excerpt).toContain("mid-task update");
    expect(raw, excerpt).toContain("PostToolUse");
    expect(body, excerpt).toContain("dibs-ok");
    expect(await listening(4001)).toBe(false);
  }, 180_000);
});

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (typeof value === "string") env[key] = value;
  return env;
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

function readBody(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/`, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks).toString()));
    });
    request.setTimeout(3000, () => {
      request.destroy();
      reject(new Error(`nothing answered on port ${port}`));
    });
    request.on("error", reject);
  });
}

async function releasePort(port: number): Promise<void> {
  if (!(await listening(port))) return;
  try {
    const { stdout } = await exec("netstat", ["-ano"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const pids = new Set<string>();
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes(`:${port}`) || !line.includes("LISTENING")) continue;
      const pid = line.trim().split(/\s+/).at(-1);
      if (pid && pid !== "0") pids.add(pid);
    }
    for (const pid of pids) {
      await exec("taskkill", ["/T", "/F", "/PID", pid], {
        windowsHide: true,
      }).catch(() => undefined);
    }
  } catch {
    // The port check below reports anything still bound.
  }
}

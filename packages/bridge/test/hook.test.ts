import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DIBS_FILES, LIMITS } from "@dibs/protocol";
import { describe, expect, it } from "vitest";
import {
  claimFile,
  FILES,
  HOOK_CONTEXT_CHARS,
  STOP_BLOCKS_MAX,
  Inbox,
  isInside,
  orderItems,
  pack,
  renameWithRetry,
  runHook,
} from "../hook/dibs-hook.mjs";

const exec = promisify(execFile);

describe("ordinary project lifecycle", () => {
  it.each(["expired", "unavailable"])(
    "does not block Stop for an %s project even with a pending proposal",
    async (state) => {
      const home = temp("dibs-project-hook-");
      const clone = temp("dibs-project-clone-");
      const dir = path.join(home, "claude");
      session(dir, clone, {
        project: true,
        endsAtUs: state === "expired" ? 1 : Date.now() * 1000 + 1_000_000,
      });
      fs.writeFileSync(
        path.join(dir, "bridge.lock"),
        JSON.stringify({ pid: process.pid }),
      );
      fs.writeFileSync(
        path.join(dir, "hook-status.json"),
        JSON.stringify({
          lobbyId: 4,
          online: true,
          pendingKeys: ["project.interface"],
          awaiting: [{ proposalId: 1, revision: 1, key: "project.interface" }],
          project: {
            expiresAtUs: Date.now() * 1000 + 1_000_000,
            unavailable:
              state === "unavailable" ? "Analysis budget exhausted" : undefined,
          },
        }),
      );
      item(dir, 1, { kind: "proposal", refId: 1 });
      expect(
        await runHook({
          argv: ["--provider", "claude", "--home", home],
          input: { hook_event_name: "Stop", cwd: clone },
        }),
      ).toBe("");
    },
  );
});
const hookPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hook/dibs-hook.mjs",
);

function temp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function session(
  dir: string,
  clone: string,
  extra: Record<string, unknown> = {},
): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "session.json"),
    JSON.stringify({
      participant: "claude",
      provider: "claude",
      lobbyId: 4,
      mode: "dibs",
      clonePath: clone,
      baseSha: "abc",
      startedAtUs: 1,
      fallbackAtUs: 0,
      endsAtUs: 0,
      ...extra,
    }),
  );
}

function item(dir: string, id: number, fields: Record<string, unknown>): void {
  const inbox = path.join(dir, "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(
    path.join(inbox, `${id}.json`),
    JSON.stringify({
      deliveryId: id,
      lobbyId: 4,
      kind: "notice",
      refId: id,
      summary: `notice ${id}`,
      queuedAtUs: id,
      ...fields,
    }),
  );
}

function runStdin(
  args: string[],
  input: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", () => resolve({ stdout, stderr }));
    child.stdin.end(input);
  });
}

describe("dibs-hook", () => {
  it("matches the protocol file names and limits", () => {
    for (const key of Object.keys(DIBS_FILES) as (keyof typeof DIBS_FILES)[]) {
      expect(FILES[key]).toBe(DIBS_FILES[key]);
    }
    expect(HOOK_CONTEXT_CHARS).toBe(LIMITS.hookContextChars);
    expect(STOP_BLOCKS_MAX).toBe(LIMITS.stopBlocksMax);
  });

  it("treats Windows path case and sibling folders correctly", () => {
    const clone = temp("dibs-clone-");
    const child = path.join(clone, "src");
    fs.mkdirSync(child);
    const flipped = child.replace(/^[A-Za-z]:/, (drive) =>
      drive.toLowerCase() === drive ? drive.toUpperCase() : drive.toLowerCase(),
    );
    expect(isInside(flipped, clone)).toBe(true);
    expect(isInside(clone, clone)).toBe(true);
    expect(isInside(`${clone}-extra`, clone)).toBe(false);
  });

  it("stays silent outside the clone and does not claim", async () => {
    const home = temp("dibs-home-");
    const clone = temp("dibs-clone-");
    const dir = path.join(home, "claude");
    session(dir, clone);
    item(dir, 1, { summary: "use port 4001 for any server" });
    const printed = await runHook({
      argv: ["--participant", "claude", "--provider", "claude", "--home", home],
      input: { hook_event_name: "UserPromptSubmit", cwd: temp("dibs-other-") },
    });
    expect(printed).toBe("");
    expect(fs.existsSync(path.join(dir, "inbox", "1.json"))).toBe(true);
  });

  it("prints a claimed update and moves it to shown", async () => {
    const home = temp("dibs-home-");
    const clone = temp("dibs-clone-");
    const dir = path.join(home, "claude");
    session(dir, clone);
    fs.writeFileSync(path.join(home, "config.json"), "{}");
    fs.writeFileSync(
      path.join(dir, "bridge.lock"),
      JSON.stringify({
        pid: process.pid,
        participant: "claude",
        startedAtUs: 1,
      }),
    );
    item(dir, 1, { summary: "use port 4001 for any server" });
    const printed = await runHook({
      argv: ["--participant", "claude", "--provider", "claude", "--home", home],
      input: {
        hook_event_name: "UserPromptSubmit",
        cwd: clone,
        session_id: "s1",
      },
    });
    const parsed = JSON.parse(printed) as {
      hookSpecificOutput: { additionalContext: string };
      systemMessage: string;
    };
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "use port 4001 for any server",
    );
    expect(parsed.systemMessage.startsWith("dibs:")).toBe(true);
    expect(fs.existsSync(path.join(dir, "shown", "1.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "inbox", "1.json"))).toBe(false);
  });

  it("omits systemMessage for Droid and writes hook-alive on SessionStart", async () => {
    const home = temp("dibs-home-");
    const clone = temp("dibs-clone-");
    const dir = path.join(home, "droid");
    session(dir, clone, { participant: "droid", provider: "droid" });
    item(dir, 3, { summary: "a fact" });
    const printed = await runHook({
      argv: ["--participant", "droid", "--provider", "droid", "--home", home],
      input: {
        hook_event_name: "SessionStart",
        cwd: clone,
        session_id: "sess",
      },
    });
    const parsed = JSON.parse(printed) as { systemMessage?: string };
    expect(parsed.systemMessage).toBeUndefined();
    const alive = JSON.parse(
      fs.readFileSync(path.join(dir, "hook-alive.json"), "utf8"),
    ) as { lobbyId: number; sessionId: string };
    expect(alive).toMatchObject({
      lobbyId: 4,
      sessionId: "sess",
      provider: "droid",
    });
  });

  it("says the coordination service is offline once, and never on SessionStart or Stop", async () => {
    const home = temp("dibs-home-");
    const clone = temp("dibs-clone-");
    const dir = path.join(home, "claude");
    session(dir, clone);
    const argv = [
      "--participant",
      "claude",
      "--provider",
      "claude",
      "--home",
      home,
    ];
    const start = await runHook({
      argv,
      input: { hook_event_name: "SessionStart", cwd: clone, session_id: "s" },
    });
    expect(start).toBe("");
    const first = await runHook({
      argv,
      input: { hook_event_name: "UserPromptSubmit", cwd: clone },
    });
    expect(JSON.parse(first).hookSpecificOutput.additionalContext).toContain(
      "dibs coordination is offline",
    );
    const second = await runHook({
      argv,
      input: { hook_event_name: "PostToolUse", cwd: clone },
    });
    expect(second).toBe("");
    const stop = await runHook({
      argv,
      input: { hook_event_name: "Stop", cwd: clone },
    });
    expect(stop).toBe("");
  });

  it("blocks on a fresh proposal once, then on pending keys until the cap", async () => {
    const home = temp("dibs-home-");
    const clone = temp("dibs-clone-");
    const dir = path.join(home, "claude");
    const later = Date.now() * 1000 + 120_000_000;
    session(dir, clone, { fallbackAtUs: later });
    fs.writeFileSync(
      path.join(dir, "bridge.lock"),
      JSON.stringify({
        pid: process.pid,
        participant: "claude",
        startedAtUs: 1,
      }),
    );
    fs.writeFileSync(
      path.join(dir, "hook-status.json"),
      JSON.stringify({
        lobbyId: 4,
        online: true,
        phase: "ready",
        pendingKeys: [],
        awaiting: [{ proposalId: 7, revision: 1, key: "auth.session" }],
        fallbackAtUs: later,
      }),
    );
    const argv = [
      "--participant",
      "claude",
      "--provider",
      "claude",
      "--home",
      home,
    ];
    const first = JSON.parse(
      await runHook({ argv, input: { hook_event_name: "Stop", cwd: clone } }),
    ) as { decision: string; reason: string };
    expect(first.decision).toBe("block");
    expect(first.reason).toContain("P7");
    expect(
      await runHook({ argv, input: { hook_event_name: "Stop", cwd: clone } }),
    ).toBe("");

    fs.writeFileSync(
      path.join(dir, "hook-status.json"),
      JSON.stringify({
        lobbyId: 4,
        online: true,
        phase: "analyzing",
        pendingKeys: ["auth.session"],
        awaiting: [],
        fallbackAtUs: later,
      }),
    );
    fs.writeFileSync(
      path.join(dir, "stopblocks.json"),
      JSON.stringify({ lobbyId: 4, count: 1, proposalIds: [7] }),
    );
    for (let n = 0; n < 7; n++) {
      const blocked = await runHook({
        argv,
        input: { hook_event_name: "Stop", cwd: clone },
        now: Date.now() * 1000,
      });
      expect(JSON.parse(blocked).reason).toContain("auth.session");
    }
    expect(
      await runHook({ argv, input: { hook_event_name: "Stop", cwd: clone } }),
    ).toBe("");
  });

  it("puts proposals first and keeps later items for the next checkpoint", () => {
    const proposal = {
      name: "2.json",
      item: {
        deliveryId: 2,
        lobbyId: 4,
        kind: "proposal",
        refId: 2,
        summary: "proposal text",
        queuedAtUs: 2,
      },
    };
    const notice = {
      name: "1.json",
      item: {
        deliveryId: 1,
        lobbyId: 4,
        kind: "notice",
        refId: 1,
        summary: "n".repeat(2000),
        queuedAtUs: 1,
      },
    };
    const packed = pack(orderItems([notice, proposal]), 1500, []);
    expect(packed.text.startsWith("proposal text")).toBe(true);
    expect(packed.text.length).toBeLessThanOrEqual(1500);
    expect(packed.printed.map((entry) => entry.item.deliveryId)).toEqual([2]);
    expect(packed.kept.map((entry) => entry.item.deliveryId)).toEqual([1]);
  });

  it("lets exactly one of two racing hooks claim each file", async () => {
    const dir = temp("dibs-race-");
    const inbox = new Inbox(dir);
    inbox.ensureDirs();
    for (let id = 1; id <= 8; id++) {
      fs.writeFileSync(
        path.join(dir, "inbox", `${id}.json`),
        JSON.stringify({
          deliveryId: id,
          lobbyId: 4,
          kind: "notice",
          refId: id,
          summary: `n${id}`,
          queuedAtUs: id,
        }),
      );
    }
    const racer = path.join(dir, "racer.mjs");
    fs.writeFileSync(
      racer,
      `import { Inbox } from ${JSON.stringify(pathToFileURL(hookPath).href)};
const inbox = new Inbox(process.argv[2]);
process.stdout.write(JSON.stringify(inbox.claimAll(4).map((entry) => entry.item.deliveryId)));
`,
    );
    const [left, right] = await Promise.all([
      exec(process.execPath, [racer, dir], { encoding: "utf8" }),
      exec(process.execPath, [racer, dir], { encoding: "utf8" }),
    ]);
    const ids = [...JSON.parse(left.stdout), ...JSON.parse(right.stdout)].sort(
      (a: number, b: number) => a - b,
    );
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("skips a file another hook is still claiming, without replacing its copy", () => {
    const dir = temp("dibs-claimed-");
    const inbox = new Inbox(dir);
    inbox.ensureDirs();
    const item = {
      deliveryId: 1,
      lobbyId: 4,
      kind: "notice",
      refId: 1,
      summary: "n1",
      queuedAtUs: 1,
    };
    fs.writeFileSync(path.join(dir, "inbox", "1.json"), JSON.stringify(item));
    // The other hook has linked the file into claimed/ but not yet removed it from inbox/.
    fs.writeFileSync(path.join(dir, "claimed", "1.json"), "theirs");
    expect(inbox.claimAll(4)).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "claimed", "1.json"), "utf8")).toBe(
      "theirs",
    );
    expect(fs.existsSync(path.join(dir, "inbox", "1.json"))).toBe(true);
  });

  it("undoes a claim when the inbox copy can't be removed", () => {
    const dir = temp("dibs-unlink-");
    const from = path.join(dir, "a");
    const to = path.join(dir, "b");
    fs.writeFileSync(from, "x");
    const original = fs.unlinkSync;
    fs.unlinkSync = ((file: fs.PathLike) => {
      if (file === from) {
        const error = new Error("locked") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      return original(file);
    }) as typeof fs.unlinkSync;
    try {
      expect(claimFile(from, to)).toBe(false);
    } finally {
      fs.unlinkSync = original;
    }
    expect(fs.existsSync(from)).toBe(true);
    expect(fs.existsSync(to)).toBe(false);
  });

  it("retries a rename that fails with EPERM", () => {
    const dir = temp("dibs-rename-");
    const from = path.join(dir, "a");
    const to = path.join(dir, "b");
    fs.writeFileSync(from, "x");
    const original = fs.renameSync;
    let attempts = 0;
    fs.renameSync = ((source: fs.PathLike, dest: fs.PathLike) => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("busy") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return original(source, dest);
    }) as typeof fs.renameSync;
    try {
      expect(renameWithRetry(from, to)).toBe(true);
      expect(attempts).toBeGreaterThanOrEqual(3);
    } finally {
      fs.renameSync = original;
    }
  });

  it("speaks the CLI protocol on stdin", async () => {
    const home = temp("dibs-home-");
    const clone = temp("dibs-clone-");
    const dir = path.join(home, "claude");
    session(dir, clone);
    item(dir, 9, { summary: "use port 4001 for any server" });
    const { stdout, stderr } = await runStdin(
      [
        hookPath,
        "--participant",
        "claude",
        "--provider",
        "claude",
        "--home",
        home,
      ],
      JSON.stringify({
        hook_event_name: "PostToolUse",
        cwd: clone,
        session_id: "cli",
      }),
    );
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "use port 4001 for any server",
    );
  });
});

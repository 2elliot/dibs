// MCP tools. Registered for the lobby mode only. dibs_status long-polls; reducer calls
// carry a stable requestId so a pending result can be retried.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  LIMITS,
  TOOL_NAMES,
  TOOLS_BY_MODE,
  type Mode,
  type PlanInput,
  type StatusResult,
} from "@dibs/protocol";
import { z } from "zod";
import { canonical, type CallResult } from "./calls.ts";
import type { RespondInput } from "./memory.ts";
import type { AgentStore } from "./store.ts";
import { computeStatus, statusFingerprint } from "./world.ts";

// The reducer's limits, advertised in the schema so a model sees them before its first call
// (on Windows, Codex sent an invented key and then an over-long assumption before a plan
// got through).
const KEY = z
  .string()
  .describe("A key from the lobby vocabulary, such as auth.session.");
const ITEM_TEXT = z.string().min(1).max(LIMITS.textChars);
const PLAN = z.object({
  goal: z.string().min(1).max(LIMITS.goalChars),
  produces: z
    .array(z.object({ key: KEY, statement: ITEM_TEXT }))
    .max(LIMITS.planItems)
    .default([]),
  requires: z
    .array(z.object({ key: KEY, assumption: ITEM_TEXT }))
    .max(LIMITS.planItems)
    .default([]),
  notes: z.string().max(LIMITS.notesChars).optional(),
});

const STATUS = z.object({
  waitSec: z.number().int().min(0).max(LIMITS.statusWaitSecMax).optional(),
});

const RESPOND = z.object({
  proposalId: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  decision: z.enum(["accept", "reject"]),
  reason: z.string(),
});

const MESSAGE = z.object({
  to: z.enum(["claude", "codex", "droid", "all"]),
  text: z.string(),
});

const PLAN_TEXT = `Publish your plan for this lobby: what you will build and what you are assuming the other agents provide. For each key, state concrete details: routes, request/response JSON, header or cookie names, status codes, exported function names, signatures and file. Use only keys from the lobby vocabulary; at most ${LIMITS.planItems} items in total, each at most ${LIMITS.textChars} characters. In none and chat modes the plan is logged and is not turned into a proposal.`;

const STATUS_TEXT =
  "Read the lobby. Returns phase (waiting_for_peers, analyzing, ready), each of your keys' status, proposals awaiting you, unread messages, fallbackInSec and the roster. waitSec (0 to 45) long-polls and returns early when any of those change. fallbackInSec counts down to the lobby's shared fallback time. Pass waitSec 0 to read once.";

const RESPOND_TEXT =
  "Accept or reject an open proposal. reason is required when you reject. Use the proposalId and revision from dibs_status.";

const MESSAGE_TEXT =
  "Message another agent (claude, codex or droid) or all. At most 1000 characters. Replies arrive in your context and in dibs_status.";

export function createBridge(
  store: AgentStore,
  options: { mode: Mode; dir: string; nowUs?: () => number },
): McpServer {
  const nowUs = options.nowUs ?? (() => Date.now() * 1000);
  const ids = new Map<string, string>();
  const server = new McpServer(
    { name: "dibs", version: "0.0.0" },
    {
      instructions:
        "dibs coordinates the agents in this lobby. Publish assumptions with dibs_plan. Read phase, key status, proposals and fallbackInSec with dibs_status. Accept or reject with dibs_respond. Message teammates with dibs_message.",
    },
  );
  const allowed = new Set(TOOLS_BY_MODE[options.mode]);
  const idFor = (payload: unknown) => {
    const body = canonical(payload);
    const existing = ids.get(body);
    if (existing) return existing;
    const created = randomUUID();
    ids.set(body, created);
    return created;
  };

  if (allowed.has(TOOL_NAMES.plan)) {
    server.registerTool(
      TOOL_NAMES.plan,
      {
        description: PLAN_TEXT,
        inputSchema: PLAN,
        annotations: { destructiveHint: false },
      },
      async (args) => {
        const input: PlanInput = {
          goal: args.goal,
          produces: args.produces,
          requires: args.requires,
          notes: args.notes,
        };
        const requestId = idFor({ tool: TOOL_NAMES.plan, ...input });
        const result = await call(() => store.publishPlan(input, requestId));
        if (
          result.status === "error" &&
          result.error === "unknown vocabulary key"
        )
          return json({
            ...result,
            vocabulary: store.world().lobby?.vocabulary ?? [],
          });
        return json(result);
      },
    );
  }

  if (allowed.has(TOOL_NAMES.status)) {
    server.registerTool(
      TOOL_NAMES.status,
      {
        description: STATUS_TEXT,
        inputSchema: STATUS,
        annotations: { destructiveHint: false, readOnlyHint: true },
      },
      async (args) =>
        json(await watchStatus(store, options.dir, args.waitSec ?? 0, nowUs)),
    );
  }

  if (allowed.has(TOOL_NAMES.respond)) {
    server.registerTool(
      TOOL_NAMES.respond,
      {
        description: RESPOND_TEXT,
        inputSchema: RESPOND,
        annotations: { destructiveHint: false },
      },
      async (args) => {
        const input: RespondInput = args;
        const requestId = idFor({ tool: TOOL_NAMES.respond, ...input });
        return json(await call(() => store.respond(input, requestId)));
      },
    );
  }

  if (allowed.has(TOOL_NAMES.message)) {
    server.registerTool(
      TOOL_NAMES.message,
      {
        description: MESSAGE_TEXT,
        inputSchema: MESSAGE,
        annotations: { destructiveHint: false },
      },
      async (args) => {
        const requestId = idFor({
          tool: TOOL_NAMES.message,
          to: args.to,
          text: args.text,
        });
        return json(
          await call(() => store.sendMessage(args.to, args.text, requestId)),
        );
      },
    );
  }

  return server;
}

async function call(run: () => Promise<CallResult>): Promise<CallResult> {
  try {
    return await run();
  } catch (error) {
    return {
      status: "error",
      requestId: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function watchStatus(
  store: AgentStore,
  dir: string,
  waitSec: number,
  nowUs: () => number,
): Promise<StatusResult> {
  const lobbyId = () => store.world().lobby?.id ?? 0;
  const read = () =>
    computeStatus(store.world(), readSeen(dir, lobbyId()), nowUs());
  const wait = Math.min(LIMITS.statusWaitSecMax, Math.max(0, waitSec));
  let snap = read();
  if (wait > 0 && snap.awaitingYou.length === 0 && snap.messages.length === 0) {
    const base = statusFingerprint(snap);
    const deadline = Date.now() + wait * 1000;
    await new Promise<void>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearInterval(timer);
        off();
        resolve();
      };
      const off = store.changes(() => {
        if (statusFingerprint(read()) !== base) finish();
      });
      timer = setInterval(() => {
        if (Date.now() >= deadline || statusFingerprint(read()) !== base)
          finish();
      }, 50);
      if (statusFingerprint(read()) !== base || Date.now() >= deadline)
        finish();
    });
    snap = read();
  }
  writeSeen(dir, lobbyId(), [
    ...readSeen(dir, lobbyId()),
    ...messageIds(store, snap),
  ]);
  return snap;
}

function messageIds(store: AgentStore, snap: StatusResult): number[] {
  const wanted = new Set(
    snap.messages.map(
      (message) => `${message.from}\0${message.atUs}\0${message.text}`,
    ),
  );
  return store
    .world()
    .messages.filter((message) => {
      const from =
        store
          .world()
          .participants.find((participant) => participant.id === message.fromId)
          ?.name ?? String(message.fromId);
      return wanted.has(`${from}\0${message.createdAtUs}\0${message.text}`);
    })
    .map((message) => message.id);
}

function seenPath(dir: string): string {
  return path.join(dir, "seen-messages.json");
}

function readSeen(dir: string, lobbyId: number): number[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(seenPath(dir), "utf8")) as {
      lobbyId?: number;
      ids?: number[];
    };
    if (parsed.lobbyId !== lobbyId || !Array.isArray(parsed.ids)) return [];
    return parsed.ids.filter((id) => typeof id === "number");
  } catch {
    return [];
  }
}

function writeSeen(dir: string, lobbyId: number, ids: number[]): void {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const unique = [...new Set(ids)];
  fs.writeFileSync(seenPath(dir), JSON.stringify({ lobbyId, ids: unique }));
}

function json(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

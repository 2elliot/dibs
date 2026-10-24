// The dibs MCP server: the tools an agent calls to publish intents and negotiate contracts.
// Each tool is a thin wrapper over @dibs/core.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as core from "@dibs/core";
import { z } from "zod";

const server = new McpServer({ name: "dibs", version: "0.0.0" });

// TODO(plugin lane): decide how a tool call learns its agent_id. One option: the
// SessionStart hook registers the agent and tells Claude its id in additionalContext.
const agentId = z.string().describe("Your dibs agent id, from the dibs session context");

function reply(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text }], isError: true };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return reply(await fn());
  } catch (error) {
    return fail(error);
  }
}

server.registerTool(
  "publish_intent",
  {
    description:
      "Call dibs on what you're about to build, before editing any file. Returns an overlap if another agent already claimed the same feature.",
    inputSchema: {
      agent_id: agentId,
      title: z.string().describe("Short name for the feature, e.g. 'rate limiter'"),
      description: z.string().describe("What you plan to build and why"),
      interfaces: z.array(z.string()).describe("Interfaces or functions you expect to create"),
      files: z.array(z.string()).describe("Files you expect to create or own"),
    },
  },
  (input) => run(() => core.publishIntent(input)),
);

server.registerTool(
  "request_feature",
  {
    description:
      "Another agent owns a feature you need. Send it your requirements instead of building it yourself.",
    inputSchema: {
      agent_id: agentId,
      owner_intent_id: z.string().describe("The overlapping intent dibs reported"),
      requirements: z.array(z.string()).describe("What you need it to do, one per item"),
    },
  },
  (input) => run(() => core.requestFeature(input)),
);

server.registerTool(
  "propose_contract",
  {
    description: "Propose or accept the typed interface for a contract between two agents.",
    inputSchema: {
      agent_id: agentId,
      contract_id: z.string(),
      interface: z.string().describe("TypeScript source of the interface"),
    },
  },
  (input) => run(() => core.proposeContract(input)),
);

server.registerTool(
  "mark_delivered",
  {
    description: "You finished a feature another agent is waiting on. Pings them.",
    inputSchema: { agent_id: agentId, contract_id: z.string() },
  },
  (input) => run(() => core.markDelivered(input)),
);

server.registerTool(
  "get_inbox",
  {
    description: "Read unread messages from other agents and from dibs.",
    inputSchema: { agent_id: agentId },
  },
  ({ agent_id }) => run(() => core.getInbox(agent_id)),
);

await server.connect(new StdioServerTransport());

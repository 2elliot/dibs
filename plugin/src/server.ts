// The dibs MCP server: the tools an agent calls to publish intents and negotiate contracts.
// Each tool is a thin wrapper over @dibs/core.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as core from "@dibs/core";
import { z } from "zod";

// stdout carries MCP's JSON-RPC, and the SpacetimeDB SDK logs with console.log.
console.log = console.error;

const server = new McpServer({ name: "dibs", version: "0.0.0" });

// SpacetimeDB ids are u64, which JSON can't carry, so tools take them as digit strings.
// The SessionStart hook registers the agent and tells Claude its agent_id.
const idString = z.string().regex(/^\d+$/, 'ids are digit strings, like "42"');
const agentId = idString.describe("Your dibs agent id, from the dibs session context");

function reply(value: unknown) {
  const text = JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  return { content: [{ type: "text" as const, text }] };
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
      title: z.string().describe("Short name for the feature, e.g. 'reply storage'"),
      description: z.string().describe("What you plan to build and why"),
      interfaces: z.array(z.string()).describe("Interfaces or functions you expect to create"),
      files: z.array(z.string()).describe("Files you expect to create or own"),
    },
  },
  ({ agent_id, ...rest }) => run(() => core.publishIntent({ agentId: BigInt(agent_id), ...rest })),
);

server.registerTool(
  "request_feature",
  {
    description:
      "Another agent owns a feature you need. Send it your requirements instead of building it yourself.",
    inputSchema: {
      agent_id: agentId,
      owner_intent_id: idString.describe("The overlapping intent dibs reported"),
      requirements: z.array(z.string()).describe("What you need it to do, one per item"),
    },
  },
  ({ agent_id, owner_intent_id, requirements }) =>
    run(() =>
      core.requestFeature({
        agentId: BigInt(agent_id),
        ownerIntentId: BigInt(owner_intent_id),
        requirements,
      }),
    ),
);

server.registerTool(
  "propose_contract",
  {
    description: "Propose or accept the typed interface for a contract between two agents.",
    inputSchema: {
      agent_id: agentId,
      contract_id: idString,
      interface: z.string().describe("TypeScript source of the interface"),
    },
  },
  ({ agent_id, contract_id, interface: source }) =>
    run(() =>
      core.proposeContract({
        agentId: BigInt(agent_id),
        contractId: BigInt(contract_id),
        interface: source,
      }),
    ),
);

server.registerTool(
  "mark_delivered",
  {
    description: "You finished a feature another agent is waiting on. Pings them.",
    inputSchema: { agent_id: agentId, contract_id: idString },
  },
  ({ agent_id, contract_id }) =>
    run(() => core.markDelivered({ agentId: BigInt(agent_id), contractId: BigInt(contract_id) })),
);

server.registerTool(
  "get_inbox",
  {
    description: "Read unread messages from other agents and from dibs.",
    inputSchema: { agent_id: agentId },
  },
  ({ agent_id }) => run(() => core.getInbox(BigInt(agent_id))),
);

await server.connect(new StdioServerTransport());

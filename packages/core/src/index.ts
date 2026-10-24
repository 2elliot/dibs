// Public API of the core lane. The plugin's MCP tools and hooks call these; the input and
// output types come from @dibs/shared, so the signatures here are part of the contract.

import type {
  Agent,
  InboxResult,
  MarkDeliveredInput,
  ProposeContractInput,
  PublishIntentInput,
  PublishIntentResult,
  RequestFeatureInput,
  Contract,
} from "@dibs/shared";

export { loadConfig, CONFIG_FILE, type DibsConfig } from "./config";
export { db } from "./db";

function notImplemented(name: string): never {
  throw new Error(`@dibs/core: ${name} isn't implemented yet`);
}

/** Register (or refresh) the agent for a Claude Code session. Called from SessionStart. */
export async function registerAgent(sessionId: string, repo: string | null): Promise<Agent> {
  return notImplemented("registerAgent");
}

/** Store the intent, embed it, find similar live intents, and have Claude judge the closest. */
export async function publishIntent(input: PublishIntentInput): Promise<PublishIntentResult> {
  return notImplemented("publishIntent");
}

/** The consumer tells the owner what it needs. Opens a proposed contract. */
export async function requestFeature(input: RequestFeatureInput): Promise<Contract> {
  return notImplemented("requestFeature");
}

/** Owner and consumer settle the typed interface. Generates the stub and acceptance tests. */
export async function proposeContract(input: ProposeContractInput): Promise<Contract> {
  return notImplemented("proposeContract");
}

/** The owner finished. Pings the consumer so it can swap out the stub. */
export async function markDelivered(input: MarkDeliveredInput): Promise<Contract> {
  return notImplemented("markDelivered");
}

/** Unread messages for an agent. Marks them read. */
export async function getInbox(agentId: string): Promise<InboxResult> {
  return notImplemented("getInbox");
}

/** Which agent owns a file through an active intent, if any. Used by the PreToolUse hook. */
export async function fileOwner(path: string): Promise<Agent | null> {
  return notImplemented("fileOwner");
}

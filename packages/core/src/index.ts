// Public API of the core lane. The plugin's MCP tools and each agent's hook adapter call
// these; the input and output types come from @dibs/shared, so the signatures here are part
// of the contract.
//
// State changes go through the SpacetimeDB reducers in spacetime/src/index.ts. Anything
// that calls the outside world (embeddings, the Claude judge) happens here first.

import type {
  Contract,
  InboxResult,
  MarkDeliveredInput,
  ProposeContractInput,
  PublishIntentInput,
  PublishIntentResult,
  RequestFeatureInput,
} from "@dibs/shared";
import { db } from "./db";
import { takeUnread } from "./hooks";

export { loadConfig, CONFIG_FILE, type DibsConfig } from "./config";
export { db } from "./db";
export { cosine, nearestIntents } from "./similarity";
export { startSession, checkEdit, pendingContext, normalizePath } from "./hooks";

function notImplemented(name: string): never {
  throw new Error(`@dibs/core: ${name} isn't implemented yet`);
}

/** Embed the intent, publish it, find similar live intents, and have Claude judge the closest. */
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
export async function getInbox(agentId: bigint): Promise<InboxResult> {
  return { messages: await takeUnread(await db(), agentId) };
}

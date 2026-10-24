// The contract between lanes. plugin/, packages/core and dashboard/ all build against this
// package, so changing it is a contract change: follow "Changing the contract" in
// docs/workflow.md (small PR, heads-up to the team, everyone's typecheck stays green).
//
// Tables, row types, reducers and the connection come from module_bindings/, generated from
// spacetime/src/index.ts by `npm run generate`. Never edit those files by hand.

import type { Agent, Intent, Message } from "./module_bindings/types";

export * from "./module_bindings";
export * from "./module_bindings/types";

// Values the module stores as plain strings. Keep in sync with spacetime/src/index.ts.
export type AgentStatus = "active" | "idle" | "gone";
export type IntentStatus = "active" | "blocked" | "delivered" | "abandoned";
export type OverlapVerdict = "duplicate" | "partial" | "independent";
export type ContractStatus = "proposed" | "agreed" | "delivered" | "verified";
export type MessageKind = "overlap" | "request" | "proposal" | "accept" | "delivered" | "info";

// Operations: packages/core implements them, the plugin's MCP tools call them.

export interface PublishIntentInput {
  agentId: bigint;
  title: string;
  description: string;
  /** Names or signatures of the interfaces it expects to create. */
  interfaces: string[];
  /** Files it expects to own. */
  files: string[];
}

export interface Overlap {
  /** The earlier intent this one collides with. Its agent owns the feature. */
  intent: Intent;
  owner: Agent;
  similarity: number;
  verdict: OverlapVerdict;
  reason: string;
}

export interface PublishIntentResult {
  intent: Intent;
  overlap: Overlap | null;
}

export interface RequestFeatureInput {
  agentId: bigint;
  ownerIntentId: bigint;
  requirements: string[];
}

export interface ProposeContractInput {
  agentId: bigint;
  contractId: bigint;
  interface: string;
}

export interface MarkDeliveredInput {
  agentId: bigint;
  contractId: bigint;
}

export interface InboxResult {
  messages: Message[];
}

// The contract between lanes. plugin/, packages/core and dashboard/ all build against
// these types, so changing one is a contract change: follow "Changing the contract" in
// docs/workflow.md (small PR, heads-up to the team, everyone's typecheck stays green).
//
// Row types mirror supabase/migrations. Change both in the same PR.

export type AgentStatus = "active" | "idle" | "gone";
export type IntentStatus = "active" | "blocked" | "delivered" | "abandoned";
export type OverlapVerdict = "duplicate" | "partial" | "independent";
export type ContractStatus = "proposed" | "agreed" | "delivered" | "verified";
export type MessageKind = "overlap" | "request" | "proposal" | "accept" | "delivered" | "info";

export const TABLES = {
  agents: "agents",
  intents: "intents",
  contracts: "contracts",
  messages: "messages",
} as const;

/** One Claude Code session on one teammate's laptop. */
export interface Agent {
  id: string;
  session_id: string;
  name: string;
  repo: string | null;
  status: AgentStatus;
  created_at: string;
  last_seen_at: string;
}

/** What an agent says it's about to build, published before it edits anything. */
export interface Intent {
  id: string;
  agent_id: string;
  title: string;
  description: string;
  /** Names or signatures of the interfaces it expects to create. */
  interfaces: string[];
  /** Files it expects to own. */
  files: string[];
  status: IntentStatus;
  /** Set when dibs found an earlier intent that this one overlaps. */
  overlaps_intent_id: string | null;
  verdict: OverlapVerdict | null;
  created_at: string;
}

/** The typed interface an owner agrees to build for a consumer. */
export interface Contract {
  id: string;
  owner_intent_id: string;
  consumer_intent_id: string;
  /** TypeScript source of the agreed interface. */
  interface: string;
  /** The consumer's requirements. These become the acceptance tests. */
  requirements: string[];
  stub_path: string | null;
  test_path: string | null;
  status: ContractStatus;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  /** null means the message came from dibs itself, not another agent. */
  from_agent_id: string | null;
  to_agent_id: string;
  contract_id: string | null;
  kind: MessageKind;
  body: string;
  read_at: string | null;
  created_at: string;
}

// Operations: packages/core implements them, the plugin's MCP tools call them.

export interface PublishIntentInput {
  agent_id: string;
  title: string;
  description: string;
  interfaces: string[];
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
  agent_id: string;
  owner_intent_id: string;
  requirements: string[];
}

export interface ProposeContractInput {
  agent_id: string;
  contract_id: string;
  interface: string;
}

export interface MarkDeliveredInput {
  agent_id: string;
  contract_id: string;
}

export interface InboxResult {
  messages: Message[];
}

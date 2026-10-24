// The store the MCP server and the inbox writer share. A switching store lets the
// process answer `initialize` on an offline cache, then swap in the database.

import type { PlanInput, Provider } from "@dibs/protocol";
import type { CallResult } from "./calls.ts";
import type { RespondInput } from "./memory.ts";
import { emptyWorld, type MessageRow, type World } from "./world.ts";

export interface AgentStore {
  world(): World;
  changes(cb: () => void): () => void;
  publishPlan(input: PlanInput, requestId: string): Promise<CallResult>;
  respond(input: RespondInput, requestId: string): Promise<CallResult>;
  sendMessage(
    to: MessageRow["to"],
    text: string,
    requestId: string,
  ): Promise<CallResult>;
  markDelivery(id: number, stage: "received" | "shown"): Promise<CallResult>;
  reportHead(
    lobbyId: number,
    sha: string,
    outOfAreaFiles: string[],
  ): Promise<CallResult>;
  close(): void;
}

export class OfflineStore implements AgentStore {
  private readonly snapshot: World;
  private listeners = new Set<() => void>();

  constructor(participant: string, provider: Provider) {
    this.snapshot = emptyWorld(participant, provider);
  }

  world(): World {
    return this.snapshot;
  }

  changes(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  close(): void {
    this.listeners.clear();
  }

  async publishPlan(_input: PlanInput, requestId: string): Promise<CallResult> {
    return { status: "offline", requestId };
  }

  async respond(_input: RespondInput, requestId: string): Promise<CallResult> {
    return { status: "offline", requestId };
  }

  async sendMessage(
    _to: MessageRow["to"],
    _text: string,
    requestId: string,
  ): Promise<CallResult> {
    return { status: "offline", requestId };
  }

  async markDelivery(
    id: number,
    stage: "received" | "shown",
  ): Promise<CallResult> {
    return { status: "offline", requestId: `delivery:${id}:${stage}` };
  }

  async reportHead(_lobbyId: number, sha: string): Promise<CallResult> {
    return { status: "offline", requestId: `head:${sha}` };
  }
}

/** Forwards to the current store and keeps inbox listeners across a reconnect. */
export class SwitchingStore implements AgentStore {
  private inner: AgentStore;
  private offInner: () => void = () => {};
  private listeners = new Set<() => void>();

  constructor(inner: AgentStore) {
    this.inner = inner;
    this.bind();
  }

  use(next: AgentStore): void {
    if (next === this.inner) return;
    this.offInner();
    this.inner.close();
    this.inner = next;
    this.bind();
    this.emit();
  }

  world(): World {
    return this.inner.world();
  }

  changes(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  close(): void {
    this.offInner();
    this.listeners.clear();
    this.inner.close();
  }

  publishPlan(input: PlanInput, requestId: string): Promise<CallResult> {
    return this.inner.publishPlan(input, requestId);
  }

  respond(input: RespondInput, requestId: string): Promise<CallResult> {
    return this.inner.respond(input, requestId);
  }

  sendMessage(
    to: MessageRow["to"],
    text: string,
    requestId: string,
  ): Promise<CallResult> {
    return this.inner.sendMessage(to, text, requestId);
  }

  markDelivery(id: number, stage: "received" | "shown"): Promise<CallResult> {
    return this.inner.markDelivery(id, stage);
  }

  reportHead(
    lobbyId: number,
    sha: string,
    outOfAreaFiles: string[],
  ): Promise<CallResult> {
    return this.inner.reportHead(lobbyId, sha, outOfAreaFiles);
  }

  private bind(): void {
    this.offInner = this.inner.changes(() => this.emit());
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

// In-memory lobby. Enough of the agent reducers to exercise the tools without a database.
// The module remains the authority once issue 1 publishes [module-ready].

import {
  LIMITS,
  type Decision,
  type DeliveryKind,
  type LobbyState,
  type Mode,
  type PlanInput,
  type Provider,
  type Relation,
} from "@dibs/protocol";
import { callError, canonical, type CallResult } from "./calls.ts";
import type { AgentStore } from "./store.ts";
import {
  emptyWorld,
  type ContractRow,
  type DeliveryRow,
  type ItemRow,
  type JobRow,
  type MessageRow,
  type ParticipantRow,
  type PlanRow,
  type ProposalRow,
  type ResponseRow,
  type World,
} from "./world.ts";

export interface RespondInput {
  proposalId: number;
  revision: number;
  decision: Decision;
  reason: string;
}

export interface MemoryInit {
  participant: string;
  provider: Provider;
  lobbyId: number;
  mode: Mode;
  vocabulary?: string[];
  fallbackAtUs?: number;
  endsAtUs?: number;
  startedAtUs?: number;
  baseSha?: string;
  buildHash?: string;
  state?: LobbyState;
  nowUs?: () => number;
}

interface Saved {
  payload: string;
  result: CallResult;
}

export class MemoryStore implements AgentStore {
  private state: World;
  private seq = 1;
  private saved = new Map<string, Saved>();
  private listeners = new Set<() => void>();
  private readonly nowUs: () => number;
  failNext: "timeout" | "disconnect" | null = null;

  constructor(init: MemoryInit) {
    this.nowUs = init.nowUs ?? (() => Date.now() * 1000);
    this.state = emptyWorld(init.participant, init.provider);
    this.state.offlineSinceUs = this.nowUs();
    this.state.lobby = {
      id: init.lobbyId,
      mode: init.mode,
      state: init.state ?? "running",
      vocabulary: init.vocabulary ?? [
        "auth.session",
        "auth.server",
        "events.registration",
      ],
      fallbackAtUs: init.fallbackAtUs ?? 0,
      endsAtUs: init.endsAtUs ?? 0,
      startedAtUs: init.startedAtUs ?? 0,
      buildHash: init.buildHash ?? "",
      baseSha: init.baseSha ?? "",
    };
    this.state.meId = this.addParticipant(
      init.participant,
      init.provider,
      true,
    );
  }

  world(): World {
    return this.state;
  }

  changes(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  close(): void {
    this.listeners.clear();
  }

  async connect(): Promise<void> {
    this.state.online = true;
    this.state.offlineSinceUs = undefined;
    this.emit();
  }

  addPeer(provider: Provider, name = provider): number {
    return this.addParticipant(name, provider, true);
  }

  setJob(job: JobRow | null): void {
    this.state.job = job;
    this.emit();
  }

  /** A message from someone else, so dibs_status has an unread reply to wake a long-poll. */
  receiveMessage(fromName: string, text: string): void {
    const from = this.state.participants.find(
      (participant) => participant.name === fromName,
    );
    if (!from) throw new Error(`unknown sender ${fromName}`);
    this.state.messages.push({
      id: this.next(),
      lobbyId: this.state.lobby?.id ?? 0,
      fromId: from.id,
      to: "all",
      text,
      createdAtUs: this.nowUs(),
    });
    this.emit();
  }

  /** What `debug_deliver` does for hook tests: a delivery addressed to me. */
  debugDeliver(kind: DeliveryKind, summary: string, refId = 0): DeliveryRow {
    const row = this.deliver(this.state.meId ?? 0, kind, refId, summary);
    this.emit();
    return row;
  }

  openProposal(input: {
    key: string;
    contractText: string;
    rationale?: string;
    relation?: Relation;
    requiredPartyIds?: number[];
    citedItemIds?: number[];
    revision?: number;
  }): ProposalRow {
    const proposal: ProposalRow = {
      id: this.next(),
      lobbyId: this.state.lobby?.id ?? 0,
      key: input.key,
      revision: input.revision ?? 1,
      relation: input.relation ?? "conflict",
      contractText: input.contractText,
      rationale: input.rationale ?? "",
      citedItemIds: input.citedItemIds ?? [],
      requiredPartyIds:
        input.requiredPartyIds ??
        (this.state.meId === null ? [] : [this.state.meId]),
      state: "proposed",
    };
    this.state.proposals.push(proposal);
    for (const id of proposal.requiredPartyIds) {
      this.deliver(
        id,
        "proposal",
        proposal.id,
        `dibs update from your team's coordination service: proposal P${proposal.id} (rev ${proposal.revision}) for ${proposal.key} awaits your response. Proposed contract: ${proposal.contractText}`,
      );
    }
    this.emit();
    return proposal;
  }

  async publishPlan(input: PlanInput, requestId: string): Promise<CallResult> {
    const payload = {
      goal: input.goal,
      produces: input.produces.map((item) => ({
        key: item.key,
        text: item.statement,
      })),
      requires: input.requires.map((item) => ({
        key: item.key,
        text: item.assumption,
      })),
      notes: input.notes ?? "",
    };
    const replay = this.begin(requestId, payload);
    if (replay) return replay;
    const refused = this.guard(requestId, true);
    if (refused) return refused;
    const invalid = this.validatePlan(requestId, payload);
    if (invalid) return invalid;
    const me = this.state.meId ?? 0;
    const lobbyId = this.state.lobby?.id ?? 0;
    const incoming = [
      ...payload.produces.map((item) => ({
        ...item,
        kind: "produces" as const,
      })),
      ...payload.requires.map((item) => ({
        ...item,
        kind: "requires" as const,
      })),
    ];
    for (const proposal of this.state.proposals) {
      if (proposal.state !== "proposed") continue;
      const changed = proposal.citedItemIds.some((id) => {
        const basis = this.state.items.find((item) => item.id === id);
        if (!basis || basis.participantId !== me) return false;
        return !incoming.some(
          (item) =>
            item.key === basis.key &&
            item.kind === basis.kind &&
            item.text === basis.text,
        );
      });
      if (changed) proposal.state = "superseded";
    }
    for (const plan of this.state.plans)
      if (plan.participantId === me && plan.current) plan.current = false;
    for (const item of this.state.items)
      if (item.participantId === me && item.current) item.current = false;
    const previous = this.state.plans.filter(
      (plan) => plan.participantId === me,
    );
    const plan: PlanRow = {
      id: this.next(),
      lobbyId,
      participantId: me,
      revision: Math.max(0, ...previous.map((row) => row.revision)) + 1,
      goal: payload.goal,
      notes: payload.notes,
      requestId,
      current: true,
    };
    this.state.plans.push(plan);
    for (const item of incoming) {
      const row: ItemRow = {
        id: this.next(),
        planId: plan.id,
        lobbyId,
        participantId: me,
        ...item,
        current: true,
      };
      this.state.items.push(row);
    }
    if (this.state.lobby?.mode === "dibs") {
      this.state.job = {
        id: this.state.job?.id ?? this.next(),
        lobbyId,
        state: "debouncing",
        kind: this.state.job?.kind ?? "analyze",
      };
    }
    this.emit();
    return this.finish(requestId, payload, {
      planId: plan.id,
      revision: plan.revision,
    });
  }

  async respond(input: RespondInput, requestId: string): Promise<CallResult> {
    const payload = { ...input };
    const replay = this.begin(requestId, payload);
    if (replay) return replay;
    const refused = this.guard(requestId, true);
    if (refused) return refused;
    if (this.state.lobby?.mode !== "dibs")
      return callError(requestId, "proposals disabled");
    const proposal = this.state.proposals.find(
      (row) => row.id === input.proposalId,
    );
    if (
      !proposal ||
      proposal.state !== "proposed" ||
      proposal.revision !== input.revision
    ) {
      return callError(requestId, "proposal not open at revision");
    }
    const me = this.state.meId ?? 0;
    if (!proposal.requiredPartyIds.includes(me))
      return callError(requestId, "not a required party");
    if (input.decision === "reject" && input.reason.trim().length === 0)
      return callError(requestId, "invalid reason");
    if (input.reason.length > LIMITS.notesChars)
      return callError(requestId, "invalid reason");
    if (
      this.state.responses.some(
        (row) =>
          row.proposalId === proposal.id &&
          row.revision === input.revision &&
          row.participantId === me,
      )
    ) {
      return callError(requestId, "already responded");
    }
    const response: ResponseRow = {
      proposalId: proposal.id,
      revision: input.revision,
      participantId: me,
      decision: input.decision,
    };
    this.state.responses.push(response);
    for (const delivery of this.state.deliveries) {
      if (
        delivery.kind === "proposal" &&
        delivery.refId === proposal.id &&
        delivery.targetId === me
      )
        delivery.stage = "responded";
    }
    if (input.decision === "reject") {
      const ids = new Set(
        this.state.proposals
          .filter((row) => row.key === proposal.key)
          .map((row) => row.id),
      );
      const rejections = this.state.responses.filter(
        (row) => row.decision === "reject" && ids.has(row.proposalId),
      );
      const escalated = rejections.length >= 2;
      proposal.state = escalated ? "escalated" : "rejected";
      if (escalated) {
        for (const id of proposal.requiredPartyIds) {
          this.deliver(
            id,
            "escalated",
            proposal.id,
            `dibs: proposal P${proposal.id} for ${proposal.key} was rejected twice and needs the developers.`,
          );
        }
      } else if (this.state.job) {
        this.state.job = {
          ...this.state.job,
          state: "debouncing",
          kind: "revise",
        };
      }
    } else {
      const accepted = this.state.responses.filter(
        (row) =>
          row.proposalId === proposal.id &&
          row.revision === input.revision &&
          row.decision === "accept",
      );
      if (
        proposal.requiredPartyIds.every((id) =>
          accepted.some((row) => row.participantId === id),
        )
      ) {
        proposal.state = "accepted";
        for (const contract of this.state.contracts)
          if (contract.key === proposal.key && contract.current)
            contract.current = false;
        const contract: ContractRow = {
          id: this.next(),
          lobbyId: proposal.lobbyId,
          key: proposal.key,
          revision: proposal.revision,
          text: proposal.contractText,
          source: "agreed",
          proposalId: proposal.id,
          current: true,
        };
        this.state.contracts.push(contract);
        const parties = new Set(
          this.state.items
            .filter((item) => item.current && item.key === proposal.key)
            .map((item) => item.participantId),
        );
        for (const id of parties) {
          this.deliver(
            id,
            "contract",
            contract.id,
            `dibs: the contract for ${proposal.key} is agreed (rev ${contract.revision}): ${contract.text}`,
          );
        }
      }
    }
    this.emit();
    return this.finish(requestId, payload, {
      decision: input.decision,
      proposalState: proposal.state,
    });
  }

  async sendMessage(
    to: MessageRow["to"],
    text: string,
    requestId: string,
  ): Promise<CallResult> {
    const payload = { to, text };
    const replay = this.begin(requestId, payload);
    if (replay) return replay;
    const refused = this.guard(requestId, true);
    if (refused) return refused;
    if (this.state.lobby?.mode === "none")
      return callError(requestId, "messages disabled in none mode");
    if (text.trim().length === 0 || text.length > LIMITS.messageChars)
      return callError(requestId, "invalid message");
    const me = this.state.meId ?? 0;
    const targets = this.state.participants.filter(
      (participant) =>
        participant.role === "agent" &&
        participant.id !== me &&
        participant.currentLobbyId === this.state.lobby?.id &&
        (to === "all" || participant.provider === to),
    );
    if (targets.length === 0)
      return callError(requestId, "no recipient in lobby");
    const message: MessageRow = {
      id: this.next(),
      lobbyId: this.state.lobby?.id ?? 0,
      fromId: me,
      to,
      text,
      createdAtUs: this.nowUs(),
    };
    this.state.messages.push(message);
    const name = this.state.meName;
    for (const target of targets)
      this.deliver(
        target.id,
        "message",
        message.id,
        `dibs: ${name} says ${text}`,
      );
    this.emit();
    return this.finish(requestId, payload, { messageId: message.id });
  }

  async markDelivery(
    id: number,
    stage: "received" | "shown",
  ): Promise<CallResult> {
    const requestId = `delivery:${id}:${stage}`;
    if (!this.state.online) return { status: "offline", requestId };
    const delivery = this.state.deliveries.find(
      (row) => row.id === id && row.targetId === this.state.meId,
    );
    if (!delivery) return callError(requestId, "not delivery target");
    const order = ["queued", "received", "shown", "responded"];
    const from = order.indexOf(delivery.stage);
    const to = order.indexOf(stage);
    if (to < from) return callError(requestId, "delivery cannot move backward");
    if (to > from) delivery.stage = stage;
    this.emit();
    return { status: "ok", requestId, result: { stage: delivery.stage } };
  }

  async reportHead(
    lobbyId: number,
    sha: string,
    outOfAreaFiles: string[],
  ): Promise<CallResult> {
    const requestId = `head:${sha}`;
    if (!this.state.online) return { status: "offline", requestId };
    if (this.state.lobby?.id !== lobbyId)
      return callError(requestId, "wrong lobby");
    if (!/^[a-f0-9]{40,64}$/.test(sha))
      return callError(requestId, "invalid head SHA");
    return { status: "ok", requestId, result: { sha, outOfAreaFiles } };
  }

  private addParticipant(
    name: string,
    provider: Provider,
    online: boolean,
  ): number {
    const existing = this.state.participants.find(
      (participant) => participant.name === name,
    );
    if (existing) return existing.id;
    const row: ParticipantRow = {
      id: this.next(),
      name,
      provider,
      role: "agent",
      online,
      currentLobbyId: this.state.lobby?.id ?? null,
    };
    this.state.participants.push(row);
    return row.id;
  }

  private deliver(
    targetId: number,
    kind: DeliveryKind,
    refId: number,
    summary: string,
  ): DeliveryRow {
    const row: DeliveryRow = {
      id: this.next(),
      lobbyId: this.state.lobby?.id ?? 0,
      targetId,
      kind,
      refId,
      summary,
      stage: "queued",
      queuedAtUs: this.nowUs(),
    };
    if (targetId === this.state.meId) this.state.deliveries.push(row);
    return row;
  }

  private validatePlan(
    requestId: string,
    payload: {
      goal: string;
      notes: string;
      produces: { key: string; text: string }[];
      requires: { key: string; text: string }[];
    },
  ): CallResult | undefined {
    if (
      payload.goal.trim().length === 0 ||
      payload.goal.length > LIMITS.goalChars
    )
      return callError(requestId, "invalid goal");
    if (payload.notes.length > LIMITS.notesChars)
      return callError(requestId, "invalid notes");
    const incoming = [
      ...payload.produces.map((item) => ({ ...item, kind: "produces" })),
      ...payload.requires.map((item) => ({ ...item, kind: "requires" })),
    ];
    if (incoming.length > LIMITS.planItems)
      return callError(requestId, "too many plan items");
    const seen = new Set<string>();
    for (const item of incoming) {
      if (!this.state.lobby?.vocabulary.includes(item.key))
        return callError(requestId, "unknown vocabulary key");
      if (item.text.trim().length === 0 || item.text.length > LIMITS.textChars)
        return callError(requestId, "invalid item text");
      const slot = `${item.kind}/${item.key}`;
      if (seen.has(slot)) return callError(requestId, "duplicate plan item");
      seen.add(slot);
    }
    return undefined;
  }

  private guard(requestId: string, running: boolean): CallResult | undefined {
    if (this.failNext === "timeout") {
      this.failNext = null;
      return { status: "pending", requestId };
    }
    if (this.failNext === "disconnect" || !this.state.online) {
      this.failNext = null;
      return { status: "offline", requestId };
    }
    if (running && this.state.lobby?.state !== "running")
      return callError(requestId, "lobby not running");
    return undefined;
  }

  private begin(requestId: string, payload: unknown): CallResult | undefined {
    const body = canonical(payload);
    const previous = this.saved.get(requestId);
    if (!previous) return undefined;
    if (previous.payload !== body)
      return callError(requestId, "requestId reused with a different payload");
    return previous.result;
  }

  private finish(
    requestId: string,
    payload: unknown,
    result: Record<string, unknown>,
  ): CallResult {
    const call: CallResult = { status: "ok", requestId, result };
    this.saved.set(requestId, { payload: canonical(payload), result: call });
    return call;
  }

  private next(): number {
    return this.seq++;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

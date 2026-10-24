// Inbox files, the shown/claimed sweep, and the hook-status snapshot the Stop hook reads.

import fs from "node:fs";
import path from "node:path";
import { DIBS_FILES, TIMING, type InboxItem } from "@dibs/protocol";
import { log } from "./log.ts";
import type { AgentStore } from "./store.ts";
import { computeStatus, toHookStatus, type DeliveryRow } from "./world.ts";

const ITEM = /^(\d+)\.json$/;
const RANK = ["queued", "received", "shown", "responded"];

export interface SyncState {
  marking: Set<string>;
}

export function syncOnce(
  dir: string,
  store: AgentStore,
  state: SyncState,
  nowMs = Date.now(),
): void {
  const inbox = path.join(dir, DIBS_FILES.inbox);
  const claimed = path.join(dir, DIBS_FILES.claimed);
  const shown = path.join(dir, DIBS_FILES.shown);
  for (const folder of [inbox, claimed, shown])
    fs.mkdirSync(folder, { recursive: true });

  const known = new Set([...ids(inbox), ...ids(claimed), ...ids(shown)]);
  const world = store.world();
  for (const delivery of world.deliveries) {
    if (RANK.indexOf(delivery.stage) >= RANK.indexOf("shown")) continue;
    if (known.has(delivery.id)) continue;
    writeInbox(inbox, delivery);
    known.add(delivery.id);
    if (delivery.stage === "queued")
      requestMark(store, state, delivery.id, "received");
  }

  for (const id of ids(inbox)) {
    const delivery = world.deliveries.find((row) => row.id === id);
    if (delivery?.stage === "queued") requestMark(store, state, id, "received");
  }

  for (const id of ids(shown)) {
    const delivery = world.deliveries.find((row) => row.id === id);
    if (!delivery) continue;
    if (RANK.indexOf(delivery.stage) < RANK.indexOf("shown"))
      requestMark(store, state, id, "shown");
  }

  const staleBefore = nowMs - TIMING.claimedSweepSec * 1000;
  for (const name of list(claimed)) {
    const match = ITEM.exec(name);
    if (!match) continue;
    const file = path.join(claimed, name);
    let mtime = nowMs;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (mtime > staleBefore) continue;
    renameRetry(file, path.join(inbox, name));
  }

  writeHookStatus(dir, store, nowMs);
}

export function startSync(dir: string, store: AgentStore): () => void {
  const state: SyncState = { marking: new Set() };
  let running = false;
  let again = false;
  const tick = () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      syncOnce(dir, store, state);
    } catch (error) {
      log(
        `inbox sync: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      running = false;
      if (again) {
        again = false;
        queueMicrotask(tick);
      }
    }
  };
  const off = store.changes(tick);
  const timer = setInterval(tick, 1000);
  timer.unref?.();
  tick();
  return () => {
    off();
    clearInterval(timer);
  };
}

function requestMark(
  store: AgentStore,
  state: SyncState,
  id: number,
  stage: "received" | "shown",
): void {
  const key = `${id}:${stage}`;
  if (state.marking.has(key)) return;
  state.marking.add(key);
  void store
    .markDelivery(id, stage)
    .catch((error: unknown) => {
      log(
        `mark_delivery ${id} ${stage}: ${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => state.marking.delete(key));
}

function writeInbox(inbox: string, delivery: DeliveryRow): void {
  const item: InboxItem = {
    deliveryId: delivery.id,
    lobbyId: delivery.lobbyId,
    kind: delivery.kind,
    refId: delivery.refId,
    summary: delivery.summary,
    queuedAtUs: delivery.queuedAtUs,
  };
  const finalPath = path.join(inbox, `${delivery.id}.json`);
  const tmp = path.join(inbox, `.${delivery.id}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(item));
  if (!renameRetry(tmp, finalPath)) fs.rmSync(tmp, { force: true });
}

function writeHookStatus(dir: string, store: AgentStore, nowMs: number): void {
  const world = store.world();
  const status = computeStatus(world, [], nowMs * 1000);
  const next = JSON.stringify(toHookStatus(world, status));
  const file = path.join(dir, "hook-status.json");
  try {
    if (fs.readFileSync(file, "utf8") === next) return;
  } catch {
    // First write.
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next);
  if (!renameRetry(tmp, file)) fs.rmSync(tmp, { force: true });
}

function ids(folder: string): number[] {
  return list(folder).flatMap((name) => {
    const match = ITEM.exec(name);
    return match ? [Number(match[1])] : [];
  });
}

function list(folder: string): string[] {
  try {
    return fs.readdirSync(folder);
  } catch {
    return [];
  }
}

function renameRetry(from: string, to: string): boolean {
  const deadline = Date.now() + 200;
  for (;;) {
    try {
      fs.renameSync(from, to);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        (code === "EPERM" || code === "EBUSY" || code === "EACCES") &&
        Date.now() < deadline
      ) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      return false;
    }
  }
}

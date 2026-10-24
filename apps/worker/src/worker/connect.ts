import { setTimeout as delay } from "node:timers/promises";
import type { HealthState } from "../http/health.ts";

/** The SDK reconnects established connections, but initial failures need our own retry loop. */
export async function connectWithRetry<T>(
  connect: () => Promise<T>,
  health: HealthState,
  signal?: AbortSignal,
  log: (message: string) => void = console.error,
): Promise<T> {
  let backoffMs = 1000;
  for (;;) {
    if (signal?.aborted) throw new Error("worker connection aborted");
    try {
      const db = await connect();
      health.setDb("connected");
      return db;
    } catch (error) {
      health.setDb("disconnected");
      log(
        `[worker] DB connection failed; retrying in ${backoffMs}ms: ${String(error)}`,
      );
      await delay(backoffMs, undefined, { signal });
      backoffMs = Math.min(backoffMs * 2, 15000);
    }
  }
}

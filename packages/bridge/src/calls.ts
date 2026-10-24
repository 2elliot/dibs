// Reducer-call results. Same requestId + same canonical payload is safe to retry;
// a timeout or an unknown result is `pending`, a dropped connection is `offline`.

import { TIMING } from "@dibs/protocol";

export type CallResult =
  | { status: "ok"; requestId: string; result: Record<string, unknown> }
  | { status: "pending"; requestId: string }
  | { status: "offline"; requestId: string }
  | { status: "error"; requestId: string; error: string };

/** The module's canonical JSON: sorted object keys, no whitespace. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function callError(requestId: string, error: string): CallResult {
  return { status: "error", requestId, error };
}

/**
 * Await a reducer. The SpacetimeDB client does not retry a timed-out call; the same
 * requestId is the retry key, so pending is a result and not an exception.
 */
export async function settleCall(
  requestId: string,
  run: () => Promise<Record<string, unknown>>,
  timeoutMs = TIMING.bridgeCallTimeoutSec * 1000,
): Promise<CallResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error("reducer call timed out");
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
    return { status: "ok", requestId, result: value };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (
      name === "DisconnectedError" ||
      /disconnect/i.test(name) ||
      /disconnect/i.test(message)
    ) {
      return { status: "offline", requestId };
    }
    if (
      name === "TimeoutError" ||
      name === "UnknownCallResultError" ||
      /UnknownCallResult/i.test(message)
    ) {
      return { status: "pending", requestId };
    }
    return {
      status: "error",
      requestId,
      error: message || "reducer rejected the call",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

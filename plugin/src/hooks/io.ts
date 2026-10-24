// Claude Code's side of the hook adapter: reading its stdin JSON and speaking its output
// format. The decisions themselves are agent-neutral and live in @dibs/core. See
// https://code.claude.com/docs/en/hooks for the fields per event.

export interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  transcript_path?: string;
  permission_mode?: string;
}

export interface ToolHookInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
}

// Hooks run on every tool call, so a slow or unreachable server must never stall a session.
const TIMEOUT_MS = 5000;

// Claude Code parses hook stdout as JSON and shows stderr to Claude on a block, so neither can
// carry the SpacetimeDB SDK's console.log chatter. failOpen already handles real errors.
console.log = () => {};

export async function readInput<T extends HookInput>(): Promise<T> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw) as T;
}

/** Block the tool call. Claude sees the reason and can act on it. */
export function block(reason: string): never {
  process.stderr.write(reason);
  process.exit(2);
}

/** Inject text into Claude's context after this event. */
export function addContext(hookEventName: string, additionalContext: string): void {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }),
  );
}

/**
 * Run a hook's work and exit. If dibs errors, isn't configured, or doesn't answer in time,
 * the tool call goes ahead: dibs must never brick a session. `onError` can report why.
 */
export async function failOpen(
  work: () => Promise<void>,
  onError?: (message: string) => void,
): Promise<never> {
  try {
    await Promise.race([
      work(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("dibs didn't answer in time")), TIMEOUT_MS),
      ),
    ]);
  } catch (error) {
    onError?.(error instanceof Error ? error.message : String(error));
  }
  // The SpacetimeDB socket would otherwise keep the process alive.
  process.exit(0);
}

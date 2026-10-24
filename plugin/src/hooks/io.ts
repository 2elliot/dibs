// Shared plumbing for hook scripts. Claude Code sends one JSON object on stdin; see
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

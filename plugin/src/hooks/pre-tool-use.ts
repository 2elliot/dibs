// PreToolUse on file edits: this is what makes dibs mandatory instead of optional. Edits are
// blocked until the agent has called dibs, and on files another agent owns.
import { checkEdit } from "@dibs/core";
import { block, failOpen, readInput, type ToolHookInput } from "./io";

await failOpen(async () => {
  const input = await readInput<ToolHookInput>();
  const path = input.tool_input.file_path ?? input.tool_input.notebook_path;
  if (typeof path !== "string") return;
  const decision = await checkEdit({ sessionId: input.session_id, path, cwd: input.cwd });
  if (!decision.allow) block(decision.reason);
});

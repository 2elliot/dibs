// PostToolUse on every tool: the realtime channel. Delivers unread messages from other agents
// to Claude mid-task. Quiet by default: prints nothing when the inbox is empty.
import { pendingContext } from "@dibs/core";
import { addContext, failOpen, readInput, type ToolHookInput } from "./io";

await failOpen(async () => {
  const input = await readInput<ToolHookInput>();
  const text = await pendingContext({ sessionId: input.session_id });
  if (text) addContext("PostToolUse", text);
});

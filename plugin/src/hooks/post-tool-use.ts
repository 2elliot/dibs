// PostToolUse on every tool: the realtime channel. Delivers unread inbox messages to Claude
// mid-task through additionalContext. Quiet by default: print nothing when the inbox is empty.
import { readInput, type ToolHookInput } from "./io";

const input = await readInput<ToolHookInput>();

// TODO(plugin lane): core.getInbox(agentId) and, if there's anything,
// addContext("PostToolUse", formatted messages).
void input;

// PreToolUse on file edits: this is what makes dibs mandatory instead of optional.
import { readInput, type ToolHookInput } from "./io";

const input = await readInput<ToolHookInput>();

// TODO(plugin lane):
// 1. If this agent hasn't published an intent yet, block() with "call publish_intent first".
// 2. If core.fileOwner(path) is another agent, block() naming the owner and telling Claude
//    to use request_feature instead.
// Until then every edit is allowed.
void input;

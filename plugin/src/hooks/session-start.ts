// SessionStart: register this session as a dibs agent and load the team's live intents.
import { readInput, type HookInput } from "./io";

const input = await readInput<HookInput>();

// TODO(plugin lane): core.registerAgent(input.session_id, repo), then addContext() with the
// agent id and a summary of the team's active intents.
void input;

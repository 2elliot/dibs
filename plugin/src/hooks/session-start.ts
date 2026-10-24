// SessionStart: register this session as a dibs agent, and tell Claude its agent id and what
// teammates' agents are already building.
import { basename } from "node:path";
import { startSession } from "@dibs/core";
import { addContext, failOpen, readInput, type HookInput } from "./io";

await failOpen(
  async () => {
    const input = await readInput<HookInput>();
    const { context } = await startSession({
      sessionId: input.session_id,
      kind: "claude-code",
      repo: basename(input.cwd),
    });
    addContext("SessionStart", context);
  },
  (message) => addContext("SessionStart", `dibs isn't running for this session: ${message}`),
);

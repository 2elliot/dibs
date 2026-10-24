# Agent-neutral hooks, and an agent kind on every agent

Lane: plugin + core · Date: 2026-10-23

So that Codex and Gemini CLI can join later without redoing anything, two changes went in before the first Maincloud publish:

- **`agent.kind`** (`"claude-code" | "codex" | "gemini"`) is a column on the agent table, passed to `registerAgent`. Added now because changing columns on a published database means `--delete-data`. The dashboard shows it.
- **The hook decisions live in core** (`packages/core/src/hooks.ts`): `startSession` (register, return the agent id and the team's live intents as context), `checkEdit` (block until the agent has called dibs, and on other agents' files), and `pendingContext` (unread messages as context, marked read). Claude Code's hooks in `plugin/src/hooks/` only parse its input and speak its output format. A Codex or Gemini CLI adapter is the same translation for their hook formats.

Rules every adapter follows:

- **Fail open.** If dibs errors, isn't configured, or takes over 5 seconds, the tool call goes ahead. dibs must never brick a session.
- **Keep stdout clean.** The SpacetimeDB SDK logs with `console.log`. Hooks silence it, and the MCP server sends it to stderr, because both use stdout as a protocol channel.

The SessionStart context now tells the agent its `agent_id` for the MCP tools.

Open question for the plugin lane: each hook run opens its own SpacetimeDB connection. Against Maincloud that is about 0.7 s per run, and PostToolUse runs after every tool call. See `docs/status/plugin.md` for options.

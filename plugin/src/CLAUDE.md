# plugin lane

The Claude Code plugin teammates install. Plugin root is `plugin/`: `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, `skills/dibs/SKILL.md`. Source is here in `src/`; `npm run build:plugin` bundles it into `plugin/dist/*.mjs`, which is what the manifests point at.

- `server.ts`: the MCP server. Tools are thin wrappers over `@dibs/core`; put logic in core, not here.
- `hooks/`: Claude Code's hook adapter. Each entry file parses Claude's input and calls an agent-neutral decision in `packages/core/src/hooks.ts` (`startSession`, `checkEdit`, `pendingContext`). `io.ts` speaks Claude's output format: exit 2 to block, `additionalContext` to inject. A Codex or Gemini CLI adapter would be the same thin translation.
- Hooks must fail open (`failOpen` in `io.ts`) and keep stdout clean. Claude parses it as JSON, and the SpacetimeDB SDK logs with `console.log`, which `io.ts` silences.
- Hooks use exec form (`node` + `args`) so they run the same on Windows and macOS.
- Try it: `npm run dev:plugin` in one terminal, then `claude --plugin-dir <path to dibs>/plugin` from the demo repo. Rebuilt hooks apply on their next run; restart the session to pick up a rebuilt MCP server.
- Hook and plugin references: https://code.claude.com/docs/en/hooks and https://code.claude.com/docs/en/plugins-reference

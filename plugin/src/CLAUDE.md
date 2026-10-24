# plugin lane

The Claude Code plugin teammates install. Plugin root is `plugin/`: `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, `skills/dibs/SKILL.md`. Source is here in `src/`; `npm run build:plugin` bundles it into `plugin/dist/*.mjs`, which is what the manifests point at.

- `server.ts`: the MCP server. Tools are thin wrappers over `@dibs/core`; put logic in core, not here.
- `hooks/`: one entry file per hook event, plus `io.ts` for stdin, blocking (exit 2) and `additionalContext`.
- Hooks run on every tool call, so keep them fast and quiet: no output unless there's something Claude must act on, and never crash a session on a network error.
- Hooks use exec form (`node` + `args`) so they run the same on Windows and macOS.
- Try it: `npm run dev:plugin` in one terminal, then `claude --plugin-dir <path to dibs>/plugin` from the demo repo. Rebuilt hooks apply on their next run; restart the session to pick up a rebuilt MCP server.
- Hook and plugin references: https://code.claude.com/docs/en/hooks and https://code.claude.com/docs/en/plugins-reference

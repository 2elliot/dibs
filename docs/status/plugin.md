# Lane: plugin

Owner: _TBD_ · Branch: `plugin/mcp-tools` · Updated: 2026-10-23

## Now

- Nothing started. Skeleton is in `plugin/`: MCP server with all five tools stubbed, three hooks that allow everything.

## Next

- [ ] `npm run build:plugin`, then `claude --plugin-dir ./plugin`: confirm the dibs tools and hooks load
- [ ] Decide how a tool call learns its agent id (see the TODO in `plugin/src/server.ts`) and record it in `docs/decisions/`
- [ ] SessionStart: register the agent through core, inject its id and the team's live intents
- [ ] PreToolUse: block edits until the agent has published an intent
- [ ] PreToolUse: block edits to files another agent owns, naming the owner
- [ ] PostToolUse: deliver unread inbox messages via `additionalContext`
- [ ] With core: the full loop across two laptops (Day 1 night)
- [ ] Day 2: stub swap when a contract is delivered; tune the skill so agents follow the protocol
- [ ] Before the demo: decide between committing `plugin/dist` (so `/plugin install dibs@dibs` from GitHub works) and building on each laptop

## Needs from other lanes

- core: `registerAgent`, `publishIntent`, `getInbox`, `fileOwner` (signatures in `packages/core/src/index.ts`)

## Notes for teammates

-

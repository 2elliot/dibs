# Lane: plugin

Owner: _TBD_ · Branch: `plugin/mcp-tools` · Updated: 2026-10-23

## Now

- Nothing started. Skeleton is in `plugin/`: MCP server with all five tools stubbed, three hooks that allow everything.

## Next

- [ ] **By H2:** `npm run build:plugin`, then `claude --plugin-dir ./plugin`; confirm the dibs tools and hooks load. Agree on the MCP tool signatures with the team.
- [ ] Decide how a tool call learns its agent id (see the TODO in `plugin/src/server.ts`) and record it in `docs/decisions/`
- [ ] **H2–H10:** SessionStart registers the agent through core; `publish_intent` and `get_inbox`; PreToolUse blocks edits until an intent is published
- [ ] **H10–H18:** move to two laptops; PostToolUse delivers inbox messages via `additionalContext`; PreToolUse blocks edits to files another agent owns
- [ ] **H18–H26:** stub swap when a contract is delivered; tune the skill so agents follow the protocol
- [ ] Anthropic track: a one-command install and a clear README. Decide between committing `plugin/dist` (so `/plugin install dibs@dibs` from GitHub works) and building on each laptop.
- [ ] Stretch after about H22: the Codex adapter, only if the loop is solid

## Needs from other lanes

- core: `registerAgent`, `publishIntent`, `getInbox`, `fileOwner` (signatures in `packages/core/src/index.ts`)

## Notes for teammates

-

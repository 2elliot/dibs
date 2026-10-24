# Lane: plugin

Owner: _TBD_ · Branch: `plugin/mcp-tools` · Updated: 2026-10-23

## Now

- All three hooks are wired as thin adapters over core and tested end to end against a local SpacetimeDB:
  - SessionStart registers the agent and tells Claude its `agent_id` and the team's intents.
  - PreToolUse blocks edits before `publish_intent` and on other agents' files.
  - PostToolUse delivers unread messages once.
- All three fail open. The MCP server has all five tools; `get_inbox` works, and the others wait on core.

## Next

- [ ] **By H2:** `npm run build:plugin`, then `claude --plugin-dir ./plugin` in a real session against the shared database. Agree on the MCP tool signatures with the team.
- [ ] Cut hook latency. Measured against Maincloud `dib`: about 0.7 s per hook run (150 ms Node startup plus about 500 ms to connect and subscribe to every table). That cost lands on every edit, and PostToolUse adds it to every tool call. Options: subscribe to only the rows a hook needs, use SpacetimeDB's HTTP SQL API, or have the long-lived MCP server keep a cache the hooks read.
- [ ] **H2–H10:** with core, `publish_intent` end to end: two sessions on one laptop, and the second gets an overlap alert
- [ ] **H10–H18:** move to two laptops
- [ ] **H18–H26:** stub swap when a contract is delivered; tune the skill so agents follow the protocol
- [ ] Anthropic track: a one-command install and a clear README. Decide between committing `plugin/dist` (so `/plugin install dibs@dibs` from GitHub works) and building on each laptop.
- [ ] Stretch after about H22: a Codex adapter (hooks in `.codex/`, same core calls, `kind: "codex"`). Gemini CLI would be the same via an extension.

## Needs from other lanes

- core: `publishIntent`, `requestFeature`, `proposeContract`, `markDelivered` (signatures in `packages/core/src/index.ts`)

## Notes for teammates

- Hooks never block a session when dibs is down or unconfigured. They let the edit through.

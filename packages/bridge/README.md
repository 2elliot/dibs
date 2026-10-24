# @dibs/bridge

The MCP server, checkpoint hook, and `dibs session` command for one coding agent (Claude Code, Codex, or Droid).

`docs/plan.md` §5 and `docs/API.md` are the contract. This package follows the API where it disagrees with the older layout in the plan: one folder per participant under `DIBS_HOME`, and inbox files named `<deliveryId>.json`.

## Build and test

```bash
npm run test -w @dibs/bridge
npm run typecheck -w @dibs/bridge
```

The test build writes `packages/bridge/dist/bridge.mjs` and copies `dibs-hook.mjs` next to it. Provider configs point at those files. Tests set `DIBS_HOME` to a temp directory.

`npm run test:live -w @dibs/bridge` runs the port-4001 check against headless Claude Code. It spends a small amount of API credit.

## Bridge

```text
node packages/bridge/dist/bridge.mjs --participant <name> --provider <claude|codex|droid>
```

It answers MCP `initialize` before it connects to SpacetimeDB. Logs go to stderr. The process exits when stdin closes. `bridge.lock` holds the pid and is taken over when that pid is dead.

Tools follow `TOOLS_BY_MODE`. Every tool has `destructiveHint: false`. `dibs_status` also has `readOnlyHint: true`. `waitSec` defaults to 0 and caps at 45; a longer wait returns early when the phase, keys, proposals, messages, or roster change. Reducer calls time out after 5 seconds (`pending`, same `requestId` on an identical retry) or return `offline` when the database is disconnected.

Set `DIBS_BRIDGE_STORE=memory` to run with no database. The default `spacetime` store loads `@dibs/client` at runtime. That package arrives with issue 1's `[module-ready]` commit. Until then the bridge stays up and tools return `offline`.

On startup the bridge writes an inbox file for every delivery that has not reached `shown`. Every second it marks `shown/` files in the database and returns `claimed/` files older than 60 seconds to `inbox/`.

## Hook

```text
node packages/bridge/dist/dibs-hook.mjs --participant <name> --provider <claude|codex|droid>
```

Zero dependencies. The provider passes the event JSON on stdin. The hook is silent unless `cwd` is inside `session.json`'s `clonePath` (case-insensitive on Windows). It claims inbox files by rename, touches the mtime, prints, and moves them to `shown/`.

SessionStart, UserPromptSubmit, and PostToolUse print only JSON `additionalContext`. Claude and Codex also get a one-line `systemMessage`. Droid does not. Stop prints `{"decision":"block","reason":"..."}` or nothing: at most once per proposal, and at most 8 times per lobby, when a proposal is waiting or a key is still pending before fallback. The offline notice is injected once, and never on Stop or SessionStart.

`hook-status.json` is a bridge-local snapshot (phase, pending keys, proposals still awaiting a response) so Stop can block after the delivery was already shown.

## `dibs session`

```text
dibs session prep <lobbyId> --participant <name> --provider <claude|codex|droid> --clone <path> --lobbies <url> --offline --mode dibs --base <sha> --build-hash <hex> --fallback-at-us <us> --ends-at-us <us> --prompt <text>
dibs session start --participant <name>
dibs session stop --participant <name>
```

`prep` resets the clone to the base commit, rewrites that provider's config so it is byte-identical across lobbies, and writes `session.json`. It refuses to reset the dibs checkout. Without a database token, pass `--offline` and the lobby fields. The build hash is the sha256 of `dist/bridge.mjs` and `dist/dibs-hook.mjs`.

`start` launches the provider CLI with an argument array and no shell, waits until `hook-alive.json` names this lobby (30 seconds), and at `endsAtUs` kills the process tree (`taskkill /T /F` on Windows). It commits `lobby <id> <provider> final` and pushes `HEAD` to `refs/heads/lobby/<id>/<provider>` on the lobbies URL. `DIBS_AGENT_COMMAND` (a JSON array) replaces the provider CLI for tests. `DIBS_CODEX_HOME` redirects Codex's user-level prompt and trust file away from `~/.codex`.

## Where config is written

| Provider    | MCP and hooks                                                        | Settings                                      | `/dibs` command                     |
| ----------- | -------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------- |
| Claude Code | `DIBS_HOME/<participant>/claude.mcp.json` and `claude.settings.json` | same folder                                   | `<clone>/.claude/commands/dibs.md`  |
| Codex       | `<clone>/.codex/config.toml` and `hooks.json`                        | trust block in `DIBS_CODEX_HOME/config.toml`  | `DIBS_CODEX_HOME/prompts/dibs.md`   |
| Droid       | `<clone>/.factory/mcp.json` and `hooks.json`                         | `DIBS_HOME/<participant>/droid.settings.json` | `<clone>/.factory/commands/dibs.md` |

Launch flags for Claude Code:

```text
claude --settings <dir>/claude.settings.json --mcp-config <dir>/claude.mcp.json --strict-mcp-config --permission-mode acceptEdits "<prompt>"
```

Codex and Droid use the commands in `docs/plan.md` Appendix A. Codex and Droid hooks are shell command strings. Claude hooks are exec-form (`command` plus `args`).

## Manual checks still open

These need the other machines. Record the result in `docs/compatibility.md`.

Codex on macOS:

- MCP `initialize` finishes inside the startup timeout, including a reconnect.
- Hook trust survives a byte-identical rewrite of `.codex/hooks.json`.
- `systemMessage` is visible. Stop block works. PostToolUse JSON reaches the model.
- The bridge and the hook can write `DIBS_HOME` from inside the sandbox.
- `sandbox_workspace_write.network_access` lets Codex curl its own localhost server.
- `/dibs` shows up as `/dibs` or `/prompts:dibs`.
- No per-project memory carries into the next fresh session.

Droid on Windows:

- Which shell runs hooks and commands. Quote the bridge path if it can contain spaces.
- `droid rules check --json` accepts `droid.settings.json`. Adjust `permissionRules` if the field names differ.
- `droid mcp permissions list` shows the dibs tools approved.
- `systemMessage` stays omitted unless Gate 0 shows Droid accepts it.
- Stop block, PostToolUse context, and `taskkill /T /F` all behave.

## Needs

No protocol change is required. Private files, not in `packages/protocol`:

- `hook-status.json` — snapshot the Stop hook reads
- `hook-state.json` — whether the offline notice was already shown
- `seen-messages.json` — message ids already returned by `dibs_status`
- `machine.json`, `prompt.txt`, `agent.pid`, `agent.log`, `last-head.json` — session bookkeeping

Phase B (a real lobby, `debug_deliver` or `dibs sim`, hook delivery, `dibs_respond`, and `spacetime sql` showing `agreed`) waits on `[module-ready]` from `issue/1-state`. The adapter in `src/spacetime.ts` expects `@dibs/client` to export `DbConnection.builder()` with `withUri`, `withDatabaseName`, `withToken`, `onConnect`, `subscriptionBuilder().onApplied().subscribe(sql)`, and camelCase `reducers`.

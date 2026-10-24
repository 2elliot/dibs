# dibs

A Claude Code plugin that lets a team's coding agents talk to each other in realtime. Each agent says what it's about to build. If two agents want the same thing, dibs catches it even when they describe it differently, the first one builds it, and the second sends its requirements and builds against a stub. Built for CalHacks (36 hours, 3 people), framed for the Spacetime, Anthropic and Microsoft tracks.

Imported into every session:

- @docs/plan.md: scope, architecture, the core loop, timeline and the cut list
- @docs/workflow.md: how the three of us avoid colliding (lanes, branches, merging)

Read `docs/tracks.md` and `docs/pitch.md` when the task touches what judges will see.

## Architecture

| Piece           | Where             | What it is                                                                                             |
| --------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| Backend         | `spacetime/`      | SpacetimeDB module: the tables and the transactional reducers that change them                         |
| Shared contract | `packages/shared` | Generated SpacetimeDB bindings plus the operation types every lane builds against                      |
| Core            | `packages/core`   | Runs on each laptop: embeddings, brute-force similarity, the Claude judge, stubs and tests             |
| Plugin          | `plugin/`         | Claude Code plugin: MCP tools, hook adapters over core's enforcement decisions, the agent-facing skill |
| Dashboard       | `dashboard/`      | Next.js page subscribed to the same SpacetimeDB tables                                                 |
| Demo target     | `demo/`           | The study-group app the agents work on during the demo                                                 |

The plugin calls `@dibs/core`, which talks to SpacetimeDB. The dashboard subscribes to SpacetimeDB directly. Reducers can't call outside services, so anything that does (embeddings, Claude) lives in core.

## Lanes: stay in yours

Each teammate (and their agent) owns one lane. Your lane comes from your branch name: `plugin/...`, `core/...` or `demo/...`. The SessionStart hook tells you which lane you're in.

| Lane   | Owns                                                                       |
| ------ | -------------------------------------------------------------------------- |
| plugin | `plugin/`                                                                  |
| core   | `spacetime/`, `packages/core/`                                             |
| demo   | `dashboard/`, `demo/`, `docs/pitch.md`, `docs/tracks.md`, `docs/research/` |

- Only edit files your lane owns, plus your own `docs/status/<lane>.md`.
- Need something from another lane? Don't build it yourself. Code against the types in `@dibs/shared` (stub it locally if you must), and add it under **Needs from other lanes** in your status file so your human can ask.
- **Contract zone**: `packages/shared/`, the tables and reducer signatures in `spacetime/src/index.ts`, root config (`package.json`, `tsconfig.base.json`, `package-lock.json`), `CLAUDE.md`, `docs/plan.md`, `docs/workflow.md`, `.claude/`, `.github/`. Change these only in a small, separate PR, and tell your human so they can warn the team. After changing the module, run `npm run generate` and commit the regenerated bindings in the same PR.
- Never hand-edit `packages/shared/src/module_bindings/`; it's generated.
- Never hand-edit `package-lock.json`. Add dependencies with `npm install <pkg> -w <your workspace>`.

## Shared context

- `docs/status/<lane>.md` is each lane's live status: now, next, blockers, needs. Keep yours current and short; never edit another lane's.
- `docs/decisions/` holds one file per decision that affects other lanes. Add new files; don't rewrite old ones.
- `/sync` brings your branch up to date with main. `/handoff` updates your status file, syncs, pushes, and preps a PR.

## Commands

```bash
npm install              # once, and after pulling a lockfile change
npm run typecheck        # all workspaces; run before every PR
npm run build:plugin     # bundle plugin/dist (dev: npm run dev:plugin)
npm run dev:dashboard    # http://localhost:3001 (3000 is local SpacetimeDB)
npm run generate         # regenerate packages/shared bindings after changing spacetime/
spacetime start          # local SpacetimeDB on :3000, then npm run publish:local
npm run format           # prettier, so formatting never causes conflicts
claude --plugin-dir ./plugin   # try the plugin in a Claude Code session
```

## Conventions

- TypeScript only, ESM, Node 22+. Prettier formats everything; don't hand-format.
- Workspace packages export TypeScript source; esbuild (plugin) and Next (dashboard) compile it.
- The plugin reads config from `~/.dibs/.env` (see `.env.example`), not from a project `.env`.
- SpacetimeDB reducers must stay deterministic: no network calls, no `Date.now()`, no randomness. Use `ctx.timestamp`. Throw `SenderError` for expected failures.
- Out of scope for the hackathon: Cursor support, auth, CRDTs, automatic merge resolution, more than 2–3 agents. Codex only as a stretch after about H22.

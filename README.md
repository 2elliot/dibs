# dibs

Your team's coding agents have no idea what each other are doing. You find out you overlapped at merge time, after two agents built the same thing twice or built pieces that don't fit.

dibs lets those agents talk to each other in realtime. Each agent says what it's building before it starts, and if two agents are working on the same thing, dibs catches it even when they describe it differently. Whoever called dibs first builds it. The other agent sends over what it needs and keeps building against a placeholder, and tests check that the real version does what was asked.

It's a Claude Code plugin with a shared SpacetimeDB backend and a live dashboard. Built at CalHacks.

## Layout

```text
spacetime/        SpacetimeDB module: tables and transactional reducers
packages/shared   generated SpacetimeDB bindings + operation types (the contract)
packages/core     embeddings, overlap judge, contracts, stubs, tests
plugin/           the Claude Code plugin: MCP tools, enforcement hooks, agent skill
dashboard/        Next.js live view
demo/             the study-group app the agents work on in the demo
docs/             plan, tracks, pitch, team workflow, per-lane status, decisions
```

## Quickstart

```bash
npm install
npm run typecheck
npm run build:plugin
```

- **Try the plugin:** copy `.env.example` to `~/.dibs/.env`, fill it in, then run `claude --plugin-dir ./plugin`.
- **Run the dashboard:** copy `dashboard/.env.example` to `dashboard/.env.local`, then `npm run dev:dashboard` (port 3001).
- **Run SpacetimeDB locally:** `spacetime start`, then `npm run publish:local`, and point both env files at `http://localhost:3000`.
- **Install from GitHub:** `/plugin marketplace add 2elliot/dibs`, then `/plugin install dibs@dibs`. This needs a committed `plugin/dist`; see `docs/status/plugin.md`.

## Working on dibs

Read [docs/workflow.md](docs/workflow.md) first. Short version: one lane each, small `<lane>/<topic>` branches merged often, change the contract (`spacetime/` schema and `packages/shared`) only on purpose, and keep `docs/status/<lane>.md` current.

# dibs

Coordination for a team whose developers each run a different coding agent (Claude Code, Codex, Droid) on their own laptop. Each agent publishes a plan; dibs finds conflicts git can't see (in the agents' assumptions), gets the affected agents to a handshake on one contract, and proves with a hidden test that the combined code works. CalHacks build.

- `docs/plan.md`: the full design (read the sections your issue names).
- `docs/API.md`: the frozen module interface. **Read it before writing code that touches the database.**
- `packages/protocol`: frozen enums, payload types, local file formats and JSON Schemas.

## Layout and owners

Work is split into five GitHub issues. Each owns its paths; only edit yours.

| Issue       | Owns                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------- |
| 1 State     | `spacetime/`, `packages/bindings/`, `packages/cli/` (except the dispatcher's command table) |
| 2 Agents    | `packages/bridge/` (MCP bridge, `dibs-hook.mjs`, `dibs session`, provider configs)          |
| 3 Worker    | `apps/worker/`, `infra/`                                                                    |
| 4 Bench     | `fixture/`, `bench/`, `packages/verifier/`                                                  |
| 5 Dashboard | `apps/dashboard/`                                                                           |

**Frozen (contract zone):** `docs/API.md`, `packages/protocol/`, root `package.json` scripts, `tsconfig.base.json`, this file. Don't edit them in a feature branch. Need a change? Write it under **Needs** in your PR description and work around it locally.

Add dependencies only to your own workspace: `npm install <pkg> -w <your workspace>`. Lockfile conflicts between branches are expected; resolve them by taking the base lockfile and re-running `npm install`.

## Shared machine resources (several agents run on this machine at once)

- **Local SpacetimeDB:** one server is already running at `http://127.0.0.1:3000`. Don't stop or restart it. If it's down, start your own on your issue's port range with `--data-dir` in your worktree.
- **CLI:** `spacetime` (on PATH, or `$LOCALAPPDATA/SpacetimeDB/spacetime.exe`), version 2.13. The default server is `local`. **Never publish to Maincloud.**
- **Your database names** start with `dibs-i<issue>-`, e.g. `dibs-i2-test`. Never touch another issue's databases.
- **Ports:** issue N uses 41N0–41N9 (issue 3 → 4130–4139). SpacetimeDB is 3000.
- **`DIBS_HOME`:** tests set it to a temp directory. Never write to the real `~/.dibs` from tests.
- Publishing: `spacetime publish --server local --module-path spacetime --yes <db>` (add `--delete-data` to reset). `spacetime call <db> <reducer_name> <json args…>`, `spacetime sql <db> "<query>"` (snake_case names), `spacetime generate --lang typescript --out-dir packages/bindings/src --module-path spacetime --yes`.

## Commands

```bash
npm install                   # once per worktree
npm run typecheck             # all workspaces; must pass before you push
npm test                      # all workspaces (vitest)
npm run dibs -- <command>     # the dibs CLI (tsx); see packages/cli/src/dibs.ts
npm run format                # prettier
```

## Conventions

- TypeScript, ESM, Node ≥ 22. Workspace packages export TypeScript source (`"exports": {".": "./src/index.ts"}`); run with `tsx`, bundle with esbuild where startup time matters (the bridge).
- Windows is a first-class target: no bash-only scripts in product code, exec-form hooks (`"command": "node", "args": [...]`), forward-slash paths in configs, LF line endings.
- Module reducers stay deterministic: `ctx.timestamp`, `ctx.random`, `SenderError` for expected failures.
- Never commit secrets, tokens, `.env` files, the plaintext oracle or `bench/results/`.
- Agents' MCP output goes to stdout only through the MCP SDK; all logging goes to stderr.
- Don't create GitHub repositories, deploy to Azure, or publish anything outside this machine. Those are human steps; list them in your PR.

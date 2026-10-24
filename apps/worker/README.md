# @dibs/worker

The analysis worker and the app's single HTTP surface. It leases analysis jobs from SpacetimeDB,
asks Claude where the agents' plans conflict, validates the result, and submits proposals — and it
serves the dashboard, `/config.json` and the health endpoints from one Azure Container App.

Owns: `apps/worker/`, `infra/`. Reads but never edits the frozen contract (`docs/API.md`,
`packages/protocol`). See `docs/plan.md` §6 (analysis) and §8 (deployment).

## Layout

```
src/
  config.ts              env -> WorkerConfig; publicConfig() for /config.json
  model/
    types.ts             ModelClient interface
    anthropic.ts         real client: streamed forced-tool call, FINDINGS_SCHEMA structured output
    fake.ts              replays recorded responses (tests; no key needed)
  analysis/
    prompt.ts            THE PRODUCT: AnalysisInput -> request (see prompt.design.md)
    validate.ts          local pre-check mirroring reducer rules 3, 5, 8
    analyze.ts           one call + validate; budgeted single retry
  http/
    health.ts            mutable health state
    server.ts            /health/live, /health/status, /config.json, dashboard static + SPA fallback
  worker/
    db.ts                DibsDb interface (the module slice the worker needs)
    loop.ts              lease -> analyze -> submit/fail; one call per lobby; heartbeat
    fake-db.ts           in-memory DibsDb for tests
  cli/analyze.ts         dry-run: print the prompt (+ findings with a key or --fake)
  index.ts               entry: starts the HTTP server; loop is wired in Phase B
test/                    vitest unit tests + S2-style fixtures
```

## Commands

```bash
npm run typecheck -w @dibs/worker
npm test -w @dibs/worker
# Dry-run the prompt on a fixture (no key needed):
npm run analyze -w @dibs/worker -- apps/worker/test/fixtures/bearer-vs-cookie.json
# Replay the fixture's recorded findings end-to-end:
npm run analyze -w @dibs/worker -- apps/worker/test/fixtures/bearer-vs-cookie.json --fake
# Serve locally (loop idle without SPACETIME_TOKEN):
PORT=4130 npm run start -w @dibs/worker
```

## The real Anthropic path

This dev machine has **no `ANTHROPIC_API_KEY`**, so tests use the fake. The real client
(`model/anthropic.ts`) compiles and is used automatically when the key is set. Env:

| Var                                                  | Required          | Default                    | Notes                               |
| ---------------------------------------------------- | ----------------- | -------------------------- | ----------------------------------- |
| `ANTHROPIC_API_KEY`                                  | for real analysis | —                          | Secret; never logged.               |
| `ANTHROPIC_MODEL`                                    | no                | `claude-3-7-sonnet-latest` | Confirm the id at 08:45 (plan §1).  |
| `PORT`                                               | no                | `8080`                     | Use `4130` locally (issue 3 range). |
| `SPACETIME_URI` / `SPACETIME_DB` / `SPACETIME_TOKEN` | Phase B           | local dev DB               | Loop stays idle without the token.  |

The model call uses streaming + a forced tool whose `input_schema` is `FINDINGS_SCHEMA`, a 90 s
timeout, and one retry only if a full window still fits before the lobby's `fallbackAtUs`. Latency and
token usage are logged per call; the prompt and source are never logged.

## Phases

- **A (done):** prompt builder, validator, fake model, HTTP server, dry-run tool, Dockerfile, unit
  tests — all against `packages/protocol` + `docs/API.md`.
- **B (after issue 1 `[module-ready]`):** `git merge issue/1-state`, implement `DibsDb` over
  `@dibs/client`, wire `WorkerLoop` in `index.ts`, and verify against a local published module:
  a queued job becomes a proposal; a `compatible` fixture yields an `aligned` contract; a stale
  `inputKey` is rejected and the job re-leased; a killed worker's lease is re-leased by a second
  instance.

## Tuning disclosure

Prompts are tuned only on S2-style dev plans, the S2 pilot and the dry runs; S1 and N are held out
(plan §6.7).

## Human / not-in-scope steps

Azure login + deploy, the Anthropic API key, and claiming the worker invite on Maincloud. Commands
are in `infra/deploy.md`; do not run them from the agent.

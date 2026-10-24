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
    loop.ts              lease -> analyze -> submit/fail; queued jobs leased on sight, 15 s
                         rescan for expired leases; one call per lobby; heartbeat
    fake-db.ts           in-memory DibsDb for tests
  cli/analyze.ts         dry-run: print the prompt (+ findings with a key or --fake)
  index.ts               entry: HTTP server + real worker loop with initial connection retry
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

| Var                                                  | Required          | Default             | Notes                                                    |
| ---------------------------------------------------- | ----------------- | ------------------- | -------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                  | for real analysis | —                   | Secret; never logged.                                    |
| `ANTHROPIC_MODEL`                                    | no                | `claude-sonnet-4-6` | Override with a model supporting forced strict tool use. |
| `PORT`                                               | no                | `8080`              | Use `4130` locally (issue 3 range).                      |
| `SPACETIME_URI` / `SPACETIME_DB` / `SPACETIME_TOKEN` | Phase B           | local dev DB        | Loop stays idle without the token.                       |
| `DIBS_LOBBY_ID`                                      | no                | unset               | Default dashboard lobby; otherwise open `?lobby=<id>`.   |

The model call uses streaming and a strict forced tool with `FINDINGS_SCHEMA`. SDK retries are
disabled so the worker owns the retry budget. One retry is allowed only if at least 90 seconds
remain before fallback, measured after the first attempt. The frozen database lease lasts 60 seconds,
so production worker model work (including retries) has a shared 54-second deadline; 6 seconds remain
for recording success/failure before expiry. The standalone dry-run tool retains the 90-second cap.
Invalid output fails the job rather than silently submitting empty findings. Latency and token usage
are logged; prompts and source are never logged.

`/config.json` preserves the protocol's `dbUri`/`dbName` and also supplies the dashboard's `uri`/`db`
aliases and optional `lobby`. Initial connection failures retry with capped exponential backoff;
established connections use the shared client's automatic reconnect. Disconnected cached rows do
not count as a connected database in `/health/status`.

## Phases

- **A (done):** prompt builder, validator, fake model, HTTP server, dry-run tool, Dockerfile, unit
  tests — all against `packages/protocol` + `docs/API.md`.
- **B (done, with issue 1 integrated):** `DibsDb` uses `@dibs/client`, `WorkerLoop` is wired in
  `index.ts`, and the live suite verifies against a local published module:
  a queued job becomes a proposal; a `compatible` fixture yields an `aligned` contract; a stale
  `inputKey` is rejected and the job re-leased; a killed worker's lease is re-leased by a second
  instance.

See [VERIFY.md](VERIFY.md) for automated regression and live database commands. A Docker daemon and
a real Anthropic key are needed for their respective smoke checks; fake/model-protocol tests do not
claim to assess live model quality.

## Tuning disclosure

Prompts are tuned only on S2-style dev plans, the S2 pilot and the dry runs; S1 and N are held out
(plan §6.7).

## Human / not-in-scope steps

Azure login + deploy, the Anthropic API key, and claiming the worker invite on Maincloud. Commands
are in `infra/deploy.md`; do not run them from the agent.

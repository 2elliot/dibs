# Worker verification

Run from the repository root with Node 24, npm, and SpacetimeDB CLI 2.13.

## Fast checks

```sh
npm ci
npm run typecheck
npm test -w @dibs/worker
npm run analyze -w @dibs/worker -- apps/worker/test/fixtures/bearer-vs-cookie.json --fake
```

The worker tests include a streamed response through the real Anthropic SDK with mocked HTTP,
strict tool-schema settings, disabled SDK retries, current-clock fallback checks, lease-wide
deadlines, malformed findings, invalid citations, unowned requirements, startup recovery and runtime
dashboard config. They make no paid model calls. The live suite is skipped unless explicitly enabled.

## Live database checks

Leave the shared local server running. These commands create a **fresh `dibs-i3-test-*` database**;
they never publish to Maincloud or touch another issue's databases.

PowerShell:

```powershell
$env:DIBS_WORKER_LIVE_URI = 'http://127.0.0.1:3000'
npm test -w @dibs/worker -- test/live.test.ts
Remove-Item Env:DIBS_WORKER_LIVE_URI
```

POSIX:

```sh
DIBS_WORKER_LIVE_URI=http://127.0.0.1:3000 npm test -w @dibs/worker -- test/live.test.ts
```

The suite publishes a private copy of the real module under `apps/worker/.live-module/` (ignored).
Only that copy's debounce and lease are shortened to 0.1 s and 2 s; production protocol/timing is
unchanged. It creates its own admin, two agents and worker identities in memory and disconnects all
clients afterward. No tokens are written to the real DIBS_HOME.

Checks:

- Queued job -> proposal with real citations and reducer-computed required parties/deliveries.
- Compatible plans -> aligned contract without a proposal.
- Stale inputKey -> rejected; the same expired job is re-leased and finishes with attempts = 2.
- Worker disconnect after leasing -> a fresh worker connection re-leases and completes the job.
- Invalid citations -> failed job and deterministic notices, with no proposal.
- Disconnected adapter -> health reports disconnected rather than trusting cached rows.

The fast suite independently verifies the production 60 s lease: all model work, including a retry,
is bounded to 54 s, reserving 6 s for the 5 s reducer call and scheduling margin. A hung model is
aborted and fail_job is invoked while the lease remains valid. No schema/reducer change is needed.

## Manual harness

For an already seeded local lobby with a worker token, set SPACETIME_URI, SPACETIME_DB and
SPACETIME_TOKEN, then use:

```sh
npm run verify:live -w @dibs/worker -- analyze --relation conflict
npm run verify:live -w @dibs/worker -- stale-input-key
npm run verify:live -w @dibs/worker -- crash-after-lease
```

The stale-input mode must observe an actual rejection. The crash mode exits without submitting.
For production leases, wait more than 60 seconds before running analyze again. Inspect the job,
proposal, contract and delivery rows; an exited process alone is not evidence of success.

## HTTP and container

```sh
PORT=4130 DIBS_LOBBY_ID=1 npm run start -w @dibs/worker
curl http://localhost:4130/health/live
curl http://localhost:4130/config.json
docker build -f infra/Dockerfile --platform linux/amd64 -t dibs:verify .
docker run --rm -p 4130:8080 -e DIBS_LOBBY_ID=1 dibs:verify
```

Without credentials the HTTP server runs with analysis disabled. Runtime config includes both
dbUri/dbName and uri/db, plus lobby when DIBS_LOBBY_ID is set. Otherwise use ?lobby=<id> in the
dashboard URL. Docker and a real Anthropic request remain separate environment-dependent checks.

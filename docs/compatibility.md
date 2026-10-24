# Compatibility results

## Worker review fixes — 2026-10-24

- Integrated state dependency `181bd874b40b60cf378a799da40cfec0f73ce3e2` into the worker branch;
  regenerated and committed the npm workspace lockfile. No frozen API/protocol/schema changes.
- Windows, Node **24.22.1**, SpacetimeDB **2.13.0**.
- Clean `npm ci` PASS; workspace `npm run typecheck` PASS.
- Worker tests: **47/47 PASS**, including **6 live database checks** on fresh `dibs-i3-test-*`
  databases at `http://127.0.0.1:3000`. The existing shared server was not restarted.
- Live checks: proposal/citations/required parties/deliveries; aligned contract without voting;
  rejected stale input followed by re-lease; new worker recovery after lease expiry;
  invalid-citation failure notices; disconnected-cache health reporting.
- Live tests shorten debounce/lease only in an ignored private module copy. Production 60-second
  lease budgeting is independently covered with fake timers: 54 seconds across model attempts,
  reserving 6 seconds for reducer completion. The standalone analysis timeout remains 90 seconds.
- Shared client tests: **4/4 PASS**. Real Anthropic SDK streaming/schema/error behavior is tested
  with mocked HTTP; no paid model request was sent.
- Actual worker entry-point HTTP smoke PASS: `/health/live`, `/health/status`, and `/config.json`
  (protocol names plus dashboard aliases and configured lobby; no credentials in config).
- Docker executable/daemon unavailable: image build not run. Azure deployment and a real-key model
  smoke remain human/environment checks. This does not claim to measure live model quality.

## Phase B worker — 2026-10-24

- SpacetimeDB CLI: **2.13.0** (spacetimedb-lib 2.13.0; commit `08e1aba133671f9c631c6e70133a82faa0e7b283`).
- Local server: `http://127.0.0.1:3000`; deterministic fake model via `verify:live`.
- Verified `issue/3-worker` at `f23adca84e614f4c071f3ede1937d3f3942c5eb3`
  merged with `issue/1-state` at `181bd874b40b60cf378a799da40cfec0f73ce3e2`.
- Sanity: `npm run typecheck` PASS; `npm test -w @dibs/worker` PASS (27 tests, 6 files).

| Check                          | Result | Observed SQL evidence                                                                                                                                                                                   |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — queued → proposal          | PASS   | Job 1: `queued` → `done`, attempts 1. Proposal 1: `auth.session`, `proposed`, revision 1; required parties `[2,3,4]`, citations `[1,2,3]`; proposal deliveries to 2, 3, 4.                              |
| B — compatible → aligned       | PASS   | Job 1: `done`, attempts 1. Contract `auth.session`: source `aligned`, revision 1. No proposal or response rows; three aligned deliveries.                                                               |
| C — stale inputKey → re-lease  | PASS   | Harness reported `submitAnalysis 1 -> error: stale inputKey`. Job 1 remained `leased`, attempts 1, with no proposal. After 65 seconds, the same job was `done`, attempts 2, with proposal 1 `proposed`. |
| D — simulated crash → re-lease | PASS   | After `crash-after-lease`, job 1 was `leased`, attempts 1, lease expiry `1792861209394252`, with no proposal. After 65 seconds, a fresh run completed job 1: `done`, attempts 2, proposal 1 `proposed`. |

Each check used its own fresh `dibs-i1-verify-*` local database and was completed
within the seeded lobby's 15-minute limit. The documented commands were run in order;
PowerShell helpers used isolated `DIBS_HOME` directories under the verification
workspace, and each 65-second wait was split into 35 and 30 seconds. All harness
runs exited 0. This verifies live database/worker integration with a fake model;
it does not assess a real model's analysis quality. No Maincloud publishing occurred.

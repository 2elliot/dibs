# Compatibility results

## Phase B worker — 2026-10-24

- SpacetimeDB CLI: **2.13.0** (spacetimedb-lib 2.13.0; commit `08e1aba133671f9c631c6e70133a82faa0e7b283`).
- Local server: `http://127.0.0.1:3000`; deterministic fake model via `verify:live`.
- Verified `issue/3-worker` at `f23adca84e614f4c071f3ede1937d3f3942c5eb3`
  merged with `issue/1-state` at `181bd874b40b60cf378a799da40cfec0f73ce3e2`.
- Sanity: `npm run typecheck` PASS; `npm test -w @dibs/worker` PASS (27 tests, 6 files).

| Check | Result | Observed SQL evidence |
| --- | --- | --- |
| A — queued → proposal | PASS | Job 1: `queued` → `done`, attempts 1. Proposal 1: `auth.session`, `proposed`, revision 1; required parties `[2,3,4]`, citations `[1,2,3]`; proposal deliveries to 2, 3, 4. |
| B — compatible → aligned | PASS | Job 1: `done`, attempts 1. Contract `auth.session`: source `aligned`, revision 1. No proposal or response rows; three aligned deliveries. |
| C — stale inputKey → re-lease | PASS | Harness reported `submitAnalysis 1 -> error: stale inputKey`. Job 1 remained `leased`, attempts 1, with no proposal. After 65 seconds, the same job was `done`, attempts 2, with proposal 1 `proposed`. |
| D — simulated crash → re-lease | PASS | After `crash-after-lease`, job 1 was `leased`, attempts 1, lease expiry `1792861209394252`, with no proposal. After 65 seconds, a fresh run completed job 1: `done`, attempts 2, proposal 1 `proposed`. |

Each check used its own fresh `dibs-i1-verify-*` local database and was completed
within the seeded lobby's 15-minute limit. The documented commands were run in order;
PowerShell helpers used isolated `DIBS_HOME` directories under the verification
workspace, and each 65-second wait was split into 35 and 30 seconds. All harness
runs exited 0. This verifies live database/worker integration with a fake model;
it does not assess a real model's analysis quality. No Maincloud publishing occurred.

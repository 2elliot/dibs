# Phase B — live-DB verification (issue 3 worker)

Hand this to someone with the **`spacetime` CLI**. It verifies the worker's four Phase B behaviors
against a **local** SpacetimeDB using a deterministic **fake model** (no `ANTHROPIC_API_KEY`, no cost,
repeatable). The harness acts as the `worker` participant via its token — something raw `spacetime
call` cannot do, because reducers authorize by `ctx.sender` role.

> All of this is **local only**. Never publish to Maincloud. (`dibs sim` enforces a loopback URI.)

## 0. Prerequisites

- `spacetime` CLI **2.13**, logged in locally (`spacetime login`), with a local server at
  `http://127.0.0.1:3000`. If it isn't running: `spacetime start` (leave it running).
- Node ≥ 22.
- A worktree that contains **both issue 1 and issue 3** (issue 3's code imports `@dibs/client`,
  which issue 1 owns). From the repo root:
  ```bash
  git checkout issue/3-worker
  git merge issue/1-state --no-edit      # or run after both are merged into real
  npm install
  npm run typecheck && npm test -w @dibs/worker   # sanity: should pass
  ```

## 1. Seed helper

Each check runs in its own fresh database + `DIBS_HOME` so nothing leaks between checks. Paste this
helper into the shell once:

```bash
export SPACETIME_URI=http://127.0.0.1:3000

seed() {                       # seed <scenario> <db>   e.g. seed s2 dibs-i1-verify-conflict
  rm -rf ~/.dibs-verify
  export DIBS_HOME=~/.dibs-verify
  npm run dibs -- sim --worker none --stop-after plans --scenario "$1" --db "$2"
  export SPACETIME_DB="$2"
  export SPACETIME_TOKEN="$(cat "$DIBS_HOME"/worker-*/token)"
  echo "seeded $2 ; worker token loaded"
}

sql() { spacetime sql --server "$SPACETIME_URI" "$SPACETIME_DB" "$1"; }   # columns are snake_case
```

`dibs sim --worker none --stop-after plans` publishes the module to the given `dibs-i1-*` db,
bootstraps invites, has the canned agents publish plans, and **leaves exactly one `queued` job** — no
worker runs. It saves the worker's token under `$DIBS_HOME/worker-<run>/token`.

Sanity after any seed:

```bash
sql "SELECT id, state, input_key FROM job"     # expect one row, state = queued
```

---

## 2. Check A — queued → proposal

A conflict finding must become a `proposal` with reducer-computed required parties, and the job must
finish.

```bash
seed s2 dibs-i1-verify-conflict
npm run verify:live -w @dibs/worker -- analyze --relation conflict

sql "SELECT id, key, state, revision FROM proposal"
sql "SELECT required_party_ids, cited_item_ids FROM proposal"
sql "SELECT id, state, attempts FROM job"
sql "SELECT kind, target_id FROM delivery WHERE kind = 'proposal'"
```

**Pass when:** a `proposal` row exists with `state = proposed`, non-empty `cited_item_ids` and
`required_party_ids`; the `job` is `state = done`; and `proposal` deliveries were written to the
required parties.

---

## 3. Check B — compatible → aligned

A `compatible` finding must write an `aligned` contract with **no** proposal/vote.

```bash
seed aligned dibs-i1-verify-aligned
npm run verify:live -w @dibs/worker -- analyze --relation compatible

sql "SELECT key, source, revision FROM contract"
sql "SELECT id, state FROM proposal"
sql "SELECT id, state FROM job"
sql "SELECT kind FROM delivery WHERE kind = 'aligned'"
```

**Pass when:** a `contract` row exists with `source = aligned`; there is **no** `proposal`; the `job`
is `done`; and `aligned` deliveries were written.

---

## 4. Check C — stale inputKey rejected → re-leased

A submit whose `inputKey` no longer matches must be rejected (rule 2); the job stays `leased` and is
re-leased after the lease expires, then completes.

```bash
seed s2 dibs-i1-verify-stale

# C1: lease, then submit with a deliberately stale inputKey -> module rejects.
npm run verify:live -w @dibs/worker -- stale-input-key
sql "SELECT id, state, attempts FROM job"      # expect state = leased (NOT done), attempts = 1
sql "SELECT id, state FROM proposal"           # expect no proposal yet

# C2: wait for the 60 s lease to expire, then a normal analyze re-leases the SAME job.
sleep 65
npm run verify:live -w @dibs/worker -- analyze --relation conflict
sql "SELECT id, state, attempts FROM job"      # expect state = done, attempts = 2
sql "SELECT id, state FROM proposal"           # expect a proposal now
```

**Pass when:** after C1 the job is still `leased` with no proposal; after C2 `attempts` incremented to
2, the job is `done`, and a proposal exists.

---

## 5. Check D — killed worker → re-leased by a second instance

A worker that dies mid-lease must not strand the job: after the lease expires another instance
re-leases and completes it.

```bash
seed s2 dibs-i1-verify-crash

# D1: lease then exit before submitting (simulated crash).
npm run verify:live -w @dibs/worker -- crash-after-lease
sql "SELECT id, state, attempts, lease_expires_us FROM job"   # expect leased, attempts = 1

# D2: after the lease expires, a fresh run re-leases and finishes the job.
sleep 65
npm run verify:live -w @dibs/worker -- analyze --relation conflict
sql "SELECT id, state, attempts FROM job"       # expect done, attempts = 2
sql "SELECT id, state FROM proposal"            # expect a proposal
```

**Pass when:** after D1 the job is `leased` (attempts 1) and no proposal; after D2 it is `done`
(attempts 2) with a proposal — proving the expired lease was reclaimed.

---

## 6. Notes & cleanup

- The seeded lobby has real timers: `fallback` at +6 min and `stop` at +15 min from `start_lobby`.
  Finish each check well inside 15 min; the two `sleep 65` steps are fine.
- Record results in `docs/compatibility.md` (pass/fail per check, `spacetime` version, date).
- Optional container check (needs Docker): `DOCKER_BUILDKIT=1 docker build -f infra/Dockerfile
--platform linux/amd64 -t dibs:verify .` then `docker run --rm -p 4130:8080 dibs:verify` and
  `curl -s localhost:4130/health/live && curl -s localhost:4130/config.json`.
- Cleanup:
  ```bash
  for db in dibs-i1-verify-conflict dibs-i1-verify-aligned dibs-i1-verify-stale dibs-i1-verify-crash; do
    spacetime publish --server "$SPACETIME_URI" --module-path spacetime --yes --delete-data "$db" </dev/null || true
  done
  rm -rf ~/.dibs-verify
  ```

## What each check exercises in the worker

| Check | Worker code                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A, B  | `SpacetimeDibsDb.nextLeasableJob` → `leaseJob` → `buildAnalysisInput` (`mapping.ts`) → `validate` → `submitAnalysis`, via `WorkerLoop.tick()` |
| C     | `submitAnalysis` stale-`inputKey` path + `pickLeasableJob` returning the expired lease                                                        |
| D     | `pickLeasableJob` reclaiming a `leased` job past `leaseExpiresUs`, fresh `randomUUID` lease                                                   |

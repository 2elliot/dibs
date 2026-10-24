# dibs module API v1

The contract between the SpacetimeDB module (issue 1) and everything that talks to it: the bridge (issue 2), the worker (issue 3), the verifier (issue 4) and the dashboard (issue 5). `docs/plan.md` §4 is the design; this file is the frozen interface, including five fixes from the design review (marked **[fix]**). Payload types and enums are in `packages/protocol`.

**Frozen.** Issues 2–5 code against this. If you need a change, put it under "Needs" in your PR; don't edit `spacetime/`, `packages/bindings/` or `packages/protocol/`.

## Conventions

- SpacetimeDB **2.13**, TypeScript module, `import { schema, table, t, SenderError } from "spacetimedb/server"`.
- Table and reducer names below are the **database names** (snake_case). Generated client code uses camelCase: `conn.db.planItem`, `conn.reducers.publishPlan`, columns `lobbyId`.
- Ids are `u32` autoinc. Times are `…Us: u64` microseconds from `ctx.timestamp`; `0` means "not yet". Convert every u64 to `number` before JSON.
- No composite keys: unique string `slot` columns stand in. Always `find` before `insert`; a duplicate insert aborts the whole reducer.
- Reducers return nothing. Clients `await` the call (rejects with the `SenderError` text), then read the committed result from their subscription, keyed by `requestId` where there is one.
- Every reducer appends at least one `event` row (types in `EVENT_TYPES`).
- Deterministic: no network, no `Date.now()`, no `Math.random()`. Use `ctx.timestamp` and `ctx.random`.
- `client_connected` / `client_disconnected` never throw: dashboards and unclaimed clients connect too.

## Tables

Public unless marked private. Public visibility is not access control; every write goes through a reducer.

| Table                                             | Columns                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin` (private)                                 | `identity` (pk)                                                                                                                                                                                                                                                                              |
| `invite` (private)                                | `code` (pk), `name`, `provider`, `role`, `used: bool`                                                                                                                                                                                                                                        |
| `participant`                                     | `id` (pk), `identity` (unique), `name` (unique), `provider`, `role`, `online: bool`, `buildHash`, `currentLobbyId: option<u32>`                                                                                                                                                              |
| `lobby`                                           | `id` (pk), `scenario`, `mode`, `baseSha`, `vocabulary: string[]` (keys), `vocabularyJson` (the `VocabularyEntry[]`), `charter`, `buildHash`, `state`, `analyzeAnywayFired: bool`, `createdAtUs`, `startedAtUs`, `fallbackAtUs`, `endsAtUs`                                                   |
| `plan`                                            | `id` (pk), `lobbyId` (idx), `participantId` (idx), `revision: u32`, `goal`, `notes`, `requestId` (idx), `current: bool`, `createdAtUs`                                                                                                                                                       |
| `plan_item`                                       | `id` (pk), `planId` (idx), `lobbyId` (idx), `participantId`, `kind` (`produces`/`requires`), `key`, `text`, `current: bool`                                                                                                                                                                  |
| `message`                                         | `id` (pk), `lobbyId` (idx), `fromId`, `to` (`claude`/`codex`/`droid`/`all`), `text`, `requestId`, `createdAtUs`                                                                                                                                                                              |
| `job`                                             | `id` (pk), `slot` (unique, `"<lobbyId>"`), `lobbyId` (idx), `kind`, `state`, `inputKey`, `leaseToken`, `leaseExpiresUs`, `attempts: u32`, `calls: u32`, `error`, `updatedAtUs`                                                                                                               |
| `job_timer` (private, scheduled → `promote_job`)  | `scheduledId: u64` (pk autoinc), `scheduledAt`, `jobId`, `inputKey`                                                                                                                                                                                                                          |
| `lobby_timer` (private, scheduled → `lobby_tick`) | `scheduledId: u64` (pk autoinc), `scheduledAt`, `lobbyId`, `action`                                                                                                                                                                                                                          |
| `proposal`                                        | `id` (pk), `slot` (unique: `"<lobbyId>/<key>"` while open, `"closed/<id>"` after), `lobbyId` (idx), `key`, `revision: u32`, `relation`, `contractText`, `rationale`, `citedItemIds: u32[]`, `requiredPartyIds: u32[]` (frozen at creation), `state`, `inputKey`, `createdAtUs`, `closedAtUs` |
| `response`                                        | `id` (pk), `lobbyId` (idx), `proposalId` (idx), `revision`, `participantId`, `decision`, `reason`, `requestId`, `createdAtUs`                                                                                                                                                                |
| `contract`                                        | `id` (pk), `lobbyId` (idx), `key`, `revision: u32`, `text`, `source` (`agreed`/`aligned`), `proposalId: option<u32>`, `basisItemIds: u32[]` **[fix]**, `current: bool`, `createdAtUs`                                                                                                        |
| `delivery`                                        | `id` (pk), `lobbyId` (idx), `targetId` (idx), `kind`, `refId`, `summary`, `stage`, `queuedAtUs`, `receivedAtUs`, `shownAtUs`, `respondedAtUs`                                                                                                                                                |
| `event`                                           | `id` (pk), `lobbyId` (idx; 0 for global), `atUs`, `actor` (participant name or `system`), `type`, `subjectId`, `detail` (small JSON; never codes, tokens or prompts)                                                                                                                         |
| `head`                                            | `id` (pk), `lobbyId` (idx), `participantId`, `sha`, `outOfAreaFiles: string[]`, `createdAtUs`                                                                                                                                                                                                |
| `verification`                                    | `id` (pk), `lobbyId` (idx), `assembledFrom` (JSON `AssembledFrom`), `treeHash`, `mergeTreeClean: bool`, `oracleHash`, `exitCode: i32`, `passed: u32`, `total: u32`, `reportHash`, `verifierId`, `createdAtUs`                                                                                |
| `review`                                          | `id` (pk), `lobbyId` (idx), `verificationId`, `kind`, `summary`, `findings` (JSON `ReviewFindings`), `model`, `sessionId`, `createdAtUs`                                                                                                                                                     |
| `request`                                         | `requestId` (pk), `payload` (canonical JSON ≤ 4 KB), `atUs`                                                                                                                                                                                                                                  |
| `service`                                         | `name` (pk), `lastBeatUs`, `detail` (JSON)                                                                                                                                                                                                                                                   |

`current` flags: exactly one `plan` row per (lobby, participant) and one `contract` row per (lobby, key) has `current = true`; the reducer that writes a new one clears the old. Clients subscribe to `current` rows instead of computing "latest revision".

## Reducers

"Caller" is resolved from `ctx.sender` → `participant.identity`. Nothing trusts an id inside a payload.

### Bootstrap and admin

| Reducer                                                                     | Caller                              | Effect                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`                                                                      | publisher                           | Inserts `admin(ctx.sender)`. Also inserts an `invite` with role `admin`, name `admin`, and a code from `ctx.random`, readable by the owner with `spacetime sql <db> "SELECT * FROM invite"`.       |
| `create_invite(code, name, provider, role)`                                 | admin identity or admin participant | Inserts an unused invite.                                                                                                                                                                          |
| `claim_invite(code)`                                                        | anyone                              | Binds `ctx.sender` to the invite's name: creates the participant, or fails if the name is already bound to another identity. Marks the invite used. Re-claiming with the same identity is a no-op. |
| `create_lobby(scenario, mode, baseSha, vocabularyJson, charter, buildHash)` | admin                               | Inserts a lobby in `setup`. `vocabularyJson` is `VocabularyEntry[]`.                                                                                                                               |
| `start_lobby(lobbyId)`                                                      | admin                               | `state = running`, sets `startedAtUs`, `fallbackAtUs = +TIMING.fallbackSec`, `endsAtUs = +TIMING.endSec`; schedules `lobby_timer` rows for `analyze_anyway`, `fallback`, `stop`.                   |
| `stop_lobby(lobbyId)`                                                       | admin                               | `state = stopped` now (manual stop).                                                                                                                                                               |
| `mark_verified(lobbyId)`                                                    | verifier                            | `state = verified`.                                                                                                                                                                                |
| `debug_deliver(targetId, kind, summary)`                                    | admin                               | Inserts a delivery directly. For bridge and hook tests.                                                                                                                                            |

### Agents (through the bridge)

| Reducer                                                                                  | Caller                                                | Effect                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `join_lobby(lobbyId, buildHash)`                                                         | agent                                                 | Rejects a build other than `lobby.buildHash`. Sets `currentLobbyId`.                                                                                                                                                                                                                            |
| `publish_plan(requestId, goal, produces: {key, text}[], requires: {key, text}[], notes)` | agent in a running lobby                              | Validates keys against the vocabulary, ≤ `LIMITS.planItems` items, ≤ `LIMITS.textChars` each. Writes a new plan revision + items, flips `current`. In `dibs` mode: upserts the lobby's job (by `slot`) as `debouncing` with the new `inputKey`, inserts a `job_timer` at +`TIMING.debounceSec`. |
| `send_message(requestId, to, text)`                                                      | agent, `chat`/`dibs`                                  | Inserts a message and `message` deliveries to the target(s). `none` rejects.                                                                                                                                                                                                                    |
| `respond(requestId, proposalId, revision, decision, reason)`                             | required party of an open proposal                    | See rule 4. `reason` required to reject. Marks this participant's `proposal` delivery `responded`.                                                                                                                                                                                              |
| `mark_delivery(deliveryId, stage)`                                                       | the delivery's target                                 | Forward-only stage change; sets the stage's time.                                                                                                                                                                                                                                               |
| `report_head(lobbyId, sha, outOfAreaFiles)`                                              | agent (used by `dibs session` with the agent's token) | Inserts a `head`.                                                                                                                                                                                                                                                                               |

### Scheduled

| Reducer                       | Effect                                                                                                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promote_job(job_timer row)`  | `debouncing → queued` only if the job's `inputKey` still equals the timer's, **and** every agent in the lobby has a current plan or `analyzeAnywayFired`. Otherwise does nothing (a later publish or `analyze_anyway` promotes it). |
| `lobby_tick(lobby_timer row)` | `analyze_anyway`: sets `analyzeAnywayFired`; promotes a `debouncing` job. `fallback`: sends a `fallback` delivery to every agent whose keys are still `pending` or `proposed`. `stop`: `state = stopped`.                           |

### Worker

| Reducer                                                      | Caller | Effect                                                                                                                                                                                            |
| ------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lease_job(jobId, leaseToken)`                               | worker | Leases a `queued` job, or a `leased` one whose lease expired: `state = leased`, `leaseExpiresUs = now + TIMING.leaseSec`, `attempts += 1`. Rejects after `LIMITS.analysisCallsPerLobby` calls.    |
| `submit_analysis(jobId, leaseToken, inputKey, findingsJson)` | worker | Rejects a stale lease or an `inputKey` that no longer matches the lobby's current plans (rule 2). Validates `Findings` (rules 3, 5, 8). Writes proposals, contracts and deliveries. Job → `done`. |
| `fail_job(jobId, leaseToken, error)`                         | worker | Job → `failed`. Sends deterministic overlap notices for every key with both a producer and a consumer: `"auth.session: claude produces, codex requires. Compare plans with dibs_status."`         |
| `heartbeat(name, detailJson)`                                | worker | Upserts `service`. No event row.                                                                                                                                                                  |

### Verifier

| Reducer                                                                                                                  | Caller   | Effect                                            |
| ------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------- |
| `record_verification(lobbyId, assembledFrom, treeHash, mergeTreeClean, oracleHash, exitCode, passed, total, reportHash)` | verifier | Inserts a `verification`.                         |
| `record_review(lobbyId, verificationId, kind, summary, findingsJson, model, sessionId)`                                  | verifier | Inserts a `review`. Never touches `verification`. |

## `inputKey`

`"p:" + <current plan ids, ascending, comma-separated> + ";r:" + <ids of rejections not yet answered, ascending>`. It changes whenever any plan is revised or a rejection is recorded, so a stale analysis can never commit.

## What `submit_analysis` writes, per finding

| Relation                              | Writes                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conflict`, `dependency`, `duplicate` | A `proposal` (revision 1, or the open one's revision + 1 for a `revise` job) with `requiredPartyIds` computed by the reducer, and a `proposal` delivery to each required party. |
| `compatible`                          | An `aligned` contract (no vote) and an `aligned` delivery to everyone with an item on the key.                                                                                  |
| `unowned`                             | A `notice` delivery to every agent in the lobby.                                                                                                                                |

## Rules (issue 1 writes one test per rule against a local server)

1. **Sender and scope.** Callers act only as their own participant, inside their current lobby. Wrong role, wrong lobby or unknown sender → `SenderError`.
2. **Stale analysis.** `submit_analysis` is rejected if the lease token is wrong, the lease expired, or `inputKey` doesn't match the lobby's current one.
3. **Required parties** = every participant with a current item (produces or requires) on the key, computed by the reducer and frozen on the proposal. The model's opinion is ignored. Cited item ids must exist in the lobby's current items, or the finding is dropped.
4. **Agreement.** One open proposal per key (`slot`). It's `accepted` only when every required party has accepted that same revision; then an `agreed` contract is written (`basisItemIds` = the proposal's cited items), deliveries of kind `contract` go to everyone with an item on the key, and the slot closes. On the first rejection, the lobby's **same job row** is re-queued as `kind: revise` with a new `inputKey`. A second rejection of the same key → `escalated`, with `escalated` deliveries to the required parties.
5. **Supersede.** Only open proposals can be superseded, and only when the text of a cited `(participant, key)` item changes. Re-publishing identical text changes nothing.
6. **Idempotency.** Same `requestId` + same canonical payload → no-op. Same `requestId` + different payload → `SenderError`.
7. **Modes and roles.** `none` and `chat` never create jobs or proposals. `none` rejects messages. Only the verifier role writes `verification`/`review`; only the worker role touches jobs.
8. **Agreed keys stay agreed [fix].** A finding on a key with a current `agreed` contract is ignored unless it cites at least one item that isn't in the contract's `basisItemIds` and whose text differs from the basis item for the same participant. This stops re-handshakes when an agent re-publishes its plan to match the contract, and still catches a late planner who disagrees. An `aligned` contract never replaces an `agreed` one.
9. **Deliveries.** Only the target can move a delivery, and only forward.

## Key status and phase (computed by the bridge for `dibs_status`, and the dashboard)

**Phase:** `waiting_for_peers` while the job is `debouncing`; `analyzing` while it's `queued` or `leased`; `ready` once it's `done` or `failed`, or there's no job.

**Key status**, for each key the caller has an item on:

- While the phase isn't `ready`: `pending`.
- Otherwise, the first that applies: current contract `agreed` → `agreed`; current contract `aligned` → `aligned`; open proposal → `proposed`; escalated proposal → `escalated`; else `clear`.

## Delivery summaries

The reducer writes `summary` as facts, not commands, at most `LIMITS.hookContextChars`:

- `proposal`: `dibs update from your team's coordination service: proposal P7 (rev 1) for auth.session awaits your response. Proposed contract: … Basis: claude's plan says "…"; codex's plan says "…".`
- `contract`: `dibs: the contract for auth.session is agreed (rev 1, HANDSHAKE 2/2): …`
- `aligned`: `dibs: plans already agree on events.registration: …`
- `escalated`: `dibs: proposal P7 for auth.session was rejected twice and needs the developers.`
- `notice`, `message`, `fallback`: one sentence each, in the same style.

## Local files

Per participant under `DIBS_HOME` (default `~/.dibs`). Layout and formats: `packages/protocol/src/types.ts` ("Local files"). The bridge and hook take `--participant <name> --provider <p>`. **[fix]** Nothing is machine-wide except `config.json`, so several sessions can run on one machine.

**[fix] Bridge restart:** on startup, the bridge writes an inbox file for every delivery to it whose stage is before `shown` and whose id isn't already in `inbox/`, `claimed/` or `shown/`. It never re-prints a delivery that reached `shown`.

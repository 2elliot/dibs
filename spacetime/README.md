# dibs state, client and CLI

This workspace implements `docs/API.md` on SpacetimeDB 2.13. The public interface is frozen; module, generated bindings, shared client and CLI live on `issue/1-state`. The worker, bridge, real verifier and dashboard are separate issues.

## Run locally

Use Node 22 or newer (the deployment plan uses Node 24), npm and the SpacetimeDB 2.13 CLI. On Windows use `npm.cmd` if PowerShell's execution policy blocks `npm.ps1`. The Windows CLI is also available at `$env:LOCALAPPDATA/SpacetimeDB/spacetime.exe`.

From the repository root:

```sh
npm install
npm run typecheck
spacetime publish --server local --module-path spacetime --yes dibs-i1-dev
```

The shared development server is `http://127.0.0.1:3000`. Start `spacetime start --listen-addr 127.0.0.1:3000` only if no server is running. State development databases must use `dibs-i1-*`. Do not restart the shared server or publish to Maincloud during development.

## Bootstrap identities

Publishing initializes a private owner record and an unused admin invite. Read it using the publishing owner's CLI identity:

```sh
spacetime sql --server local dibs-i1-dev "SELECT code FROM invite WHERE name = 'admin' AND used = false"
npm run dibs -- join --uri http://127.0.0.1:3000 --db dibs-i1-dev --participant admin --code <code>
npm run dibs -- admin invite claude claude agent
npm run dibs -- admin invite codex codex agent
npm run dibs -- admin invite droid droid agent
npm run dibs -- admin invite worker claude worker
npm run dibs -- admin invite verifier claude verifier
```

Each `admin invite` prints a fresh code. Claim it on the corresponding machine with the same `dibs join` command, replacing `--participant` and `--code`. The provider is one of `claude`, `codex`, `droid`; the role independently grants agent, worker, verifier or admin access. The publisher retains admin authorization through its private owner record.

`join` saves `config.json` and `<participant>/token` under `DIBS_HOME`, defaulting to `~/.dibs`. Tokens are per participant and written atomically. Set `DIBS_HOME` to a temporary directory for tests. A repeated claim with the same identity is harmless; a different identity cannot claim an already-bound name. Keep codes and tokens out of Git and event logs.

Create a lobby using the fixture manifest and charter supplied by the bench lane:

```sh
npm run dibs -- lobby create --scenario s2 --mode dibs --base <fixture-base-sha> --manifest <dibs.json> --charter <charter.txt> --build <build-hash>
npm run dibs -- lobby start <lobby-id>
npm run dibs -- lobby stop <lobby-id>
npm run dibs -- export <lobby-id> --db dibs-i1-dev --out <events.json> --label "S2 / dibs / trial 1"
```

Administrative commands default to the saved `admin` token; use `--participant <admin-name>` for another admin. `--uri` and `--db` override the saved configuration. `export` uses an anonymous read-only connection and exports only the tables in `EXPORTED_TABLES`, with camelCase fields and JSON-safe values.

Agents call `joinLobby({ lobbyId, buildHash })` before publishing plans. The build must match, and an agent cannot leave an active lobby for another one. Worker and verifier identities are services: they act on explicit job/lobby ids under their own role and do not call the agent-only `join_lobby` reducer.

## Simulator and integration checkpoints

```sh
npm run dibs -- sim --db dibs-i1-sim
npm run dibs -- sim --db dibs-i1-sim --scenario aligned
npm run dibs -- sim --db dibs-i1-sim --scenario escalate
npm run dibs -- sim --db dibs-i1-sim --worker none --stop-after plans
npm run dibs -- sim --db dibs-i1-sim --stop-after proposal
npm run dibs -- sim --db dibs-i1-sim --stop-after agreed
npm run dibs -- sim --db dibs-i1-sim --agents none
```

The simulator publishes the local module without deleting existing data and uses fresh participant names for each run. If `DIBS_HOME` is unset, it creates and prints a temporary directory. The original admin invite is read through owner SQL; subsequent runs create a fresh admin invite through the owner's CLI identity. No real agent, model or oracle is invoked. Every simulation is labeled in the lobby charter, scenario, export and terminal summary; synthetic verification is not benchmark evidence.

- Default `s2`: conflicting bearer/cookie plans, a canned proposal, three accepts, an agreed contract, synthetic heads/verification/review, then lobby state `verified`.
- `aligned`: one aligned contract and no proposal; proceeds to synthetic verification.
- `escalate`: the first rejection requeues the same job; the second proposal is rejected and becomes `escalated`. Escalation is a proposal state; the lobby remains `running`, because the frozen lobby enum has no escalated state.
- `--worker none`: leaves the real job `queued`. Connect a real worker using its token in the printed home directory.
- `--agents none`: prepares identities, saved tokens and agent session files but publishes no fake plans. No job exists until an agent publishes a plan.
- `--stop-after plans|proposal|agreed|verified`: leaves that checkpoint for bridge, worker or dashboard development. `aligned` has no proposal checkpoint.

`<DIBS_HOME>/sim-<lobby-id>.json` maps roles to the generated participant names. Each agent has a protocol `session.json`; each role has a saved token. `<DIBS_HOME>/sim-<lobby-id>-events.json` is the default export; `--out <path>` overrides it. Canned plans and findings are reusable JSON in `packages/cli/src/commands/fixtures/`.

Automatic publishing and owner SQL are restricted to loopback URIs and `dibs-i1-*` names. The simulator cannot publish to Maincloud or another issue's database.

## Client API

```ts
import { connect, subscribeLobby, call, toJson } from "@dibs/client";
const { conn, identity, token } = await connect({
  uri,
  dbName,
  token: savedToken,
});
const subscription = await subscribeLobby(conn, lobbyId, [
  "participant",
  "plan",
  "plan_item",
  "job",
]);
const result = await call(
  conn,
  "publishPlan",
  {
    requestId,
    goal,
    produces: [{ key: "auth.session", text: "Use cookies." }],
    requires: [],
    notes: "",
  },
  { timeoutMs: 5000 },
);
// result.status: ok | pending | offline | error
console.log(toJson([...conn.db.plan.iter()]));
subscription.unsubscribe();
conn.disconnect();
```

`subscribeLobby` uses generated typed queries and resolves after the initial rows are applied. It accepts both `planItem` and the protocol spelling `plan_item`. Participant and service tables are global; lobby-bearing tables are filtered by lobby id. The SDK automatically replays subscriptions after reconnect; do not subscribe again in an automatic reconnect callback. `SubscriptionHandle.isActive()` is a method in the installed SDK.

`pending` means the caller does not know whether the transaction committed. Retry idempotent operations using the **same request id and payload**; do not treat a timeout as failure. Canonical request payloads include the sender, operation and lobby, so one participant cannot reuse another participant's request id. Reducer errors roll back the whole transaction, including the request record.

`toJson` converts bigint, identities, optional values and nested arrays/records. It rejects integers beyond JavaScript's safe integer range rather than silently corrupting them. Normal timestamp and id rows are within that range. Only `@dibs/client/node` imports filesystem, path or OS APIs. It exports `dibsHome`, `participantDir`, `readConfig`, `readToken`, `saveConfig`, and `saveToken`.

The SDK logs to `console.log` by default. An MCP host must route console logging to stderr before connecting so logs cannot contaminate its protocol stream. The CLI suppresses SDK informational logs so invite codes and lobby ids remain usable from scripts.

## Checks and Gate 0 findings

```sh
npm run typecheck
npm test
spacetime generate --lang typescript --out-dir packages/bindings/src --module-path spacetime --yes
npx prettier --write spacetime packages/bindings packages/client packages/cli
```

The tests publish fresh `dibs-i1-test-*` databases on the local server. The timer tests copy the module into ignored `spacetime/.test-module/` and replace only that copy's `timing.ts`. Production `TIMING` is never changed, and there is no production test-control reducer. The simulator tests use the shipped production delays.

Tests default to port 3000. To use an isolated state-lane instance, start `spacetime start --listen-addr 127.0.0.1:4110 --data-dir spacetime/.local-server/data --non-interactive` and set `DIBS_TEST_URI=http://127.0.0.1:4110` before running tests (PowerShell: `$env:DIBS_TEST_URI = 'http://127.0.0.1:4110'`). Pass `--uri http://127.0.0.1:4110` to manual simulator commands too. The server's data and keys are gitignored. The reconnect test uses a temporary TCP proxy on port 4111 and never stops the database server.

Verified against SpacetimeDB 2.13:

- Scheduled reducers bind with `db.reducer({ onSchedule: table }, { arg: table.rowType }, ...)`. The schedule tables are private, and generated bindings expose no private table handles.
- Scheduled contexts have `connectionId === null`; their sender equals `databaseIdentity`. Client calls cannot spoof the scheduler.
- Updating a row through its primary key can change its unique `slot`: closing a proposal moves `lobby/key` to `closed/id`, allowing a new revision. No delete/reinsert is required.
- `spacetime call` accepts canonical snake_case names and works for invite claims, lobby creation and plan publication. SQL JSON output is a result array with `rows` arrays.
- Generated client table `count()` returns bigint. Generated secondary-index types are less precise than server index types; scanning the small participant cache by name avoids that typing limitation.
- Initial subscriptions, token reuse, multiple connections for one identity, browser connections, and reconnect replay are exercised against the live local server. A private `presence_connection` table keeps `participant.online` true until that identity's last connection closes; it adds no public interface.
- The CLI build can report that a module-local `tsc` was not found with hoisted npm workspaces. The separate required `npm run typecheck` checks module, bindings, client, CLI and the integration-test TypeScript.

Keep schema changes and regenerated bindings in the same commit. Do not change `docs/API.md`, `packages/protocol`, the root scripts or the CLI command table from this lane.

## Human deployment step

After integrating the other lanes and reviewing the build, the publishing owner can run these commands. They have not been run by this development task:

```sh
spacetime publish --server maincloud --module-path spacetime --yes dibs-ch13-dev
spacetime publish --server maincloud --module-path spacetime --yes dibs-ch13-demo
```

The demo publish belongs to the plan's coordinated cutover. Maincloud needs its own invite claims and tokens; local identity files are not a substitute for that bootstrap. Azure deployment belongs to the worker lane.

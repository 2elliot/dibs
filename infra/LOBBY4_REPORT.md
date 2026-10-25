# Lobby 4 report: three agents, HANDSHAKE 2/2

**Result: the full dibs loop worked across three machines.** Claude Code (M1, Windows), Codex (M3, Mac)
and Droid (M2, Windows) planned in one `dibs`-mode S2 lobby on `dibs-ch13-dev`. The Azure worker
found a conflict on `auth.session` and a dependency on `events.registration`. Both required parties
accepted both proposals within about 3 seconds (**HANDSHAKE 2/2** on each key). Codex and Droid wrote
their shared-key code only after the contracts were agreed, and the three branches combined pass every
server-side check of both contracts. Unscored dev lobby, Saturday 2026-10-24, times in PDT. Droid's
first launch failed and was relaunched by hand; Codex's first launch failed its hook check and was
relaunched (see "Issues").

| Pin          | Value                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------ |
| Lobby        | 4, `s2`, `dibs`, base `f4001dc`, build `ac6cda3a…` (real `6af0cd8e`)                             |
| Started      | 18:05:17 · fallback 18:11:17 · stopped 18:20:17                                                  |
| Participants | `claude` (3, M1), `codex` (8, M3), `droid` (10, M2), `worker` (Azure, image `real-e7806ad8f05c`) |
| Heads        | claude `cb0a467` · codex `5519e64` · droid `4530e74` (first launch: empty `435ba56`, its parent) |
| Out of area  | none on any head                                                                                 |
| Branches     | `lobby/4/codex`, `lobby/4/droid` on GitHub; `lobby-4-claude.bundle` sent to Chris                |

## Timeline

| Time     | What happened                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 18:05:17 | Admin starts lobby 4. Claude joins 3 s later; M3's first Codex launch fails the 30 s hook-alive check (no Codex session).                |
| 18:05:40 | Claude publishes its plan: bearer `auth.session`, `auth.server` helpers, requires `events.registration`.                                 |
| 18:05:45 | Job queued on Claude's plan alone (only joined agents count). **Worker leases in 63 ms**; notice on unowned `events.registration`.       |
| 18:05:46 | Claude writes `src/auth/**` and its tests (early implementation, allowed), then keeps polling `dibs_status`.                             |
| 18:05:57 | Droid's first launch (`droid exec --auto medium`) joins, then stops at 18:06:12 on "insufficient permission"; empty head `435ba56`.      |
| 18:06:40 | Codex relaunched (18:06:39) joins; publishes at 18:06:52 (produces `auth.session` and `events.registration`, requires both).             |
| 18:07:17 | Job re-queued; leased in 63 ms. Droid relaunched with `--auto high` and rejoins.                                                         |
| 18:07:38 | Worker raises proposal 2 (`auth.session`, conflict) and proposal 3 (`events.registration`, dependency), required parties claude + codex. |
| 18:07:41 | Codex and Claude accept both. Contracts agreed: `auth.session` 18:07:41.8, `events.registration` 18:07:42.7 (HANDSHAKE 2/2 each).        |
| 18:07:42 | Droid's first `dibs_plan` rejected (a statement over 500 characters); republished at 18:07:50.                                           |
| 18:07:55 | Job re-queued for Droid's plan; leased in 62 ms. 18:08:16: `auth.server` **aligned**, no new conflict.                                   |
| 18:08:00 | Codex writes `public/app.js` (its only shared-file edit), after the contract.                                                            |
| 18:08:54 | Claude finishes; head `cb0a467`.                                                                                                         |
| 18:09:06 | Droid writes `src/events/routes.js` and its tests, after the contract. Finishes at 18:09:38; head `4530e74` at 18:09:40.                 |
| 18:20:17 | Lobby stops. Codex's `session start` didn't end it (see Issues); stopped by hand at ~18:27, head `5519e64` reported 18:28:04.            |

The worker made 3 analysis calls in one job (1 attempt, no error).

## The agreed contracts

- **`auth.session` (proposal 2, conflict, agreed):** bearer token only, no cookies. `POST /api/login`
  `{email,password}` → 200 `{token}`, 401 `{error}`. `GET /api/me` with `Authorization: Bearer <token>`
  → 200 `{id,email}`, 401 `{error}`. The client keeps the token in memory and sends the header on
  every later request.
- **`events.registration` (proposal 3, dependency, agreed):** `POST /api/events/:eventId/registrations`
  with the bearer header and no body; the server uses `requireUser`/`getCurrentUser` from
  `src/auth/index.js`; 401 unauthenticated, 404 `{error}` unknown event, 409 `{error}` repeat,
  201 `{id,eventId,userId}`. The UI shows "Registered" on 201, "Already registered" on 409,
  "Event not found" on 404, and asks for login on 401.
- **`auth.server`:** aligned (no vote) once Droid's plan matched Claude's helpers.

Responses: proposals 2 and 3, revision 1, `accept` from claude (3) and codex (8). Droid had no plan
when the proposals were raised, so it was not a required party.

## Contract compliance (code review of each head)

| Agent (area)                   | Head      | Follows the contract | Last shared-key edit vs contract (18:07:41)    |
| ------------------------------ | --------- | -------------------- | ---------------------------------------------- |
| Claude (`src/auth/**`)         | `cb0a467` | yes                  | before (18:05:55); its code already matched    |
| Codex (`public/**`, `test/ui`) | `5519e64` | yes                  | **after** (18:08:00): built after the contract |
| Droid (`src/events/**`)        | `4530e74` | yes                  | **after** (18:09:06): built after the contract |

- **Claude:** login returns `{token}` / 401 `{error}`; `/api/me` reads `Authorization: Bearer`;
  `getCurrentUser` and `requireUser` exported from `src/auth/index.js`; no cookies.
- **Codex:** token kept in memory; `Authorization: Bearer` on `/api/me` and registration;
  `credentials: 'omit'` everywhere; POST to `/api/events/<data-event-id>/registrations` with no body;
  status texts exactly as agreed.
- **Droid:** `getCurrentUser` from `src/auth/index.js`; checks in the agreed order (401, 404, 409);
  201 `{id,eventId,userId}` with `userId` from the logged-in user.

Edit times for Codex and Droid come from each machine's own session log (reported by M3 and M2);
Claude's from its transcript on M1.

## Combined test results

The three heads merged on `f4001dc` with no conflicts (each agent touched only its area: 7 files,
+556/−9). On M1, with the fixture's dependencies:

- All three agents' tests: **23/23 pass** (`test/auth`, `test/ui`, `test/events`).
- Live server, checked clause by clause:

| Check                                        | Result                                                            |
| -------------------------------------------- | ----------------------------------------------------------------- |
| Valid login, then `/api/me` with the bearer  | 200 `{"id":"u1","email":"alice@example.com"}`, no `Set-Cookie`    |
| Bad password                                 | 401                                                               |
| Alice registers / registers again            | 201 `{id,eventId:"evt-1",userId:"u1"}` / 409 "Already registered" |
| Bob registers                                | 201, distinct id, `userId:"u2"`                                   |
| Unauthenticated registration / unknown event | 401 / 404 "Event not found"                                       |
| Cookie only (no bearer)                      | 401                                                               |

These match the oracle's server-side checks 1–5. **Not run on M1:** check 6 (Playwright: Log in →
Register → "Registered"), because no Chromium is installed here; Codex's own UI tests cover the same
logic in a simulated page. `dibs verify` / `dibs review` on M3 give the official score; no
`verification` row exists for lobby 4 yet.

## Issues found

1. **`session start` never stopped Codex (bridge, issue 2).** `prep` ran before `lobby start`, so
   `session.json` had `endsAtUs = 0`, and `startSession` then waits up to 24 h for the agent to exit.
   Interactive Codex never exits on its own (Claude and Droid did). Fix: once the lobby is
   `running`, re-read `endsAtUs` (and `fallbackAtUs`) from the lobby before setting the stop timer.
2. **Codex's first launch failed the 30 s hook-alive check** and left no Codex session. The relaunch
   passed. Cause unconfirmed: possibly slow start-up under M3's pseudo-terminal helper. Codex runs
   interactively under that helper (`DIBS_AGENT_COMMAND`) because `codex exec` doesn't fire hooks;
   the helper is M3-only, not product code.
3. **Droid `--auto medium` can't finish a task.** It stopped on "insufficient permission to
   proceed". `--auto high` worked. Record the launch flags in the runbook.
4. **`dibs_plan` rejected a statement over 500 characters.** Droid recovered in 8 s, but the limit
   isn't in the tool description agents see (issue 2) or the prompt (issue 4).
5. **Analysis starts before late joiners plan (module, issue 1).** `promote_job` waits only for agents
   that have already joined, so the first pass ran on Claude's plan alone. It did no harm here because
   Claude stayed to answer the later proposals, but an early finisher could miss them. Waiting for the
   lobby's expected roster (or a minimum join window) would close it.
6. **Shared local servers.** On M1 the shared SpacetimeDB (port 3000) is down from memory pressure;
   lobby runs don't need it.

What worked, beyond the handshake: the redeployed worker (lease on sight: 62–63 ms from `job_queued`
to `job_leased`, versus 10.5 s in lobby 3); Claude stayed in the lobby and answered both proposals
without the Stop hook fix; message and contract delivery to all three agents.

## Evidence

- Database rows for lobby 4 (lobby, participants, plans, items, job, proposals with full contract
  text, responses, contracts, deliveries, messages, heads, events): dumped on M1 to
  `~/.dibs/operator/lobby4-evidence.txt`; Claude's diff `f4001dc..cb0a467` next to it.
- Code: `lobby/4/codex` (`5519e64`) and `lobby/4/droid` (`4530e74`) on GitHub;
  `lobby-4-claude.bundle` (`lobby/4/claude` at `cb0a467`) sent to Chris; backup bundles on M2 and M3.
- Transcripts: Claude on M1
  (`~/.claude/projects/C--Users-lib-laptop-dibs-clones-claude-fixture/8071049c-20b5-4c43-842f-e0a2a30ed684.jsonl`);
  Codex rollout on M3 (`rollout-2026-10-24T18-06-39-…`); Droid session logs on M2
  (second session `4f704897-bcf8-4544-a1fb-db83c7e6cb64`).

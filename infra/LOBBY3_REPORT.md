# Lobby 3 report: first shared-DB lobby (Windows Claude Code + Mac Codex)

**Result: no handshake, but the agents' code agrees.** Codex never published a plan, so the worker
never had two plans to compare, and no proposal, response or contract was written. Even so, Claude's
bearer-token message reached Codex through the hook while Codex's dibs tools were offline, and Codex
built a matching UI that sends `Authorization: Bearer` (`a5b7a48`). The Droid SDK review agrees:
"auth transport and server helpers conform". The oracle's 2/6 comes only from the missing Droid
events route. This was an unscored dev lobby on `dibs-ch13-dev` (Saturday 2026-10-24, times in PDT).
Both agents were relaunched once by hand, so it is a labelled rerun, not a clean trial.

| Pin          | Value                                                                             |
| ------------ | --------------------------------------------------------------------------------- |
| Lobby        | 3, `s2`, `dibs`, base `f4001dc`, build `ac6cda3a…` (real `6af0cd8e`)              |
| Started      | 16:37:07 · fallback 16:43:07 · stopped 16:52:07 (on schedule)                     |
| Participants | `claude` (id 3, M1 Windows), `codex` (id 8, M3 Mac), `worker` (Azure)             |
| Heads        | claude `19881c7` (code), `14fdc58` (relaunch, empty); codex `a5b7a48` (bearer UI) |
| Out of area  | none on any head                                                                  |

## Timeline

| Time     | What happened                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 16:37:07 | Admin starts lobby 3. Claude launches on M1; SessionStart hook writes `hook-alive.json` 2 s later.                                                                                                                             |
| 16:37:25 | Claude publishes plan 1: bearer `auth.session`, `auth.server` helpers (`getCurrentUser`, `requireUser`), requires `events.registration`.                                                                                       |
| ~16:38   | M3: Codex launched with `codex exec`. Its hooks never fire, so `dibs session start` kills it at +30 s (no `hook-alive.json`).                                                                                                  |
| 16:38:17 | Claude writes `src/auth/**` and its tests after one 45 s `dibs_status` wait, while its keys were still `pending`.                                                                                                              |
| 16:39:07 | `analyze_anyway` queues the job with only Claude's plan. Worker leases at 16:39:17 (10.5 s: old image) and submits at 16:39:22.                                                                                                |
| 16:39:22 | Finding: `events.registration` is an unowned requirement (no Droid). Notice to both agents; Claude's keys become `clear`.                                                                                                      |
| 16:39:29 | Claude messages `all` with its full contract (bearer token, `requireUser`, what `app.js` should send).                                                                                                                         |
| ~16:40   | M3: Codex relaunched by hand in the clone. Hooks fire and Claude's bearer message reaches it, though every dibs tool returns offline. It builds `public/app.js` sending `Authorization: Bearer`: this is the pushed `a5b7a48`. |
| 16:41:16 | Claude finishes (Stop hook never blocked: 0 of 8 used, no pending keys); session commits, pushes, reports head `19881c7`.                                                                                                      |
| 16:42:55 | Claude relaunched by hand (Elliot's OK). It republishes plan 2 (16:43:14), re-queuing the job.                                                                                                                                 |
| 16:43:42 | Re-analysis **fails** validation on both model attempts: "cites nonexistent item or wrong-key id(s) 10" (item 10 = `auth.server`).                                                                                             |
| 16:43:56 | Relaunched Claude finishes again (keys still `clear`); empty head `14fdc58`.                                                                                                                                                   |
| ~16:48   | M3: second Codex relaunch, from `~` instead of the clone: no dibs tools. It edits an old v1 folder (`~/Desktop/event-registration-fixture/app`) with cookie code; none of that is in the clone or pushed.                      |
| 16:51:33 | Codex head `a5b7a48` (the bearer UI from the first relaunch) reported. 16:52:07 lobby stops.                                                                                                                                   |

## What went wrong

1. **Codex never planned (M3).** Three separate causes, one per launch:
   - `codex exec` runs no hooks, so `dibs session start` killed it at the 30 s hook-alive check.
   - The first hand relaunch had hooks but no working tools: every `dibs_*` call returned offline.
     Most likely the bridge from the `exec` run was still alive and holding `bridge.lock`.
     `spawnAgent` (`packages/bridge/src/proc.ts`) doesn't spawn with `detached: true`, so on macOS
     `killTree`'s `process.kill(-pid)` can't reach the process group and falls back to killing only
     the parent. A surviving child bridge fits what M3 saw. Not yet confirmed.
   - The second relaunch started from `~`, where the project-scoped `.codex/` config doesn't apply,
     so Codex had no dibs tools. It then edited an old v1 folder on the Desktop
     (`~/Desktop/event-registration-fixture/app`) with cookie code. Nothing from it reached the
     clone or the pushed head, but it shows again that Codex will work in neighbouring folders.

   Despite all three, the coordination itself worked: Claude's bearer message reached Codex through
   the hook at the first relaunch, and Codex's pushed UI (`a5b7a48`) matches Claude's server.

2. **Claude stops too early (bridge/hook design).** After `analyze_anyway` ran on Claude's plan
   alone, Claude's keys read `clear`, so its Stop hook had nothing to block on. It finished at +4 min
   while its peer had no plan, and again 40 s after the relaunch. A proposal that arrives later has
   no one to answer it.
3. **Claude implemented before analysis (agent behaviour; allowed).** It wrote `auth.session` code
   after one 45 s wait, while the phase was `waiting_for_peers`. Chris's decision: early
   implementation stays allowed, and the frozen, hashed prompts don't change, because telling agents
   to wait would tune the bench to flatter dibs. Instead the bench records, per agent, whether its
   last edit to a shared-key file came after the contract delivery. Coding early and revising after
   the contract is dibs working; never revising is a real failure that the verify score shows. In
   lobby 3 no contract was ever delivered, so there was nothing to revise against.
4. **One bad citation failed the whole analysis (worker).** The model cited item 10 (`auth.server`)
   under another key, almost certainly while explaining the unowned `events.registration`
   requirement. The worker's same-key rule rejected the entire result on both attempts, and the job
   went to `fail_job`. It also counted as an Anthropic error in `/health/status` though the API was
   fine.
5. **Slow lease (worker).** 10.5 s from `job_queued` to `job_leased`: Azure still runs the image
   without the lease-on-sight fix that's on `real`.
6. **Tight start windows (runbook).** `session start` gives up if the lobby isn't started within
   2 minutes, and kills the agent if `hook-alive.json` doesn't appear within 30 s. My first Windows
   `session start` timed out waiting for M3.

What worked: Claude on Windows end to end (launch, hooks, bridge, plan, code, tests, message,
finalize, push, `report_head`); message delivery from Claude to Codex through the hook, which led to
a matching bearer UI; the Azure worker's real analysis and notices; the shared database and the
dashboard feed.

## Fixes before lobby 4

| #   | Fix                                                                                                                                                                                                                               | Owner             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 1   | Pick one Codex launch path and test it before the lobby: either a launch that runs hooks without a TTY, or tool-only mode for Codex with the hook-alive check skipped (plan §5.5 fallback). Always launch from the clone.         | Chris + Ren Jie   |
| 2   | Before any relaunch, kill leftover `bridge.mjs` processes for the participant (or check `bridge.lock`'s pid). Spawn agents with `detached: true` on POSIX so `killTree` takes the whole group.                                    | Ren Jie (issue 2) |
| 3   | Keep the Stop hook blocking while any agent in the lobby has no current plan and `fallbackInSec > 0`, so an early finisher stays to answer a proposal and to revise after the contract (what the bench now measures, see 7).      | Ren Jie (issue 2) |
| 4   | Worker: drop findings or citations that fail validation and submit the rest; fail the job only if nothing valid is left. Don't count validation failures as Anthropic errors.                                                     | Elliot (issue 3)  |
| 5   | Redeploy the Azure worker from `real` (lease on sight).                                                                                                                                                                           | Elliot (issue 3)  |
| 6   | Runbook: start both `session start` commands within 2 minutes of `lobby start`, and note the 30 s hook-alive kill.                                                                                                                | Elliot (issue 3)  |
| 7   | **Decided:** early implementation stays allowed; no prompt change. The bench records per agent whether its last edit to a shared-key file came after the contract delivery, and the verify score shows agents that never revised. | Chris (issue 4)   |

## Evidence

- Database rows for lobby 3 (lobby, participants, plans, plan items, job, deliveries, messages,
  heads, events, service): dumped on M1 to `lobby3-evidence.txt`; regenerate with the queries in
  `infra/E2E_RUNBOOK.md` ("Evidence to collect") with `N = 3`.
- Claude's code: `lobby-3-claude.bundle` (branch `lobby/3/claude` at `14fdc58`, complete history),
  sent to Chris. Diff `f4001dc..19881c7`: `src/auth/index.js`, `src/auth/routes.js`,
  `test/auth/auth.test.js` (+119/−6).
- Claude transcripts on M1: `~/.claude/projects/C--Users-lib-laptop-dibs-clones-claude-fixture/`
  `aedd9677-fc24-4ffe-bdad-1ce321a878a3.jsonl` (first run) and
  `6cd2a954-f73a-463a-abd4-6681e0e289d9.jsonl` (relaunch).
- Codex: `lobby/3/codex` at `a5b7a48` on M3 (bearer UI, checked against the code by M3), and M3's
  timeline above. Verify on M3: oracle 2/6, failing only on the missing Droid events route; Droid
  SDK review: "auth transport and server helpers conform".

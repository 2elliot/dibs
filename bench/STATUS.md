# Issue 4 (bench) + issue 5 (dashboard): status

**As of Sat 15:50 PT** (Elliot's and Ren Jie's same-page replies folded in) · owner: Chris (C, M3 Mac) · branch `issue/4-bench` (PR #13) · dashboard `issue/5-dashboard` (PR #10)

The bench side is done and checked end to end. It holds the test app, the prompts, the hidden oracle, `dibs verify` and the Droid review. The S2 pilot fails exactly as designed (5/6), and the Droid review names the cause. What's left is wiring it to the shared database and running it on real dibs-mode lobbies.

## What this part does, and where it sits

```
agents (M1 Claude Code · M2 Droid · M3 Codex) ── dibs session pushes ──▶ dibs-fixture-lobbies: lobby/<id>/<provider>
         │ plans / responses                                                   │
         ▼                                                                     ▼
   SpacetimeDB (dibs-ch13-dev) ◀── record_verification / record_review ── dibs verify + dibs review (M3, issue 4)
         │                                                                     │ uses fixture/, bench/prompts, bench/oracle.enc
         └──────────────▶ dashboard (issue 5): contracts, handoff, oracle x/6, review, scorecard
```

| Piece (issue 4)                                                       | Path                                                          | Status                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| Test app that agents build                                            | `fixture/` (+ `fixture/dibs.json`: keys, areas, frozen files) | Done                                              |
| Prompts: charters, mode text, S1/S2/N roles                           | `bench/prompts/` (promptsHash `49f615c4…`)                    | Done; one sentence still to add (below)           |
| Hidden oracle (6 checks incl. a real-browser UI check) + 3 references | `bench/oracle.enc` (oracleHash `0e51eb5a…`); key only on M3   | Done                                              |
| `dibs verify <lobbyId>`                                               | `packages/verifier/src/verify.ts`                             | Done; database recording untested live            |
| `dibs review <lobbyId>` (Droid SDK; Claude/exec/fake fallbacks)       | `packages/verifier/src/review*.ts`                            | Done; Droid SDK proven live on M3                 |
| Dev plans for analysis tuning                                         | `bench/dev/`                                                  | Done (handed to issue 3)                          |
| Dashboard (issue 5, via Codex)                                        | `apps/dashboard/`                                             | Replay done; live mode untested against a real DB |

## Diagnostic (15:15, cloud copy of `issue/4-bench` = `real` + issue 4)

| Check                                                 | Result                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| `npm run typecheck` (all workspaces)                  | Pass                                                                  |
| `npm test -w @dibs/verifier` with real Chromium       | 15/15                                                                 |
| Oracle on references (Gate 0 c)                       | scaffold 0/6 · cookie 6/6 · bearer 6/6 · mismatch 5/6 (check 6 fails) |
| `oracle.enc` matches the plaintext oracle             | Yes (`0e51eb5a91d8…`)                                                 |
| `bench/prompts/manifest.json` current                 | Yes                                                                   |
| Secrets in git (key, plaintext oracle, results, .env) | None                                                                  |
| PR #13 vs `real`                                      | Contains `real`; GitHub says mergeable (clean)                        |

## Pilot results (S2, None mode, all seats on M3)

| Lobby       | Setup                                                                   | Oracle                                                                                  | Verdict                                                                                |
| ----------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 901 (14:35) | Each clone isolated in its own `/tmp` folder; Claude Code, Codex, Droid | **5/6**: check 6 fails ("Please log in to register"); merge clean; no out-of-area edits | **Valid, failed as designed.** Keep the planted defaults                               |
| 900 (11:50) | Clones side by side in one folder                                       | 6/6                                                                                     | **Invalid:** Codex ran `cat ../claude/src/auth/*.js` and copied Claude's bearer choice |

Droid SDK review of 901 (real Factory account): `auth.session` **violates** (root cause: codex. `public/app.js` assumes a cookie, drops the login token, never sends `Authorization: Bearer`); `auth.server` and `events.registration` conform.

**Findings to carry forward:**

1. **Agents read neighbouring folders.** Every trial clone must be isolated. On M3, keep Codex's clone away from `~/Desktop/dibs-i4` (the plaintext oracle is now deleted there) and `~/Desktop/dibs-pilot`.
2. **Droid stops to ask the human** when it's unsure. In trials nobody can answer.
3. **Each agent finished by saying it couldn't confirm the others' choices.** Claude even wrote out a contract the others "must follow". That's the gap dibs fills: use it in the pitch.

## Same-page replies

**Elliot (issue 3), 15:26: same page, yes.**

| #   | Elliot's finding                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Correct: seen live. In lobby 1, `dibs session start` pushed `refs/heads/lobby/1/claude`, and `report_head` recorded the same SHA (to a local bare repo, since `dibs-fixture-lobbies` doesn't exist yet).                                                        |
| A2  | Correct, with a stopgap. Until `dibs-fixture` exists, both machines use base **`f4001dc`** = `git subtree split --prefix=fixture 8e41fb6`, i.e. exactly this `fixture/`. **When `dibs-fixture` is published, push that same commit** so bases match.            |
| A3  | Correct. Lobby 1 was created with `--manifest fixture/dibs.json --charter bench/prompts/charter-s.md`, and the composed S2/dibs prompts match `manifest.json`. A prompt edit changes the hashes in `infra/E2E_RUNBOOK.md` (issue 3); tell Elliot when it lands. |
| A4  | **Changed:** the `admin` participant on `dibs-ch13-dev` is on **Elliot's** laptop. The `codex` invite exists; Elliot can create `verifier` and send both to M3 privately.                                                                                       |
| A5  | Correct. Azure `/config.json` points at `https://maincloud.spacetimedb.com` / `dibs-ch13-dev` (no `lobby`). The deployed dashboard followed lobby 1 live.                                                                                                       |

**Live on `dibs-ch13-dev` (per Elliot):**

- The Azure worker has been connected since 14:02, with the `worker` participant heartbeating.
- The model is `claude-sonnet-4-6`.
- The first real analysis ran on lobby 1 at 14:37: 1 attempt, 1578 ms, 0 errors.
- Proven on the Windows side: a real Claude Code `dibs session`, the startup hook, the bridge, the worker and the dashboard. Steps and the pinned bridge build hash `0f9c811d…` are in `infra/E2E_RUNBOOK.md` on `issue/3-worker`.

**Fixed from Elliot's report (issue 5, `295001f`):** the dashboard's "Analysis online" badge looked for a service row named `analysis`. The worker can only heartbeat under its own name (`worker`), so the badge showed offline. It now reads `worker`, falling back to `analysis`.

**Ren Jie (issues 1, 2), 15:40 (relayed by Chris): same page, yes.** One action item: re-pin the bridge build (see risks).

| #   | Ren Jie's finding                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Correct. `dibs session start` commits, pushes `HEAD` to `refs/heads/lobby/<id>/<provider>` on the `--lobbies` URL, then calls `report_head` with that SHA.                                                                                                                                                          |
| A2  | Correct, with a caveat. `prep` doesn't clone or fetch. It resets the existing `--clone` folder to `<base>` (plus `git clean`), so `f4001dc` must already be in that clone (the runbook's `git push … f4001dc:refs/heads/base` step does this). Out-of-area files are checked against the clone's `dibs.json` areas. |
| A3  | Correct, **only if the operator passes the composed prompt**. `prep` uses `--prompt` / `--prompt-file` verbatim and never calls `composePrompt`. Always pass `compose-prompt` output via `--prompt-file`.                                                                                                           |
| A4  | Correct. `record_verification`, `mark_verified` and `record_review` are verifier-only. Only the `verifier` invite is needed (from Elliot).                                                                                                                                                                          |
| A6  | Unknown for M2 credits. **The Droid provider config has never been run.** Someone on M2 must run the Droid checklist in `packages/bridge/README.md`.                                                                                                                                                                |
| A7  | Correct for issues 1 and 2. `dibs session` kills the agent's process tree at `endsAtUs`.                                                                                                                                                                                                                            |

**Answers:**

- **PR #15's loop:** used a scratch app (an empty repo with a README), so it tested coordination, not the oracle. Trials use `--clone` at `f4001dc`, later `dibs-fixture`.
- **Clone location:** wherever `--clone` points; the runbook uses `~/dibs-clones/<provider>/fixture`. **dibs does not enforce isolation**, and Codex's sandbox limits writes, not reads. Use one agent clone per machine, with no sibling clones, dibs repo or `bench/` files under `~/dibs-clones`.
- **Admin:** fine on Elliot's laptop. Ren Jie still owns the Maincloud database and can mint a fresh admin invite. Test rows from his live check: participants `*-460c0e`, lobby 2 (stopped).
- **Merges:** #15 → `issue/2-agents` (15:29), **#12 → `real` (15:30, `4d425ec`)**. #9, #13 and #10 should merge `origin/real`.
- **Simulator `dibs-i5-*`:** not yet. A one-line change to allow `dibs-i[1-5]-*`, loopback-only; he can push it.
- **Gate 0 (a), hooks:** Claude Code on Windows done. Codex on Windows done headless. **Codex on Mac and Droid not yet.**
- **Gate 0 (b), Mac → Windows:** **not yet.** All of his runs were on one Windows laptop.

**Codex hook trust on M3** (Chris does this once per new build): after `dibs session prep`, run `codex` interactively in `~/dibs-clones/codex/fixture`, accept the hook-trust prompt, and quit. Fallback: `--dangerously-bypass-hook-trust`.

**Risks for the first shared-DB lobby:**

1. **The bridge build pin is stale.** `infra/E2E_RUNBOOK.md` pins `0f9c811d…`, but `real` (`4d425ec`) now builds `ac6cda3a3028cc4b…` on Windows (Codex fixes, the hook double-delivery fix, `--home`, memory off). Rebuild from `real` on M1 and M3, compare hashes, then `lobby create --build <new>`.
2. **The new `hooks.json` adds `--home`,** so any hook trust M3 accepted on the old build is void. Re-accept once after `prep`.
3. **Possible duplicate TOML table:** if M3's `~/.codex/config.toml` already has a `[projects."…/dibs-clones/codex/fixture"]` table, `prep` adds the same key, and Codex may refuse the config. Delete the old one first.

**Done from Ren Jie's ask (`d30256e`):** every role prompt now ends with "No one can answer questions during this task; make reasonable assumptions and keep going." `promptsHash` is now **`3209eb28…`**. New composed S2/dibs prompt hashes: claude `d73169de…`, codex `68e049e1…`, droid `70ff2304…`. **Elliot: update `infra/E2E_RUNBOOK.md`.**

## Assumptions this part makes (please confirm or correct)

| #   | Assumption                                                                                                                                                                                                                                                         | Depends on                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| A1  | `dibs session` pushes each agent's final commit to `refs/heads/lobby/<lobbyId>/<provider>` (provider ∈ claude, codex, droid) in `dibs-fixture-lobbies`. Verify fetches exactly those.                                                                              | Issue 2 (confirmed in `session.ts`) |
| A2  | Trial clones are made from **this** `fixture/` (published as `dibs-fixture`), at the commit passed to `lobby create --base`. Areas and frozen files come from `fixture/dibs.json`.                                                                                 | Issue 2 + operator                  |
| A3  | Lobbies are created with `--manifest fixture/dibs.json --charter bench/prompts/charter-s.md` (N: `bench/prompts/vocabulary-n.json` + `charter-n.md`). Agents' launch prompts come from `compose-prompt` / `composePrompt`, so `promptsHash` matches what they saw. | Operator + issue 2                  |
| A4  | M3 joins `dibs-ch13-dev` (later `dibs-ch13-demo`) as participant `verifier`, role verifier. With that token, verify/review call `record_verification`, `mark_verified` and `record_review`, and read `lobby.baseSha` and the current contracts.                    | Issue 1 invites                     |
| A5  | The worker's `/config.json` serves `{dbUri, dbName}` (now also `uri`, `db`, optional `lobby`). The dashboard accepts both and follows the newest running lobby.                                                                                                    | Issue 3 (confirmed in `config.ts`)  |
| A6  | Droid stays the third agent (Factory track on; credits available on M3). Whether M2 has its own Droid credits is still open.                                                                                                                                       | Team                                |
| A7  | Each scored trial: 15-minute stop, then `dibs verify` during the next trial (5-minute oracle timeout), then `dibs review` batched at 21:00 (immediately for demo lobbies: `dibs verify <id> --review`).                                                            | Plan §7, §11                        |

## Open items

| Item                                                                                                                 | Owner             | Needed by                            |
| -------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------ |
| Invite codes for `codex` and `verifier` on `dibs-ch13-dev`, so M3 can `dibs join`                                    | Ren Jie           | Now                                  |
| Merge order into `real`: #12 (+#15) → #9 → #13 → #10; all four say "clean"                                           | Each owner        | Before the first shared-DB lobby     |
| First dibs-mode S2 lobby on `dibs-ch13-dev`: M1 Claude Code + M3 Codex, then verify + review it                      | All               | Replaces the missed 13:30 checkpoint |
| Add to all prompts: "No one can answer questions during this task; make reasonable assumptions and keep going."      | Chris             | Before Freeze 1 (18:25)              |
| Run `check-oracle` once on Windows (M1 or M2), with the key passed temporarily via `DIBS_ORACLE_KEY`                 | Ren Jie or Elliot | Before trials                        |
| Create `dibs-fixture` (protected `main`) and private `dibs-fixture-lobbies`; non-interactive push from every machine | Repo owner        | Before trials                        |
| Dashboard live test against a real lobby (the simulator rejects `dibs-i5-*` names)                                   | Chris + Ren Jie   | Before 16:00                         |

## Questions for Ren Jie and Elliot (are we on the same page?)

1. ~~PR #15's app~~: answered. It was a scratch app; trials use `f4001dc`.
2. ~~Clone location~~: answered. `~/dibs-clones/<provider>/fixture`; isolation is up to us.
3. ~~Invite codes~~: answered. Elliot holds admin and will send `codex` + `verifier` privately.
4. ~~Worker and model~~: answered. Connected since 14:02, `claude-sonnet-4-6`.
5. **Both:** anything in A1–A7 that's wrong, or anything you need from issue 4 or 5 (fixture changes, prompt wording, verify/review output fields, dashboard panels)?

Reply in PR #13, or edit this file on `issue/4-bench`.

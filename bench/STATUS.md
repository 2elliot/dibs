# Issue 4 (bench) + issue 5 (dashboard): status

**As of Sat 15:20 PT** · owner: Chris (C, M3 Mac) · branch `issue/4-bench` (PR #13) · dashboard `issue/5-dashboard` (PR #10)

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

1. **Ren Jie:** PR #15's live loop with real Claude Code + Codex reached an agreed `auth.session` contract. Great. But it describes files like `auth.js` and `client.js`, which aren't in `fixture/`. Was that run on a scratch app? For trials, `dibs session prep` must clone `dibs-fixture` (this `fixture/`), or verify and the oracle won't apply (A2).
2. **Ren Jie:** where does `dibs session` put the clone on each machine, and can it be a folder with no sibling checkouts (finding 1)?
3. **Ren Jie:** please send the `codex` and `verifier` invite codes (privately, not in a PR) and confirm `dibs-ch13-dev` on `https://maincloud.spacetimedb.com`.
4. **Elliot:** is the worker connected to `dibs-ch13-dev` yet, and which model ID is confirmed?
5. **Both:** anything in A1–A7 that's wrong, or anything you need from issue 4 or 5 (fixture changes, prompt wording, verify/review output fields, dashboard panels)?

Reply in PR #13, or edit this file on `issue/4-bench`.

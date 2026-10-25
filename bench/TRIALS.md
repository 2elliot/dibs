# Trials: S2 with and without dibs

Scored on Sat Oct 24, 2026, on `dibs-ch13-dev`, using `bench-v1` (`27c4fa4`).

**Setup, the same in every trial:**

- **Agents:** three agents on three laptops: Claude Code on M1 (Windows), Droid on M2 (Windows), Codex on M3 (macOS).
- **Task:** S2 prompts, with one shared base, `f4001dc`.
- **Bridge:** build `ac6cda3a…`.
- **Time:** a fixed 15-minute lobby, with fallback at +6 min.
- **Interventions:** zero keystrokes after launch; any relaunch is logged as an intervention.
- **Mode:** the only difference between the trials.

Each trial is scored by the hidden oracle on M3 (`dibs verify`, six black-box checks; check 6 drives a real browser). The Droid SDK review then explains the result clause by clause. Times are PDT.

## Scorecard

| Trial  | Lobby | Mode | Oracle  | Merge-tree | Droid SDK review                                                                                              | Status                                       |
| ------ | ----- | ---- | ------- | ---------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **T1** | 5     | none | **5/6** | clean      | "The UI violates the session transport contract by assuming cookies while authentication uses bearer tokens." | Scored                                       |
| T2     | 6     | dibs | —       | —          | —                                                                                                             | **Invalid (infrastructure)**, replaced by T3 |
| **T3** | 7     | dibs | **6/6** | clean      | "All three clauses conform in the agents' code."                                                              | Scored                                       |

**Reading:** same task, same agents, same machines. Without dibs, git merged cleanly but the app broke in the browser: the UI assumed a cookie and the server issued bearer tokens. With dibs, the agents agreed on a contract before building, and every check passed. This is one observation per mode, with raw counts, not a statistic.

## T1: lobby 5, None mode

- **Heads:** claude `4f8e33a`, codex `7508f45`, droid `5c20314`. Out-of-area files: 0. Each session finalized and reported on its own.
- **Oracle 5/6:**
  - Checks 1–5 pass: the server side, login and registration, works.
  - **Check 6 fails:** after Log in → Register, the status stays "Registering…" instead of "Registered".
- **Review:** the UI assumed cookies; authentication uses bearer tokens. The server helper and the registration endpoint conform.
- **Revision timing:** n/a. In None mode no contract is ever delivered.
- **Codex:** last edited `public/app.js` at 19:13, then sat idle until the lobby stopped.

## T2: lobby 6, dibs mode (invalid)

Started 19:34:52, scheduled to stop at 19:49:52.

Claude on M1 didn't have working dibs tools for most of the run:

1. **Launch 1 (19:34:56):** it exited before its startup hook ran.
2. **Relaunch 1 (~19:36:26):** the dibs MCP server didn't load (`failedMcpServers`), so Claude worked without coordination. It named its helper `requireAuth`, not the helper its peers expected, and its head `73aec3f` was never reported.
3. **Relaunch 2 (~19:42):** the bridge joined at 19:42:15, after the fallback (19:40:52).

**Decision, made before the score was known:** a trial counts only if every agent had working dibs tools from launch. T2 is recorded here as **invalid (infrastructure)**: two interventions, and one agent without the system under test for 7 minutes. It was not verified and is replaced by T3. This is not a rerun to change a result.

On GitHub: `lobby/6/droid` (`2397a63`).

## T3: lobby 7, dibs mode

- **Heads:** claude `a2f0d97`, codex `cb0e5a5`, droid `335919a`. All three branches are on GitHub.
- **Oracle 6/6, merge-tree clean.** Check 6 passes in the browser: Log in → Register → "Registered".
- **Review:** all three clauses (`auth.session`, `auth.server`, `events.registration`) conform in the agents' code.
- **Contract deliveries** (first contract or aligned delivery shown to each agent):
  - codex 19:52:47 (contract);
  - claude 19:52:48 (contract);
  - droid 19:54:17 (aligned).
- **Revision timing (Codex):** **built-after-contract**. Its two shared-file edits came after the contract was shown, the last at 19:53:14. There are no transcripts here for Claude or Droid yet.
- **Codex rollout:** `rollout-2026-10-24T19-52-01-…jsonl` on M3.
- **Interventions:** _to add, from Elliot (M1) and Ren Jie (M2)._
- **A premature verification is on record.** At 20:08, `dibs verify 7` ran before the Claude and Droid heads were pushed. It scored Codex's area alone (0/6) and recorded that row. It can't be deleted; the 6/6 verification recorded at ~20:21 supersedes it. Since PR #25:
  - `verify` refuses to run while a head is missing (`--allow-missing` overrides);
  - the dashboard shows the newest verification.

## Earlier, unscored lobbies (development)

| Lobby | Agents                  | Oracle | Note                                                                                                                             |
| ----- | ----------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 3     | Claude (M1), Codex (M3) | 2/6    | No Droid, so registration was unbuilt. Codex had three launches. Both sides bearer. See `STATUS.md` and `infra/LOBBY3_REPORT.md` |
| 4     | Claude, Codex, Droid    | 6/6    | First three-machine handshake (2/2). Codex built after the contract. See `infra/LOBBY4_REPORT.md`                                |

## Evidence

- **Branches:** `lobby/{5,7}/{claude,codex,droid}` and `lobby/6/droid` on GitHub.
- **Verification and review rows:** on `dibs-ch13-dev`, recorded by `verifier`.
- **Reports:** `bench/results/{5,7}/` on M3 (`report.json`, `review.json`, `timing.json`; gitignored).
- **Database dump** (plans, items, jobs, proposals, responses, contracts, deliveries, events, heads for lobbies 5–7): _to add, from Elliot._

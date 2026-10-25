# Two-machine Maincloud test: Windows Claude Code + Mac Codex

Goal: both agents publish plans in one `dibs`-mode S2 lobby on `dibs-ch13-dev`, the Azure worker
analyzes them, both accept the proposed contract (HANDSHAKE 2/2), and the consumer's next edit
follows the contract. The live dashboard shows it.

Nothing here is a secret. Invite codes and tokens never go in this file, chat, or git.

## Pinned inputs (both machines must match)

| Input            | Value                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Database         | Maincloud `dibs-ch13-dev` (`https://maincloud.spacetimedb.com`)                                             |
| Bridge source    | `real` at `6af0cd8e860de0b9a2cb0465dbd1bf5deebbaecd` (#12 bridge + #9 worker); build from this exact commit |
| `bridge.mjs`     | sha256 `cdd9ce44adc239afcf46ad0d5b5a40385b0f0a283088081c376898c3b728e97d`                                   |
| `dibs-hook.mjs`  | sha256 `a9688a8dac4a8fb11321708ce8cefbef0ded058619fba9ae73933abd22a04f7d`                                   |
| Lobby build hash | `ac6cda3a3028cc4baae437efad2ade42f0a08d0113b752db479cbef22792cbc6`                                          |
| Fixture base     | `f4001dc2ace49b3f671521eca59b955625127bef` = `git subtree split --prefix=fixture 8e41fb6`                   |
| Scenario / mode  | `s2` / `dibs`; vocabulary from `fixture/dibs.json`, charter `bench/prompts/charter-s.md`                    |
| Prompt files     | sha256 per provider and mode, in the table below                                                            |

Prompt-file sha256 (role + charter + mode, empty parts dropped, joined by a blank line, one trailing
newline). `mode-none.md` is empty, so a None-mode file is just role + charter:

| Provider | `dibs` mode                                                        | `none` mode                                                        |
| -------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| claude   | `da8864d3f254e41b6954414949051e50dd6d7c79628f5fb37c72ab098691a79c` | `a6284a9e6cfa2f0c834f15d4862e43bbf0b3357fe68b4ed4aefb4995f75d9d90` |
| codex    | `e85be5f559e2fc4f480fe4c15419e097edfea550e66dd534a12003f86648083e` | `91b4ef5fea33fcab48eeed91fe06ca4e284cc9574d1bd4a502ee0b209bc47bc6` |
| droid    | `e9d830bf069723cc1fd7c7a8ff91ad3d7e1a2ccec4fabec60558381fc354f988` | `604332cab419b619748dbfbd78e98e57f776a3436ff5a828a94d85ceadff9ec6` |

Prompts are read from `origin/real`, so **PR #13 (bench) must be merged first**: it adds "No one can
answer questions during this task; make reasonable assumptions and keep going." to every role
prompt, which is what the two hashes above cover. Before #13, `origin/real` still has the old
prompts and the hash check fails. `fixture/` is unchanged by #13, so the fixture base stays valid.

The fixture base is derived from git history, so no `dibs-fixture` GitHub repo is needed. Each
machine pushes its final commit to a local bare repo instead of `dibs-fixture-lobbies`; oracle
verification is out of scope for this test (there is no Droid, so `events.registration` is unbuilt).

Participants on `dibs-ch13-dev`: `worker` (Azure), `admin` and `claude` (Windows laptop), `codex`
(invite created; code delivered privately to the Mac owner).

## Mac (Codex) setup — once

Node ≥ 22, npm, `codex` logged in. From a checkout of `2elliot/dibs`:

```sh
git fetch origin
git worktree add --detach ../dibs-e2e 6af0cd8e860de0b9a2cb0465dbd1bf5deebbaecd
cd ../dibs-e2e
npm ci
npm run build -w @dibs/bridge
shasum -a 256 packages/bridge/dist/bridge.mjs packages/bridge/dist/dibs-hook.mjs   # must match the table
node --input-type=module -e 'import{createHash}from"node:crypto";import fs from"node:fs";const h=createHash("sha256");for(const r of["dist/bridge.mjs","dist/dibs-hook.mjs"]){h.update(r);h.update("\0");h.update(fs.readFileSync("packages/bridge/"+r));h.update("\0")}console.log(h.digest("hex"))'
```

The last line prints the build hash `dibs session prep` compares with the lobby. It must equal the
table's `ac6cda3a…` (M1 got it from the same commit) **before** the admin runs
`lobby create --build <hash>`. If it differs, stop and send both files' hashes to the Windows
operator (fallback: copy the Windows `dist/` files over yours; the build hash covers only those two
files). Build from the pinned commit even after `real` moves on, so both machines stay identical.

Join with the invite code you were sent (paste it into a file; don't echo it):

```sh
npm run dibs -- join --uri https://maincloud.spacetimedb.com --db dibs-ch13-dev --participant codex --code "$(cat ~/codex-invite.txt)"
rm ~/codex-invite.txt
```

Fixture clone, lobbies repo, and prompt. Keep `~/dibs-clones` free of other clones, the dibs repo
and bench files: the pilot showed Codex reads neighbouring folders.

```sh
git subtree split --prefix=fixture 8e41fb6        # must print f4001dc2ace49b3f671521eca59b955625127bef
mkdir -p ~/dibs-clones/codex/fixture && git -C ~/dibs-clones/codex/fixture init -b main
git push ~/dibs-clones/codex/fixture f4001dc2ace49b3f671521eca59b955625127bef:refs/heads/base
git -C ~/dibs-clones/codex/fixture checkout -B main base
npm ci --prefix ~/dibs-clones/codex/fixture
git init --bare ~/dibs-lobbies.git
node -e 'const x=require("child_process").execSync;const r=f=>x("git show origin/real:bench/prompts/"+f).toString().trim();process.stdout.write([r("roles/s2-codex.md"),r("charter-s.md"),r("mode-dibs.md")].filter(Boolean).join("\n\n")+"\n")' > ~/dibs-prompt-codex.txt
shasum -a 256 ~/dibs-prompt-codex.txt             # must match the table
```

(`git subtree` missing from Apple git → `brew install git`.) Windows builds the Claude prompt the
same way with `roles/s2-claude.md` and checks it against the Claude hash in the table. For a
None-mode lobby use `mode-none.md`; keep the `.filter(Boolean)`, because without it the empty file
adds a trailing blank line and the hash no longer matches.

Headless check. `dibs session start` launches the agent with no TTY (stdin ignored, output to
`~/.dibs/codex/agent.log`). Claude Code falls back to print mode on its own; check whether Codex does:

```sh
cd "$(mktemp -d)" && codex "Reply with the single word OK." </dev/null >codex-tty.log 2>&1; echo "exit $?"; cat codex-tty.log
```

If that fails, launch `codex exec` instead by exporting this before `session start` (after `prep`):

```sh
export DIBS_AGENT_COMMAND="$(node -e 'const p=require("fs").readFileSync(process.argv[1],"utf8").trim();console.log(JSON.stringify(["codex","exec","--sandbox","workspace-write","-c","sandbox_workspace_write.network_access=true",p]))' ~/dibs-prompt-codex.txt)"
```

Record what happened (and whether hooks fire under `codex exec`) in `docs/compatibility.md`.

## Run sequence

1. **Admin (Windows)** creates the lobby and posts its id `N`:
   `npm run dibs -- lobby create --scenario s2 --mode dibs --base f4001dc2ace49b3f671521eca59b955625127bef --manifest <fixture/dibs.json> --charter <charter-s.md> --build ac6cda3a3028cc4baae437efad2ade42f0a08d0113b752db479cbef22792cbc6`
   only after M3 has confirmed its build hash matches.
2. **Mac, trust pass (before the lobby starts):** delete any existing
   `[projects."…/dibs-clones/codex/fixture"]` table from `~/.codex/config.toml`, so `prep` doesn't
   write the key a second time. Then:
   ```sh
   npm run dibs -- session prep N --participant codex --provider codex --clone ~/dibs-clones/codex/fixture --lobbies ~/dibs-lobbies.git --prompt-file ~/dibs-prompt-codex.txt
   ```
   Run `codex` interactively once in `~/dibs-clones/codex/fixture`, accept the hook-trust prompt,
   and quit: the new `hooks.json` voids the old trust. Don't `session start` from this `prep`.
3. **Admin** runs `npm run dibs -- lobby start N` and says so at once.
4. **Every machine, right after `lobby start`:** run `prep` again, then `session start`:
   ```sh
   npm run dibs -- session prep N --participant codex --provider codex --clone ~/dibs-clones/codex/fixture --lobbies ~/dibs-lobbies.git --prompt-file ~/dibs-prompt-codex.txt
   npm run dibs -- session start --participant codex
   ```
   **`prep` must run after `lobby start`.** `prep` copies the lobby's `endsAtUs` into
   `session.json`; before the start it is `0`, and `session start` then never stops the agent at
   +15 min (lobby 4: Codex had to be stopped by hand). The second `prep` rewrites `hooks.json`
   byte-for-byte, so Codex's trust from step 2 holds, and it resets `hook-alive.json`.
   Windows does the same for `claude` (`~/dibs-clones/claude/fixture`). This laptop has no system
   Node or `claude` on PATH: run from a worktree built at the pinned `real` commit with the
   Codex-runtime `node.exe` directory prepended to `PATH` (the generated MCP and hook configs call
   `node` by name) and `DIBS_CLAUDE_BIN` pointing at the Claude Code 2.1.308 `claude.exe`.
   Droid (if seated) launches with `droid exec --auto high`: `--auto medium` stopped on
   "insufficient permission" 15 s in (lobby 4).
5. **~20 s after each launch, check the agent is online** in the lobby (dashboard roster, or
   `spacetime sql --server maincloud dibs-ch13-dev "SELECT name, online, current_lobby_id FROM participant"`) and that its log shows a dibs
   tool call. If it isn't, relaunch at once (`session start` again). In lobby 6 the first relaunch's
   dibs MCP server never connected (the agent's ToolSearch found no dibs tools), and the agent
   worked the whole run without dibs; that trial is void.
6. Fallback is at +6 min, the lobby stops at +15 min, and then each `session start` commits, pushes
   `lobby/N/<provider>` to the local bare repo, and calls `report_head`. Push `lobby/N/<provider>`
   to GitHub afterwards so the verifier on M3 can fetch it.

**Timing limits in `dibs session start`** (both seen in lobby 3):

- **2 minutes to start the lobby.** `session start` waits at most 120 s for the lobby to become
  `running`, then exits with `lobby did not start (last state: setup)`. With `prep` after
  `lobby start` (step 4) the lobby is already running, so this no longer bites; it only matters if
  someone runs `session start` early. Every minute a machine is late is a minute its agent loses.
- **30 seconds for the SessionStart hook.** After launching the agent, `session start` kills it if
  `hook-alive.json` for this lobby doesn't appear within 30 s. A launch path whose hooks don't run
  (for example `codex exec`) is always killed here. Check that the agent's hooks fire before the lobby.

Don't type into either agent during the run; that counts as an intervention.

**Known gaps that cost a handshake** (open in other issues; work around them, don't patch locally):

- **An agent can finish before its partner plans.** The Stop hook doesn't block while another
  lobby agent still has no plan, so a fast agent sees its keys read `clear` (analysis on its plan
  alone) and exits. Lobbies 3 and 7 lost their handshake this way (lobby 7: Claude exited ~3 min
  in, before Codex planned). Mitigation until fixed: launch all agents within seconds of each
  other (step 4) so plans land close together.
- **Analysis can run before the roster is complete.** The job is promoted once the agents that
  have joined are planned, not the expected roster, which is what gives the early `clear`.
- **`dibs_plan` rejects statements over 500 characters.** Agents recover by republishing (Droid:
  8 s in lobby 4); expect one rejected call in the log.
- **Dashboard "Analysis offline" badge** looks for a `service` row named `analysis`; the worker
  heartbeats as `worker`. Check the worker with `/health/status` instead.

## Evidence to collect

```sh
spacetime sql --server maincloud dibs-ch13-dev "SELECT id, participant_id, revision, current FROM plan WHERE lobby_id = N"
spacetime sql --server maincloud dibs-ch13-dev "SELECT id, plan_id, participant_id, kind, key, text FROM plan_item WHERE lobby_id = N"
spacetime sql --server maincloud dibs-ch13-dev "SELECT id, kind, state, attempts, calls, error FROM job WHERE lobby_id = N"
spacetime sql --server maincloud dibs-ch13-dev "SELECT id, key, revision, relation, state, contract_text, cited_item_ids, required_party_ids FROM proposal WHERE lobby_id = N"
spacetime sql --server maincloud dibs-ch13-dev "SELECT proposal_id, revision, participant_id, decision, reason FROM response WHERE lobby_id = N"
spacetime sql --server maincloud dibs-ch13-dev "SELECT key, revision, source, text, current FROM contract WHERE lobby_id = N"
spacetime sql --server maincloud dibs-ch13-dev "SELECT target_id, kind, stage FROM delivery WHERE lobby_id = N"
```

- Worker: `/health/status` on the Azure URL shows a non-null `lastAnalysisLatencyMs`; the `service`
  row's heartbeat keeps advancing.
- Dashboard: https://dibs.grayriver-bbcb643c.westus2.azurecontainerapps.io follows the newest live lobby.
- Consumer's next edit: the agent transcript (Claude: `~/.claude/projects/<clone slug>/*.jsonl`;
  Codex: its session log) shows the first edit to a shared-key file after the `contract` delivery,
  and `git diff f4001dc lobby/N/<provider>` shows the final code uses the agreed transport.

## Windows smoke result — lobby 1, 2026-10-24 (not the two-machine test)

Scripted, single participant. It proves the Windows side and the cloud worker, not a handshake.

- `dibs join` as `admin` and `claude` on `dibs-ch13-dev`; `codex` invite created, unused.
- Bridge build on Windows matches the table; bridge unit tests 34 passed, 1 skipped (live).
- Lobby 1 (`s2`, `dibs`, base `f4001dc`, build `0f9c811d…` from the pre-merge bridge `f80f3dc`; superseded) created and started by `admin`.
- A scripted MCP client drove the real bridge as `claude`: `dibs_plan` → plan 1 → job 1
  `debouncing` → `queued` → leased by `worker` (Azure) → `analysis_submitted` → `done`, 1 attempt,
  1 call, no error. One producer plan gave no findings, so both keys reported `clear`.
  `/health/status`: `lastAnalysisLatencyMs` 1578, `anthropicErrors` 0.
- Live dashboard followed lobby 1: countdown, all 9 timeline events, claude's plan statements.
- Real `dibs session start --participant claude` with Claude Code 2.1.308 headless (prompt `/dibs`):
  SessionStart hook wrote `hook-alive.json`, the agent called `dibs_status` through the bridge,
  then finalize committed, pushed `lobby/1/claude` to the local bare repo, and `report_head` wrote
  head 1 (`8dd5bc9`, no out-of-area files). 17 s end to end. Lobby 1 then stopped by `admin`.

Observations:

- Claude Code 2.1.308 falls back to print mode when `dibs session start` gives it no TTY; no `-p` needed.
- The bridge answers `initialize` before its DB connection is up (~1 s on Maincloud); tool calls in
  that window return `status: offline` and are not retried by the bridge.
- The worker leased 12.4 s after `job_queued`: it polls every `leaseRescanSec` (15 s) instead of
  reacting to the `job` subscription (`apps/worker/src/worker/loop.ts`). Within budget; fix needs a redeploy.
- The dashboard's "Analysis online" badge looks for a `service` row named `analysis`; the worker
  heartbeats as `worker`, so the badge reads "Analysis offline" while the worker is healthy.

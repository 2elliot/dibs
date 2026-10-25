# Metrics

`dibs verify` gives one number per lobby: x/6 oracle checks. That says whether the combined code works, but on its own it is a coin flip per trial (T1 5/6 vs T3 6/6 is Fisher p = 1.0). These two commands turn each lobby into measured numbers and compare arms with intervals.

```sh
# 1. After verify (and optionally review / revision-timing), per lobby:
npx tsx bench/scripts/metrics.ts <lobbyId> \
  --transcript claude=<project .jsonl> --transcript codex=<rollout.jsonl> --transcript droid=<log> \
  --interventions 0
# 2. Across lobbies (default: every results/<id>/metrics.json), none vs dibs:
npx tsx bench/scripts/compare.ts --all [--exclude 6] [--label 3=dev]
```

`metrics` writes `bench/results/<id>/metrics.json`. `compare` writes `bench/results/compare.{md,json,csv}`: the markdown table goes straight into `TRIALS.md`, the CSV opens in a spreadsheet (one row per lobby).

## Inputs

All optional. A metric whose input is missing is `null` (shown as `–`), never 0; `sources` in `metrics.json` lists what was read.

| Input                           | Where from                                                                                                                      | Gives                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `db.json`                       | Exported automatically when this machine joined as the verifier; or `--dump <file>` (camelCase tables or a snake_case SQL dump) | time, coordination, keys, heads             |
| `report.json`, `assembled.diff` | `dibs verify`                                                                                                                   | outcome, lines/files per agent area         |
| `review.json`                   | `dibs review`                                                                                                                   | clauses conforming / violated, root cause   |
| `timing.json`                   | `revision-timing.ts`                                                                                                            | shared edits before / after the contract    |
| `--transcript <agent>=<path>`   | Claude Code project `.jsonl`, Codex rollout, Droid or any log with `usage` objects; repeat per launch                           | tokens, tool calls, active time             |
| `--interventions <n>`           | the operator's log                                                                                                              | human keystrokes or relaunches after launch |

Transcript paths, interventions and `--mode` are saved in `metrics-inputs.json`, so a re-run gives the same numbers.

## What is measured

Times are seconds after `lobby.startedAtUs`.

| Group        | Metric                                                                               | Definition                                                                             |
| ------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Outcome      | `passed`, `passRate`, `fullPass`, `checks`                                           | Oracle checks; `fullPass` = all six (the combined app works end to end)                |
|              | `mergeTreeClean`, `outOfAreaFiles`                                                   | From verify                                                                            |
|              | `reviewConforms`, `reviewViolations`                                                 | Review clause verdicts                                                                 |
| Time         | `firstPlanSec`, `allPlansSec`                                                        | First plan; every agent has published                                                  |
|              | `firstProposalSec`, `firstContractSec`                                               | First conflict proposal; first agreed or aligned contract                              |
|              | `allSettledSec`                                                                      | Every key with a producer and a consumer has a contract                                |
|              | `lastEditSec`, `lastHeadSec`                                                         | Last shared-file edit (timing); last reported head                                     |
| Coordination | `planRevisions`, `messages`, `proposals`, `proposalRounds`, `rejects`, `escalations` | Row counts for the lobby                                                               |
|              | `sharedKeys`, `settledKeys`                                                          | Keys with both sides; how many ended agreed or aligned                                 |
|              | `receiveLatency`, `showLatency`, `responseLatency`                                   | Delivery queued→received, received→shown, proposal shown→responded (median and max ms) |
|              | `analysisJobs`, `analysisCalls`, `analysisFailures`                                  | Worker effort                                                                          |
| Work         | `linesAdded`, `linesRemoved`, `filesChanged`                                         | From `assembled.diff`, split by each agent's area                                      |
|              | `sharedEditsBefore/AfterContract`, `postContractShare`                               | How much of the shared work followed the agreement                                     |
| Cost         | `inputTokens`, `cachedInputTokens`, `outputTokens`, `totalTokens`                    | Claude: each API message once; Codex: running total per launch, launches added         |
|              | `toolCalls`, `agentActiveSec`                                                        | Tool-use blocks; first to last transcript line, summed over agents                     |
| Human        | `interventions`                                                                      | As logged                                                                              |

Every number is also broken down per agent (`perAgent`) and per key (`keys`: producers, consumers, outcome, rounds, rejects, settle time).

## Comparing arms

The arm is the lobby's `mode` (`none`, `chat`, `dibs`), or `--label <lobbyId>=<arm>`. The default comparison is `none` → `dibs`.

- **Rates** (full pass, each check): k/n with a 95% Wilson interval, and a two-sided Fisher exact test for the difference.
- **Numbers**: mean ± sd (median), and the difference in means with a 10,000-sample percentile bootstrap 95% CI (seed 42, so it's reproducible). With one lobby in an arm there's no interval, and the table says so.
- **Planning**: the report says how many lobbies per arm would detect the observed full-pass difference at p < 0.05 with 80% power. As a rule of thumb, 20% → 80% needs 10 per arm.
- **Warnings**: fewer than 5 lobbies in an arm, lobbies scored by different oracle hashes, or started from different bases.

## Any agent

Agents are keyed by participant name, not by the three bench providers. Areas are looked up by name first, then by provider, so a manifest can give an area to any agent that joins. The protocol still lists only `claude`, `codex` and `droid` as providers (`packages/protocol`, frozen); widening that is the one change needed to plug in other agents.

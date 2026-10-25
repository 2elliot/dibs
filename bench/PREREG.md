# Pre-registration: dibs benchmark, round 2

Written and committed **before** any round-2 trial. The commit time on this file is the proof that the metric, sample size, order and exclusion rules weren't chosen after seeing results. Any later change is a new commit with a reason, and the report lists it.

## Questions

| #      | Hypothesis                                                                                                 | Measured by                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **H1** | **Primary.** In S2, dibs raises the full-stack integration pass rate over no coordination (`none`).        | Oracle check 6 (tier `fullstack`), dibs vs none                       |
| H2     | dibs also beats agents that can message each other but get no conflict detection (`chat`).                 | Check 6, dibs vs chat                                                 |
| H3     | dibs doesn't change single-agent quality: the effect is on how the parts fit, not on each part.            | Tier `component` (checks 1–2): no difference expected                 |
| H4     | When the work doesn't overlap (scenario N), dibs raises no proposals and doesn't slow the team down.       | Proposals on N; time to last head, dibs vs none                       |
| H5     | The detector finds planted mismatches and stays quiet on consistent plans, on cases it was never tuned on. | `bench/scripts/detector.ts --split heldout`: recall, false-alarm rate |

## Fixed for every trial

- **Fixture base:** `f4001dc`. **Oracle:** `bench/oracle.hash` at this commit (bench-v1). **Prompts:** `bench/prompts/manifest.json` at this commit.
- **Agents:** Claude Code, Codex and Droid, with the same launch commands, model settings and machines as T1/T3. Record each agent's version and model at launch.
- **Lobby:** 15 minutes, fallback at +6 min, zero keystrokes after launch.
- **Mode** is the only thing that differs between arms, as written in `bench/prompts/mode-{none,chat,dibs}.md`.

## Design and sample size

- **Arms:** `none`, `chat`, `dibs`.
- **S2 (planted conflict):** 6 lobbies per arm, 18 in all. This is the primary test.
- **N (unrelated work):** 2 per arm, `none` and `dibs` only. This is the control for H4.
- **S1 (natural conflicts):** 2 per arm, `none` and `dibs`. Exploratory only; no claims from it.

Why 6 per arm: if dibs passes check 6 in 6/6 and `none` in 1/6, Fisher's exact test gives p = 0.015. With 5 per arm, 1/5 vs 5/5 gives p = 0.048, and anything weaker isn't significant. A 20% → 80% difference needs about 10 per arm at 80% power. So 6 per arm only detects a large effect. That is the effect T1/T3 suggests, and it's what we can afford. The report states this limit.

| none | dibs | Fisher p (two-sided) |
| ---- | ---- | -------------------- |
| 0/6  | 6/6  | 0.002                |
| 1/6  | 6/6  | 0.015                |
| 1/6  | 5/6  | 0.080                |
| 2/6  | 6/6  | 0.061                |

## Order

Lobbies run in blocks: one lobby of each arm per block, in a random order generated with seed `20261025` (mulberry32, `packages/verifier/src/stats.ts`). Arms are interleaved so API slowdowns, time of day and operator fatigue don't land on one arm.

| #   | Block | Scenario | Arm  |
| --- | ----- | -------- | ---- |
| 1   | S2-1  | s2       | chat |
| 2   | S2-1  | s2       | dibs |
| 3   | S2-1  | s2       | none |
| 4   | S2-2  | s2       | none |
| 5   | S2-2  | s2       | chat |
| 6   | S2-2  | s2       | dibs |
| 7   | S2-3  | s2       | chat |
| 8   | S2-3  | s2       | none |
| 9   | S2-3  | s2       | dibs |
| 10  | S2-4  | s2       | chat |
| 11  | S2-4  | s2       | none |
| 12  | S2-4  | s2       | dibs |
| 13  | S2-5  | s2       | none |
| 14  | S2-5  | s2       | dibs |
| 15  | S2-5  | s2       | chat |
| 16  | S2-6  | s2       | chat |
| 17  | S2-6  | s2       | dibs |
| 18  | S2-6  | s2       | none |
| 19  | N-1   | n        | dibs |
| 20  | N-1   | n        | none |
| 21  | N-2   | n        | dibs |
| 22  | N-2   | n        | none |
| 23  | S1-1  | s1       | dibs |
| 24  | S1-1  | s1       | none |
| 25  | S1-2  | s1       | dibs |
| 26  | S1-2  | s1       | none |

**Stopping rule:** if time runs out, stop at the end of a block, never in the middle and never because of a result. Report how many blocks were completed. Blocks run in the order above.

## Validity and exclusions

These rules carry over the T2 decision.

- **Invalid (infrastructure):** a trial is invalid when an agent fails to launch, or, in `dibs` and `chat`, doesn't have working coordination tools from launch. This is decided from the launch logs before anyone looks at the oracle. Invalid trials are listed in the report with the reason, and re-run at the end of the schedule in the same arm.
- **Interventions:** any keystroke or relaunch after launch is logged with the time and reason. The trial still counts. The report repeats the primary test without trials that had interventions, as a sensitivity check.
- **No reruns to change a result.** A valid trial's score is final, including a 0/6.
- **Premature verification:** `dibs verify` refuses missing heads (PR #25). If a verification is recorded too early anyway, the first complete one counts.

## Analysis (fixed now)

- **Per lobby:** `npx tsx bench/scripts/metrics.ts <id> --transcript <agent>=<log>… --interventions <n>`.
- **Across lobbies:** `npx tsx bench/scripts/compare.ts --all --baseline none --treatment dibs`, then again with `--baseline chat`.
- **Primary test:** two-sided Fisher exact test on tier `fullstack`, dibs vs none, α = 0.05. There is one primary test, so no multiple-comparison correction applies to it. H2–H4 are reported with their intervals and labelled secondary.
- **Always reported:** 95% Wilson intervals for every rate, bootstrap intervals for every difference in means, and invalid and excluded trials. A result that doesn't support a hypothesis is reported the same way as one that does.
- **Detector (H5):** `detector.ts --runs 10` with the held-out split as the headline and the dev split shown separately. The held-out cases were written after the analysis prompt was tuned and weren't used to tune it. If the prompt changes, re-run both splits and report the new prompt hash.

## Known limits, stated up front

- The held-out detector cases were written by the same team (with AI help) that built dibs. For an independent check, have someone outside the team write 5 more and add them as split `external`.
- One task family (a login and registration app). The results say nothing yet about other codebases.
- The oracle is ours. Its sensitivity is checked by mutation testing (`bench/scripts/oracle-mutants.ts`), and it will be published with `oracle.hash` so anyone can re-run it.

## Amendments

**2026-10-25 01:50 PT, after the first detector run (`--runs 10`, held-out recall 80/80, false alarms 52/260).** Added a secondary breakdown of H5 by the relation the detector chose:

- **Catches** split into mismatches called a `conflict` (recognised as a clash) and those given a `dependency` (contract forced, but the clash not named).
- **False alarms** split into consistent keys called a `conflict` (the damaging kind: "these won't work together" when they would) and those given a `dependency` or `duplicate` (an unneeded request to confirm).

The strict definition above stays the headline: any proposal on a consistent key is a false alarm. The breakdown is computed from the same saved run (`detector.ts --from runs.jsonl`), with no new model calls, and the report labels it as added after the run.

**2026-10-25 02:05 PT, same run.** Added a second secondary split of H5's false alarms: consistent keys in plan sets where every key is consistent, vs consistent keys in plan sets that also contain a real mismatch, where an alarm can spill over from the real conflict. Same saved run, no new model calls; the strict rate stays the headline.

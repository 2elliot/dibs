# Evaluation

How the dibs benchmark avoids being arbitrary. Four independent pieces of evidence, each with a command, plus a pre-registered plan and one report that pulls them together. The per-lobby numbers are defined in [`METRICS.md`](METRICS.md).

| #   | Question                                                 | Evidence                                                                                     | Command                                                              | Needs            |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------- |
| 1   | Does dibs find conflicts from plans alone?               | Detector accuracy on labelled plan sets, run many times                                      | `detector.ts --runs 10`                                              | model API key    |
| 2   | Which part of the code failed?                           | Oracle checks grouped into tiers by whose code they need                                     | `metrics.ts`, `compare.ts`                                           | –                |
| 3   | Is the hidden test fair?                                 | Mutation testing: a known-good solution broken one behaviour at a time                       | `lobby-evidence.ts --mutants 7` (anywhere), `oracle-mutants.ts` (M3) | oracle key (2nd) |
| 4   | Why did a lobby pass or fail, independent of the oracle? | Each lobby rebuilt from its GitHub heads, started, and probed                                | `lobby-evidence.ts <ids>`                                            | –                |
| 5   | Do the trials support a claim?                           | Pre-registered round 2 ([`PREREG.md`](PREREG.md)), compared with intervals and an exact test | `compare.ts --all`                                                   | trials           |

Everything is drawn into one page with every input bundled:

```sh
npx tsx bench/scripts/report.ts      # bench/results/report/{report.html, report-data.json, data/}
```

Sections without data yet render as **pending**, with the command that fills them. Every number on the page is marked **measured** (computed from the code on GitHub when the report was built), **recorded** (from the trial reports: the oracle and review run on M3), or **pending**.

## 1. Detector benchmark

- **Cases:** `bench/detector/cases.json`.
  - 6 **dev** sets from `bench/dev/`. These were used to tune the analysis prompt.
  - 12 **held-out** sets, written after tuning and never used for it: 8 with a planted mismatch, 4 fully consistent. Each item stays under the 500-character plan limit.
- **Labels:** each shared key (one agent produces it, another requires it) is labelled `mismatch` (a proposal is expected) or `consistent` (a proposal is a false alarm).
- **Runner:** `bench/scripts/detector.ts` calls the worker's own `runAnalysis`, with the same prompt, model client and validation as production. It writes `detector.json` and `runs.jsonl`, the latter holding every raw finding for audit.
- **Metrics,** per split, with 95% Wilson intervals:
  - **recall**: mismatched keys that got a proposal;
  - **false-alarm rate**: consistent keys that got a proposal;
  - **precision**;
  - **whole-case accuracy**;
  - latency and output tokens.
- **Headline:** the held-out split. The dev split is shown separately.
- **`--self-test`** builds a perfect fake from the labels and pushes it through the real validation. It proves the wiring and is never a result.
- **Limit:** the held-out sets were written by the team, with AI help. For a stronger claim, have someone outside the team add a few as split `external`.

## 2. Oracle tiers

`ORACLE_TIERS` in `packages/verifier/src/metrics.ts` groups the S1/S2 checks by whose code each one needs. This was checked against the lobby code: Droid's route imports Claude's `getCurrentUser`.

| Tier        | Checks  | Code it needs                                                           |
| ----------- | ------- | ----------------------------------------------------------------------- |
| `component` | 1, 2    | Claude's auth alone                                                     |
| `server`    | 3, 4, 5 | Droid's registration route calling Claude's helper (`auth.server`)      |
| `fullstack` | 6       | Codex's UI against both servers (`auth.session`, `events.registration`) |

`metrics.json` reports each tier as pass/fail. `compare.ts` reports each tier's rate, interval and Fisher p. The primary metric is `fullstack`.

## 3. Oracle mutation testing

- **Mutants:** `bench/oracle-mutants.json` holds 8 exact, single-behaviour edits to lobby 7's assembled tree (6/6). Each lists the checks it must fail and the checks it must still pass. Every check 1–6 is targeted at least once, and `ui-drops-auth-header` reintroduces T1's bug.
- **Anywhere:** `lobby-evidence.ts 7 --mutants 7` starts each mutant and confirms it changes exactly the behaviour it claims. This validates the mutants.
- **On M3:** `oracle-mutants.ts` runs the hidden oracle on the unmutated control and every mutant. It writes `results/oracle-mutants.json` and exits non-zero if a mutant survives or fails the wrong checks. This validates the oracle.

## 4. Lobby evidence

`lobby-evidence.ts <ids>` assembles each lobby by area from `lobby/<id>/*` on GitHub, exactly as `dibs verify` does, and writes three things to `results/<id>/`:

- `assembled.diff`;
- merge-tree and out-of-area files;
- `evidence.json`, a behaviour probe of the running app. It records the HTTP answers behind checks 1–5, and how the UI carries the session, which check 6 depends on.

The probe only talks to a server it started itself. It is evidence, never a score. For T1 it shows the server issuing `{token}` and setting no cookie, while the UI never reads the token, never sends `Authorization`, and uses `credentials: "same-origin"`.

## 5. Trials

- **Registry:** `bench/trials.json` lists every lobby with status `scored`, `invalid` (with the reason, decided before scoring) or `dev`. Round-2 lobbies add `"prereg": <row>` to link them to their schedule row in `PREREG.md`.
- **What gets compared:** only `scored` lobbies.

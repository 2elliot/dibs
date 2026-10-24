# @dibs/verifier

This package provides `dibs verify` and `dibs review` (plan §7). Both run on M3, which holds the oracle key.

## dibs verify

```sh
npm run dibs -- verify <lobbyId> --remote <dibs-fixture-lobbies URL or local path> [--base <sha>] [--json]
```

1. It fetches `lobby/<id>/{claude,codex,droid}` into a cache repo at `bench/.work/lobbies.git`. `DIBS_LOBBIES_REMOTE` can stand in for `--remote`.
2. It assembles a fresh worktree at the base, by area, using `fixture/dibs.json`. Each head contributes only the changes inside its own area. Deletes apply, and frozen files never change. Anything outside the area is ignored and listed as `outOfArea`.
   - The base is `lobby.baseSha` when this machine has joined as the verifier (see below). Otherwise it is the heads' common ancestor, or `--base`.
3. It records whether `git merge-tree --write-tree` of the heads would merge cleanly. This is information only. On git older than 2.38 it falls back to an octopus merge in a throwaway worktree.
4. It decrypts `bench/oracle.enc` into `bench/.work/oracle-<uuid>` and checks the hash against `bench/oracle.hash`.
5. It runs the six checks: app on 4140–4149, Chromium from the root `@playwright/test`, 5-minute timeout.
6. It deletes the plaintext.
7. It writes these files to `bench/results/<id>/`:
   - `report.json`;
   - `oracle.log`;
   - `assembled.diff`;
   - `verification.json`, the `record_verification` arguments.

The assembled tree stays in `bench/.work/lobby-<id>/tree` for `dibs review`.

Exit code: 0 for 6/6, 1 for less, 2 for an error.

## dibs review

```sh
npm run dibs -- review <lobbyId> [--runner sdk|exec|fake] [--contracts contracts.json] [--kind conformance|diagnosis]
```

The review is advisory and never changes pass/fail. It runs on a throwaway copy of the assembled tree, without `node_modules`, `.git`, `.factory`, `.claude` or `.codex`.

Its input has three parts:

- **Clauses.** These are the contracts (`--contracts`: `[{key,text,source}]`), or the charter's three interfaces from `fixture/dibs.json` when there are none.
- **The oracle report.**
- **The diff against the base.**

The output is validated against `REVIEW_SCHEMA` and saved to `results/<id>/review.json` and `review-row.json` (the `record_review` arguments).

There are three runners:

- **`sdk`** (default) uses `@factory/droid-sdk/node`, version 0.10.0, which is installed in this workspace. It calls `run(prompt, { cwd, autonomyLevel: AutonomyLevel.Off, outputFormat: { type: "json_schema", schema: REVIEW_SCHEMA } })`, with no `permissionHandler`, and reads `result.structuredOutput`. It needs `droid` on PATH and `FACTORY_API_KEY`.
- **`exec`** runs `droid exec --cwd <copy> -f review.md -o json`. Use it only as a fallback, and ask Factory first whether it counts for the prize. It has no schema flag, and exit 0 doesn't mean success, so the JSON is extracted and validated here.
- **`fake`** is deterministic and offline. It is used by the tests and for dry runs.

## Tests

```sh
npm test -w @dibs/verifier                    # needs bench/oracle/ (plaintext, M3)
DIBS_TEST_UI=1 npm test -w @dibs/verifier     # also asserts check 6 (Chromium installed)
```

The tests build a local repo whose `lobby/1..3/<provider>` branches come from the cookie, bearer and mismatch references, with out-of-area and frozen-file edits added. They check four things:

- the three results: 6/6, 6/6, and the mismatch failing only check 6;
- the out-of-area list;
- that the plaintext oracle is cleaned up;
- the fake review against `REVIEW_SCHEMA`.

## Human steps (not done by code)

- **Create the GitHub repos.** Make `dibs-fixture` from `fixture/` with a protected `main`, and `dibs-fixture-lobbies`, private until 22:45. Every machine needs non-interactive push access to the lobbies repo.
- **Factory.** Get `FACTORY_API_KEY` and install `droid` on M3. Run one `dibs review --runner sdk` (Gate 0 / 09:00) to prove the package, the auth and the schema output. Ask Factory whether `droid exec` counts.
- **Key.** It lives only on M3 at `~/.dibs/oracle.key`, so back it up. At 22:45, publish `bench/oracle/` so judges can check it against `oracle.hash`.
- **Run on Windows.** On M1 or M2, after `npm install`, `npm ci --prefix fixture` and `npx playwright install chromium`, run `npx tsx bench/scripts/oracle-unpack.ts`, then `npx tsx bench/scripts/check-oracle.ts`. This needs the key, so copy it over temporarily with `DIBS_ORACLE_KEY` and don't save it.

## Recording to the database

With `[module-ready]` merged, both commands record through `@dibs/client` when this machine has joined as the verifier:

```sh
npm run dibs -- join --uri <db uri> --db <db name> --participant verifier --code <verifier invite code>
```

The participant name comes from `DIBS_VERIFIER` and defaults to `verifier`. With that token, these steps are added:

- **`dibs verify`** reads `lobby.baseSha`, calls `record_verification`, then `mark_verified`.
- **`dibs review`** uses the lobby's current contracts as the clauses, and the newest verification id. It then calls `record_review`.

Without the token, or with `--local`, the reducer arguments are only written to `results/<id>/`.

`dibs verify <id> --review sdk|exec|fake` reviews straight away. This is for demo lobbies; benchmark reviews are batched at 21:00.

The database path is type-checked against the generated bindings but **not yet run against a live server**. This machine had no SpacetimeDB. The first real check is one `dibs sim` lobby with a verifier invite.

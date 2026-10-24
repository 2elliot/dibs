# bench

The evidence side of dibs (issue 4, owner C, machine M3). Commands run from the repo root.

| Path                        | What                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompts/`                  | Charters (`charter-s.md`, `charter-n.md`), mode text (`mode-*.md`), role prompts (`roles/`), `scenarios.json`, `manifest.json` (hashes; frozen at Freeze 1) |
| `oracle.enc`, `oracle.hash` | The hidden oracle + the three reference solutions, AES-256-GCM. Committed; useless without the key                                                          |
| `oracle/`                   | Plaintext oracle (gitignored, M3 only): `oracle.test.mjs` and `references/{cookie,bearer,mismatch}/`                                                        |
| `scripts/`                  | `check-oracle`, `oracle-pack`, `oracle-unpack`, `compose-prompt`, `hash-prompts` (run with `npx tsx`)                                                       |
| `results/<lobbyId>/`        | `dibs verify` / `dibs review` output (gitignored)                                                                                                           |

## M3 setup (once)

```sh
npm install
npm ci --prefix fixture                 # the app's own deps, shared into assembled trees
npx playwright install chromium         # check 6
# The key: ~/.dibs/oracle.key (mode 600), or DIBS_ORACLE_KEY=<64 hex>. Back it up off-repo.
npx tsx bench/scripts/oracle-unpack.ts  # only if bench/oracle/ is missing
npx tsx bench/scripts/check-oracle.ts
```

`check-oracle` is Gate 0 (c). Expected: scaffold 0/6, cookie 6/6, bearer 6/6, and mismatch 5/6 with check 6 (the UI) failing. The failure shows "Please log in first": the UI never sent the bearer token.

## The oracle

These six checks are black-box. The oracle auto-detects the session transport: an httpOnly cookie, or a bearer `{token}`. It starts the app on ports 4140–4149 and finishes within a 5-minute timeout.

1. A valid login gives a session that `/api/me` accepts.
2. A bad password returns 401.
3. Alice registers (201), and registering again returns 409.
4. Bob's registration is distinct (201, different id).
5. An unauthenticated registration returns 401.
6. Playwright, from the root `@playwright/test`: Log in → Register → "Registered". It never skips; if no browser can start, it fails and says why.

Changing it: edit `bench/oracle/`, run `check-oracle`, then run `npx tsx bench/scripts/oracle-pack.ts`. Commit `oracle.enc` and `oracle.hash`. A new hash means earlier scores aren't comparable. `oracle-pack` creates `~/.dibs/oracle.key` if there's no key.

## Prompts

```sh
npx tsx bench/scripts/compose-prompt.ts --scenario s2 --mode dibs --provider claude
npx tsx bench/scripts/hash-prompts.ts            # after any prompt edit; commit manifest.json
npx tsx bench/scripts/hash-prompts.ts --check    # Freeze 1 check
```

## 09:30 pilot (unscored, M3)

S2 None-mode prompts with the `dibs_plan` sentence removed, in three clones of `dibs-fixture`:

```sh
for p in claude codex droid; do npx tsx bench/scripts/compose-prompt.ts --scenario s2 --mode none --provider $p --pilot > pilot-$p.txt; done
```

Launch each agent in its own clone with its prompt. When they finish, push each clone to `lobby/900/<provider>` in a scratch repo, then run:

`npm run dibs -- verify 900 --remote <that repo>`

Answer these:

- Does it fail as designed?
- Do the agents hedge?
- Are there out-of-area edits? The report lists them.
- Does it fit in 15 min?
- Does the scaffold leak the answer?

## Verify and review

See `packages/verifier/README.md`.

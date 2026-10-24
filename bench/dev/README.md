# Dev plans (tuning only)

Hand-written plans for tuning the analysis (A, issue 3), in the shape `publish_plan` takes (`{goal, produces: [{key,text}], requires: [{key,text}], notes}` per provider, like `packages/cli/src/commands/fixtures/plans.json`). Never used in scored trials.

| File                 | Set                            | Expected findings                                                                                                                                                           |
| -------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plans-s2-dev.json`  | `s2-bearer-vs-cookie`          | One **conflict** on `auth.session` citing Claude's produces and Codex's requires (bearer vs cookie). `auth.server` and `events.registration` agree: compatible, no proposal |
|                      | `s2-helper-name-mismatch`      | One **conflict** on `auth.server`: Claude exports `getCurrentUser(req)` returning null, Droid expects `requireUser` middleware that sends 401                               |
|                      | `s2-status-code-mismatch`      | One **conflict** on `events.registration`: Codex expects 200 `{alreadyRegistered}`, Droid returns 409 (the charter says 409)                                                |
| `plans-neg-dev.json` | `s-all-cookie`, `s-all-bearer` | **Zero proposals.** Everything is consistent; at most `compatible` (aligned contracts)                                                                                      |
|                      | `n-unrelated`                  | **Zero proposals.** `docs.links` is produced by Claude and required by Droid and compatible by design. Codex has no shared keys                                             |

A false alert is any proposal on the negative set.

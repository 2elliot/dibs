---
name: sync
description: Bring the current branch up to date with origin/main and make sure everything still typechecks. Use before starting work, before opening a PR, and whenever a teammate says they merged something.
---

1. Run `git status`. If there are uncommitted changes, ask whether to commit them as a WIP commit first. Don't stash silently.
2. `git fetch origin`, then `git merge origin/main`. Don't rebase; teammates may have pulled this branch.
3. Resolve conflicts by lane, using the lane from the branch prefix (`plugin/`, `core/`, `demo/`; see CLAUDE.md):
   - Files in this lane: resolve them properly.
   - Files in another lane: take main's version with `git checkout --theirs -- <path>`. If that breaks this lane's code, fix this lane's code.
   - `package-lock.json`: `git checkout --theirs -- package-lock.json`, then `npm install`.
   - Contract zone (`packages/shared/`, the tables and reducer signatures in `spacetime/src/index.ts`, root config, `CLAUDE.md`, `docs/plan.md`, `docs/workflow.md`, `.claude/`, `.github/`): stop and tell the user who changed it and what conflicts. Don't pick a side.
4. If `package-lock.json` changed in the merge, run `npm install`.
5. Run `npm run typecheck`. If it fails in this lane, fix it. If it fails in another lane, report it and don't fix it.
6. Summarize what came in: `git log --oneline ORIG_HEAD..HEAD`, plus anything new in `docs/status/` or `docs/decisions/` that affects this lane.

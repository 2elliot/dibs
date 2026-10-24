---
name: handoff
description: Wrap up a chunk of work so teammates and their agents can see it. Updates this lane's status file, records decisions, syncs with main, pushes, and drafts the PR. Use when something works, before a break, or at a checkpoint.
---

1. Work out the lane from the branch prefix (`plugin/`, `core/`, `demo/`). If the branch doesn't name a lane, ask.
2. Update `docs/status/<lane>.md`, and only that status file:
   - Set the date, and move finished items from **Next** to **Now** or check them off.
   - **Needs from other lanes**: anything this lane is blocked on or stubbing, with the exact function or type.
   - **Notes for teammates**: anything they'd trip over, such as a new env var, a changed behavior or a manual step.
   - Keep it under about 40 lines. It's read at the start of every teammate's session.
3. If this work made a decision another lane needs to know about (a contract change, a new dependency, a naming choice, something cut), add `docs/decisions/YYYY-MM-DD-short-title.md` using the format in `docs/decisions/README.md`.
4. Check the diff stays in this lane: `git diff --stat origin/main...HEAD`. Point out any file outside the lane or in the contract zone, since that PR needs a teammate's 👍.
5. Run the `/sync` steps: merge `origin/main`, resolve conflicts, `npm run typecheck`. Then run `npm run format`.
6. Commit with a message that says what now works, and push the branch.
7. Open the PR with `gh pr create` if `gh` is installed. Otherwise give the user the compare URL (`https://github.com/2elliot/dibs/compare/<branch>?expand=1`) and a title and body to paste. Fill in the PR template.
8. Tell the user to post in the team chat once it's merged, so the others can `/sync`.

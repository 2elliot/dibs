# How we work without colliding

Three people, each with their own agent or two, all in one repo for 36 hours. The rules below keep us from doing to each other what dibs exists to prevent.

## The short version

1. **One lane each.** You and your agent only edit files your lane owns.
2. **Small branches, merged often.** Branch off `main` as `<lane>/<topic>`, and merge back every few hours or as soon as something works.
3. **The contract is shared.** `packages/shared` is the agreement between lanes. Change it on purpose, in a small PR, after telling the team.
4. **Status files instead of status meetings.** Keep `docs/status/<your lane>.md` current. Every Claude session reads all three at startup.
5. **Ask, don't build.** If you need something from another lane, write it under "Needs from other lanes" and code against the types, not your own copy of it.

## Lanes

| Lane   | Owner | Owns                                                                       | First branch       |
| ------ | ----- | -------------------------------------------------------------------------- | ------------------ |
| plugin | _TBD_ | `plugin/`                                                                  | `plugin/mcp-tools` |
| core   | _TBD_ | `spacetime/`, `packages/core/`                                             | `core/schema`      |
| demo   | _TBD_ | `dashboard/`, `demo/`, `docs/pitch.md`, `docs/tracks.md`, `docs/research/` | `demo/target-app`  |

The demo lane also covers pitch and glue: validation interviews, integration testing across laptops, Devpost and slides.

Fill in the owners. Everything not listed is the **contract zone**: `packages/shared/` (including the generated `module_bindings/`), the tables and reducer signatures in `spacetime/src/index.ts` (written by core, but every lane depends on them), root config and `package-lock.json`, `CLAUDE.md`, `docs/plan.md`, this file, `.claude/` and `.github/`.

Two places everyone writes, without conflicts:

- `docs/status/<lane>.md`: only your own lane's file.
- `docs/decisions/`: always a new file, never an edit to someone else's.

## Branches

- `main` always installs, typechecks and builds. Never commit to it directly.
- Work on `<lane>/<topic>`, such as `plugin/pretooluse-block` or `core/overlap-judge`. The lane prefix is how your agent knows which lane it's in.
- Keep branches short-lived: merge to `main` every 2–3 hours, or as soon as something works end to end. Long-lived branches are where merge pain comes from.
- Don't push to anyone else's branch. Delete yours after it merges.
- Running two agents yourself? Give each its own worktree so they never share a working directory: `git worktree add ../dibs-hooks -b plugin/hooks`.

## The loop

1. **Start:** run `/sync` in Claude Code (or `git fetch && git merge origin/main` yourself) so you're building on what teammates merged.
2. **Work** in your lane. Commit small and often.
3. **Something works:** run `/handoff`. It updates your status file, merges `main` in, runs the typecheck, pushes, and drafts the PR.
4. **Merge the PR.** Lane-only PRs can be self-merged once CI is green. A PR that touches the contract zone needs a 👍 from one teammate. Use squash merges so `main` stays readable.
5. **Say it in the group chat** ("merged core/schema"), so the others `/sync`.

## Changing the contract

`packages/shared` and the schema are how three lanes build in parallel against each other. Treat a change like an API change.

- **Additive** (a new type, a new optional field, a new table): post it in chat, open a small PR that touches only the contract plus whatever keeps `npm run typecheck` green, and merge it quickly.
- **Breaking** (rename, removal, a changed meaning): agree in chat first, then the same small PR. The person changing it fixes every lane's typecheck in that PR. Behavior changes are the owners' job, in follow-ups.
- **Schema:** edit `spacetime/src/index.ts`, run `npm run generate`, and commit the regenerated `packages/shared/src/module_bindings/` in the same PR. Adding a reducer is cheap. Changing a table's columns usually means republishing with `--delete-data`, which wipes the shared database, so warn the team first.
- **Record it** in `docs/decisions/` if it changes how another lane works.

## Merge conflicts

`/sync` handles these, but by hand:

- **In your lane:** resolve them; it's your code.
- **Outside your lane:** take `main`'s version, `git checkout --theirs -- <path>` (during `git merge origin/main`, "theirs" is `main`). If that breaks your code, fix your code, not theirs.
- **`package-lock.json`:** never hand-merge. `git checkout --theirs -- package-lock.json && npm install`, then commit.
- **Contract zone:** stop and talk to whoever changed it.

Prettier and the `.gitattributes` line-ending rule exist so formatting and Windows/macOS line endings never show up as conflicts. Format on save, or run `npm run format` before pushing.

## Shared context

All of this is in the repo, so every teammate's Claude sees it:

- `CLAUDE.md`: what we're building, the lanes, the rules. Loaded into every session.
- `docs/plan.md`, `docs/tracks.md` and `docs/pitch.md`: scope, the hour-by-hour roadmap, the cut list, which sponsor tracks we're framing for, and what we tell judges.
- `docs/status/<lane>.md`: each lane's now / next / blockers / needs.
- `docs/decisions/`: anything one lane decided that another needs to know.
- `.claude/hooks/team-context.mjs`: runs at every session start. It fetches `origin/main` and shows Claude every lane's status file and the latest decisions, even before you pull. It also names your lane from your branch and warns if you're behind `main`.
- `.claude/skills/`: `/sync` and `/handoff`, so all three agents follow the same steps.
- `CLAUDE.local.md` (gitignored): personal notes for your own Claude, if you want any.

## Checkpoints

Hours from when hacking starts; the full roadmap is in `docs/plan.md`.

| When    | What's true                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **H2**  | 5–10 teams interviewed. Contract (tables, reducers, MCP tool signatures) reviewed by all three. SpacetimeDB go/no-go made and the shared database published. |
| **H10** | Two Claude Code sessions on one laptop, and the second gets an overlap alert. Dashboard shows live agents and intents.                                       |
| **H18** | **Kill checkpoint: the full loop across two laptops, even if ugly.** If not, cut to overlap alerts plus dashboard.                                           |
| **H26** | Contract → stub → test flow works. Dashboard shows overlaps and negotiations. "Without dibs" baseline recorded.                                              |
| **H30** | **Feature freeze.** Only bug fixes after this. Tag `main` as `demo-freeze`, rehearse, record the backup video.                                               |
| **H36** | Submitted, with time to spare.                                                                                                                               |

## New laptop setup

```bash
git clone https://github.com/2elliot/dibs.git
cd dibs
npm install
npm run build:plugin
```

Then:

1. Copy `.env.example` to `~/.dibs/.env` and fill it in. The shared database is already filled in (`dib` on Maincloud); add your name and an Anthropic API key.
2. Copy `dashboard/.env.example` to `dashboard/.env.local` if you're running the dashboard.
3. Try the plugin: `claude --plugin-dir ./plugin`.

Only whoever publishes the module (core) needs the `spacetime` CLI. The generated bindings are committed, so everyone else just needs `npm install`. To install it: `iwr https://windows.spacetimedb.com -useb | iex` on Windows, or `curl -sSf https://install.spacetimedb.com | sh` on macOS/Linux.

## Repo settings (once, on GitHub)

Settings → General → Pull Requests: allow squash merging, and turn on "Automatically delete head branches". Optionally protect `main` so CI must pass before merging.

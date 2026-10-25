# dibs project sessions

Connect Claude Code, Codex and Droid (Factory) to the same coordination room from ordinary project
directories. A Git repository, benchmark fixture, and shared code remote are not
required. Each agent edits its own files; dibs exchanges plans and agreements.

> [!WARNING]
> **The experiment server is reset on every push to `real_exp`.** Each deploy
> wipes all rooms and join codes. If your room stops working after a push, run
> `dibs leave --local --provider <claude|codex|droid>` in your project, then create or
> join a new room. Coordinate with whoever is pushing before a test session.
> Details: `infra/EXPERIENCE_CICD.md`.

## Install and join

Requires Node 22 or newer, plus your installed and signed-in coding agent.
Every verified deployment replaces the
[`real-exp-latest`](https://github.com/2elliot/dibs/releases/tag/real-exp-latest)
prerelease. On each laptop (needs read access to `2elliot/dibs` and a signed-in
`gh`):

```sh
gh release download real-exp-latest --repo 2elliot/dibs --pattern '*.tgz' --clobber
npm install --global ./dibs-experience-0.1.0.tgz
```

Rerun both commands to update after a new deployment. For a shared repository to
test in, with a branch per agent, see
[SmartOinker/dibs-playground](https://github.com/SmartOinker/dibs-playground).

In the first developer's project directory:

```sh
dibs create --provider claude --brief "Build an API and its frontend"
claude
```

Share the printed `dibs1_…` join code privately. In the second developer's project:

```sh
dibs join <join-code> --provider codex
codex
```

The printed **Dashboard** link opens the live coordination graph for your room
(`?view=story&lobby=<id>`). **Evidence view** opens the table-based contracts,
timeline, and verification panels for the same room (`?lobby=<id>`).

A third developer can join the same room with Droid:

```sh
dibs join <join-code> --provider droid
droid
```

Accept the coding agent's normal project, MCP, and hook trust prompts. Codex
reviews project trust and hook trust separately. Droid asks to approve the dibs
MCP tools. dibs does not approve these on your behalf. Droid's setup writes
`.factory/mcp.json` and `.factory/hooks.json`; if the project already keeps its
Droid hooks in `.factory/settings.json` (and has no `hooks.json`), dibs adds its
hooks there instead, so the existing ones keep loading. If an agent was already open, restart it so it loads the new config.
Tell each agent what part of the shared project it should build. SessionStart
context tells it to publish its assumptions and respond to proposals.

Each room has one Claude, one Codex and one Droid seat. By default they all use
`project.interface` for shared routes, data shapes, and integration assumptions.
For several explicit boundaries, create with repeated flags:

```sh
dibs create --provider claude --brief "Build the registration app" --interface auth.session="Session format" --interface events.registration="Registration API"
```

The deployed package already contains its verified server URL. A **development
artifact** or source build requires `--server <URL>` on create, or `DIBS_SERVER`.
The join code carries that server automatically; users never enter database
coordinates or tokens. The existing shared service will not support this flow
until the new schema and worker are deployed and onboarding is enabled.

## Inspect and detach

```sh
dibs status --provider claude
dibs doctor --provider claude
dibs leave --provider claude
# Creator only; closes the room for everyone and detaches this directory:
dibs close --provider claude
```

`doctor` checks the backend, the local MCP bridge process, and whether the native
SessionStart hook has been observed. It reports unobserved trust/discovery rather
than treating an installed file as proof that the native agent loaded it.

`leave --local` removes the attachment when the server is unreachable. An already
running bridge observes detachment and stops coordinating without terminating
your coding agent. Use the same join code in the same directory/provider to
resume with your saved identity. A seat cannot be transferred to a different
identity; losing local credentials requires a new room.

Setup preserves project files and existing MCP servers, hooks, permissions, and
TOML comments. It refuses malformed or conflicting settings before allocating a
remote seat. A write-ahead journal supports interrupted setup and removes only
unchanged dibs-owned entries on detach. If you edited a dibs-owned entry, detach
keeps it and reports what needs manual review.

## Limits

Rooms expire after 24 hours or when their creator closes them. There are at most
30 analysis leases per room; model retries can make additional model requests.
The operator also configures server-wide daily/active-room budgets. Status and
notices report unavailable analysis; unavailable coordination never constitutes
an agreed contract. The hooks deliver context at runtime checkpoints and can
block Stop briefly; they are not a filesystem lock preventing every shell edit.

Plans, messages, contracts, and participant metadata remain publicly readable in
this trusted demo database. A join code controls membership, not confidentiality.
Do not use private project material in the experiment. Capabilities, identity
tokens, and attachment backups stay outside the project under
`~/.dibs/projects/` (or `DIBS_HOME`).

## Development and validation

```sh
npm ci
npm run build -w @dibs/experience
npm run dibs -- create --provider claude --brief "API and frontend" --server <experiment-url>
npm run test -w @dibs/experience
npm run smoke:package -w @dibs/experience
```

Set `DIBS_TEST_URI` to an isolated local server to include the installed-tarball
create/join/MCP smoke. Tests use scripted MCP clients and deterministic model
findings where noted. They do not substitute for a native Claude/Codex/Droid trust and
cross-laptop rehearsal. Operator setup is in `infra/EXPERIENCE_CICD.md`.

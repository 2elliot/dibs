# Everyday project sessions (`real_exp`)

## Outcome

Install the packaged CLI, create a room from any directory, share a join code,
and join from another directory. Open Claude Code or Codex normally. Their
project MCP server and hooks publish assumptions, deliver proposals, and support
agreement through the hosted worker. No fixture, Git reset, trial runner, or
automatic commit/push is involved.

This branch is explicitly authorized to change the former issue-owned paths and
extend the frozen benchmark API. Existing benchmark commands and behavior remain
supported. Implementation starts only after the requested independent GPT-6.1
Sol max-effort review.

## Proposed implementation

Review completed by GPT-6.1 Sol at max effort before implementation. Accepted
changes: use backend-native onboarding (no privileged HTTP API), persist issued
tokens before reducers, bind provider seats permanently to identities, reject
legacy joins into project rooms, verify membership on reconnect, retain a 24-hour
TTL and 30-lease room cap, enforce operator-controlled aggregate budgets, and
verify additive upgrades with existing data. Remote rollout needs credential
bootstrap; it is not implied by a passing local test or a pushed workflow.

1. Add private room/settings tables and additive project reducers. The creating
   identity owns the room; a cryptographically random capability permits joining
   one Claude seat or one Codex seat. No database/admin token is shared. Existing
   `join_lobby` must reject project rooms. Reconnection verifies existing room
   membership without replaying a capability. Never write join secrets into the
   public request log or events.
2. Keep one explicit shared-interface list per room, collected from a brief and
   optional interface flags; provide a documented initial shared key. Ordinary
   rooms use a protocol version instead of an exact binary hash. They end when
   closed or after an explicit bounded lifetime rather than the benchmark's
   15-minute trial. Analysis limits stay enforced and visible.
3. Add create/join/status/leave/close commands. Resolve hosted database coordinates
   through runtime configuration, support an operator-specified server, and save
   resumable per-project identity/session state with restricted token files.
4. Add nondestructive project attachment. Merge only dibs-owned MCP/hook entries,
   preserve existing JSON/TOML configuration, back up touched settings, and remove
   only owned entries on detach. Do not write a Codex hook-trust approval. Startup
   context explains the brief, vocabulary, teammates, and tool workflow even when
   the bridge is still connecting.
5. Build an installable npm tarball with a standalone bundled CLI, bridge, hook,
   and templates. Installation and operation must work without the source repo.
6. Add CI for Windows/Linux checks, a fresh local SpacetimeDB integration, package
   install smoke, and dashboard tests. CD must use tested commit provenance,
   GitHub Azure OIDC, runner-side container builds, immutable image tags, safe
   additive SpacetimeDB publish, regenerated-binding checks, and health/config
   verification. Avoid ACR Tasks, which the subscription blocks.

## Deployment boundary

Use a separately configured experiment database/app; do not reset or silently
replace the shared development/demo service. Onboarding should be operator
enabled so publishing additive reducers does not unexpectedly open model usage.
There are currently no repository deployment secrets/variables/environments,
and this identity has push permission but not repository admin permission.
Implement the complete pipeline and exact bootstrap requirements; report actual
remote execution separately from configured workflows.

## Acceptance

- Two arbitrary directories join one room without Git or database CLI setup.
- Existing files, config, and native runtime trust remain intact.
- Capability, provider-seat, ownership, membership-resume, and lifecycle checks
  are exercised against a real local database.
- The built package works after relocating it outside the monorepo.
- Bridge tools and hooks carry a real proposal and agreed contract through the
  database; synthetic model evidence is labeled as such.
- Existing state/bridge/worker/dashboard checks remain green.
- Windows and Linux CI finish on the pushed commit. Remote rollout is claimed
  only after the configured pipeline actually deploys and verifies it.

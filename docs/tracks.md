# Tracks

One product, framed for each sponsor. Nothing here should make dibs worse; if a track starts bending the product, drop the track. The demo lane owns this file.

## Going for

### Spacetime (strongest fit)

They list AI agent coordination, live dashboards and instant sync between users and agents as what they want to see. That's dibs.

- SpacetimeDB is the realtime backend: tables plus transactional reducers in `spacetime/`, in TypeScript.
- Show off what it gives us: atomic first-claim ownership in a reducer, and the dashboard and every agent syncing the same live state.
- Go/no-go by **H2**: if the TypeScript module fights us, fall back to Supabase (see `docs/decisions/2026-10-23-spacetimedb-backend.md`) and drop this track.

### Anthropic

Their four criteria, and our answer to each:

- **A named community:** student hackathon teams building with coding agents. We're surrounded by them.
- **A real problem:** we've lived it. The validation interviews (`docs/research/interviews.md`) show we talked to people who have too.
- **It works:** a one-command plugin install and a clear README, so another team could use it on Monday.
- **Thoughtful use of Claude:** Claude judges overlaps and is the coding agent. Our "where it could go wrong" answer is the stress-test list: false positives, contract drift, blocked writes.

### Microsoft: Built for the Real World

Productivity counts as a domain, and nothing requires Microsoft tech. The before/after run in `demo/README.md` is the "measurable usefulness", and the plugin plus cross-agent adapters are the "path to production". This track needs real numbers: minutes, tokens, merge conflicts, median of three runs.

## Stretch: only after the H18 checkpoint

### Factory Droid SDK ($2,000)

Their rubric rewards a Droid running on a trigger we designed (another agent counts), limits on what it can touch, and visible work. Our slot: when an overlap is resolved, trigger a Droid to write the stub and acceptance tests from the agreed contract. Restrict it to `contracts/` and `tests/`, and show its diff on the dashboard.

## Check the criteria first

- **Creao, Best Team Empowerment:** the name fits, but the criteria are behind a link and may require building on their platform.
- **Atlassian Agentic Workforce:** the PDF cuts off the details. Could fit if it's about agents working as a team.
- **Convex:** another realtime backend, details "coming soon". We only switch from Spacetime if their criteria are much better.

## Skipping

Finance, voice, Cursor + Grok, and Meta's human-connection track. Each would bend the product.

## Before submitting

- [ ] Check the Live Site for a limit on how many tracks we can enter
- [ ] Check for required README or Devpost sections per track
- [ ] At judging, open with each sponsor's own criteria at their table

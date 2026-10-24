# Plan

## The gap we fill

Existing tools (Claude Code agent teams, MCP Agent Mail, fstack, Befall, the AgentRoom paper) coordinate agents at the file-lock level or fix things at merge time. Few notice that two people want the same feature, assign one builder, and let the other agent build against a contract. That's dibs. Befall's listing mentions shared contracts and collision alerts, so know how we differ before judging.

## What we're building

A Claude Code plugin each teammate installs, a SpacetimeDB backend, and a live dashboard. Tracks we're framing it for are in `docs/tracks.md`.

- **Backend (SpacetimeDB, `spacetime/`):** tables `agent`, `intent`, `contract`, `message`, plus reducers that change them in transactions. Every client syncs the same live state, so we write no websocket server.
- **Core (`packages/core`):** runs on each laptop inside the plugin. Embeds intents, finds the nearest live intents by brute-force cosine similarity, and asks Claude to judge them. External calls live here because reducers can't make them.
- **Plugin (`plugin/`):** an MCP server with `publish_intent`, `request_feature`, `propose_contract`, `mark_delivered` and `get_inbox`, plus the hooks that make dibs enforced instead of optional.
- **Dashboard (`dashboard/`):** subscribes to the same tables and shows live agents, intents, overlap alerts and negotiation threads.

### How the hooks enforce it

- **SessionStart:** register the agent and load the team's current intents.
- **PreToolUse:** exit code 2 blocks the tool call and shows stderr to Claude. Block the first file write until the agent has published an intent. After that, block edits to files another agent owns, saying who owns them and how to request what you need.
- **PostToolUse:** `additionalContext` injects inbox messages into Claude's context mid-task. This is the realtime channel.

## The core loop (MVP)

1. Agent A plans and publishes its intent.
2. Agent B publishes an intent. Core finds A's intent is similar, and a Claude call judges whether it's a duplicate, a partial overlap, or independent.
3. On overlap, whoever claimed first owns the feature (enforced in the `recordOverlap` reducer). B sends its requirements, and the two agree on a typed interface.
4. B gets a generated stub and keeps building. B's requirements become a test file A's implementation must pass.
5. A marks the feature delivered, B gets pinged, swaps out the stub, and the tests go green.

## How we stand out

- **Before/after split screen.** The same two prompts without dibs (a clean merge into a broken app), then with it. Real numbers, median of three runs. See `demo/README.md`.
- **Semantic matching, not file locks.** The demo's two prompts share no keywords but depend on the same model. File locks can't see that.
- **Requirements become tests.** The negotiation becomes verifiable, not just agents chatting.
- **Quiet by default.** Only interrupt an agent on a real overlap. AgentRoom found message overhead hurts agents, so cite it as a design choice.

## Roadmap (36 hours)

Hours count from when hacking starts. Line them up with the official schedule.

| Hours   | Work                                                                                                                                                                       | Done when                                                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| H0–H2   | Talk to 5–10 teams about agents stepping on each other (pivot now if almost nobody has). Lock the data model and MCP tool signatures. SpacetimeDB quickstart and go/no-go. | Contract agreed by all three; backend decided                                                                                         |
| H2–H10  | Core: tables, embeddings on publish, similarity. Plugin: `publish_intent`, `get_inbox`, PreToolUse block. Demo: live dashboard list, demo repo.                            | Two Claude Code sessions on one laptop, and the second gets an overlap alert                                                          |
| H10–H18 | Two laptops. PostToolUse inbox delivery, the overlap judge, `request_feature` with a saved contract. Sleep in shifts.                                                      | **Kill checkpoint H18:** the full loop across two laptops, even if ugly. If not, cut to overlap alerts plus dashboard and polish that |
| H18–H26 | Stub generation, requirements → test file, `mark_delivered`, tests going green. Dashboard shows the overlap and negotiation live. Record the "without" run.                | The contract handoff works end to end                                                                                                 |
| H26–H30 | Run the exact demo script at least five times, tune the overlap threshold, test on the demo laptops, record a backup video.                                                | Reliable demo                                                                                                                         |
| **H30** | **Feature freeze.** Only bug fixes after this.                                                                                                                             | `main` tagged `demo-freeze`                                                                                                           |
| H30–H36 | Slides (problem, live demo, before/after, vision), Devpost, pitch practice. Submit well before the deadline.                                                               | Submitted                                                                                                                             |

Stretch, only if the loop is solid: the Factory Droid stub-writer after H18, the Codex adapter after about H22.

Judges will ask "why not just talk to each other?" and "how is this different from Agent Teams?" Have answers ready.

## Cut list

Cursor support, auth, CRDTs, automatic merge resolution, anything beyond 2–3 agents. Codex only as the stretch above. TypeScript only.

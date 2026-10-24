# Plan

## The gap we fill

Existing tools (Claude Code agent teams, MCP Agent Mail, fstack, Befall, the AgentRoom paper) coordinate agents at the file-lock level or fix things at merge time. Few notice that two people want the same feature, assign one builder, and let the other agent build against a contract. That's dibs. Before committing to the idea, check Befall's listing: it mentions shared contracts and collision alerts.

## What we're building

A Claude Code plugin each teammate installs, plus a hosted backend and a web dashboard for the demo. It's neither an app nor a browser extension.

- **Backend (Supabase):** Postgres, realtime subscriptions and pgvector, so we skip writing a websocket server. Tables: `agents`, `intents`, `contracts`, `messages`.
- **Plugin:** an MCP server with `publish_intent`, `request_feature`, `propose_contract`, `mark_delivered`, `get_inbox`, and hooks that make dibs enforced instead of optional.
- **Dashboard:** a Next.js page subscribed to Supabase realtime, showing live agents, intents, overlap alerts and negotiation threads.

### How the hooks enforce it

- **SessionStart:** register the agent and load the team's current intents.
- **PreToolUse:** exit code 2 blocks the tool call and shows stderr to Claude. Block the first file write until the agent has published an intent. After that, block edits to files another agent owns, saying who owns them and how to request what you need.
- **PostToolUse:** `additionalContext` injects inbox messages into Claude's context mid-task. This is the realtime channel.

## The core loop (MVP)

1. Agent A plans and publishes its intent.
2. Agent B publishes an intent. pgvector flags it as similar, and a Claude call judges whether it's a duplicate, a partial overlap, or independent.
3. On overlap, whoever claimed first owns the feature. B sends its requirements, and the two agree on a typed interface.
4. B gets a generated stub and keeps building. B's requirements become a test file A's implementation must pass.
5. A marks the feature delivered, B gets pinged, swaps out the stub, and the tests go green.

## How we stand out

- **Before/after split screen.** Run the same two prompts without dibs (duplicate code, merge conflict), then with it. Show time or tokens saved. Pre-record the "without" run.
- **Semantic matching, not file locks.** Our main difference from Agent Mail and similar tools. The demo must catch two differently named features that are really the same thing.
- **Requirements become tests.** The negotiation becomes verifiable, not just agents chatting.
- **Quiet by default.** Only interrupt an agent on a real overlap. AgentRoom found message overhead hurts agents, so cite it as a design choice.

## Timeline

- **Day 1 morning:** schema and MCP tools.
- **Day 1 afternoon:** hooks and overlap detection.
- **Day 1 night:** the full loop working across two laptops, even if ugly. This is the milestone that matters.
- **Day 2 morning:** contract → stub → test flow, and the dashboard.
- **Freeze about 6 hours before judging.** Then rehearse the demo and record a backup video.

## Cut list

Cursor/Codex support, auth, CRDTs, automatic merge resolution, anything beyond 2–3 agents. Build the demo repo first, TypeScript only, and design it so the overlap is guaranteed (both features need a rate limiter).

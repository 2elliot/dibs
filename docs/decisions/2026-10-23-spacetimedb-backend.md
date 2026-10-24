# SpacetimeDB instead of Supabase

Lane: core · Date: 2026-10-23 · Replaces the Supabase part of `2026-10-23-backend-access.md`

We're going for the Spacetime track (`docs/tracks.md`), and live shared state between agents and a dashboard is exactly what SpacetimeDB is for, so it's the backend. The module is TypeScript, in `spacetime/`.

What changes:

- **Schema and writes live in one module.** Tables plus reducers. Reducers run one at a time in transactions, so `recordOverlap` decides "first to call dibs owns it" atomically.
- **No pgvector.** Core stores each intent's embedding as a float array and computes cosine similarity itself. With tens of intents that's instant.
- **External calls stay in core.** Reducers can't make network calls (procedures can, but they're beta), so embeddings and the Claude judge run in `packages/core` on each laptop and report back through a reducer.
- **Types come from codegen.** `npm run generate` writes the client bindings into `packages/shared/src/module_bindings/`, and every lane imports them from `@dibs/shared`. They're committed, so only whoever publishes needs the CLI.
- **Config:** `DIBS_SPACETIME_URI` and `DIBS_SPACETIME_DB` replace the Supabase URL and key. Still no auth; that's on the cut list.

**Fallback:** if SpacetimeDB fights us by the H2 go/no-go, go back to Supabase and drop the Spacetime track. The Supabase version of the setup is commit `f1f5180` (`git show f1f5180:supabase/migrations/20261024000000_init.sql`). Write a new decision saying so.

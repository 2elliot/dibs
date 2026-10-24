# core lane

Owns `packages/core/` and `supabase/`. Everything with real logic lives here: the database, overlap detection, contracts, stub and test generation. The plugin is a thin shell over this package.

- `src/index.ts` is the public API the plugin calls. The signatures use types from `@dibs/shared`, so changing them is a contract change (see `docs/workflow.md`).
- `src/config.ts` reads `~/.dibs/.env`. `src/db.ts` holds the Supabase client.
- Schema changes go in a new file in `supabase/migrations/`, plus the matching row types in `packages/shared`, in the same PR.
- The overlap judge calls Claude through `@anthropic-ai/sdk`. The model comes from `DIBS_JUDGE_MODEL` (default `claude-opus-5-5`).
- Errors thrown here surface to the agent as tool errors, so make the message say what to do next.

# core lane

Owns `spacetime/` and `packages/core/`. Everything with real logic lives here: the SpacetimeDB module, overlap detection, contracts, stub and test generation. The plugin is a thin shell over this package.

- `spacetime/src/index.ts` is the module: tables plus reducers. Reducers are deterministic transactions, so no network calls, no `Date.now()`, no randomness. Use `ctx.timestamp` and throw `SenderError` for expected failures.
- After changing the module, run `npm run generate` and commit `packages/shared/src/module_bindings/` in the same PR. That's a contract change (see `docs/workflow.md`).
- `packages/core/src/index.ts` is the public API the plugin calls. Embeddings and the Claude judge run here, then report back through reducers.
- `src/hooks.ts` holds the enforcement decisions (`startSession`, `checkEdit`, `pendingContext`). They take plain inputs and know nothing about Claude Code, so a Codex or Gemini CLI adapter can call them unchanged. Keep them that way.
- `src/config.ts` reads `~/.dibs/.env`; `src/db.ts` holds the SpacetimeDB connection.
- The overlap judge calls Claude through `@anthropic-ai/sdk`. The model comes from `DIBS_JUDGE_MODEL` (default `claude-opus-5-5`).
- Errors thrown here surface to the agent as tool errors, so make the message say what to do next.

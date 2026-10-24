# Lane: core

Owner: _TBD_ · Branch: `core/schema` · Updated: 2026-10-23

## Now

- Nothing started. Schema v0 is in `supabase/migrations/`, and the API is stubbed in `packages/core/src/index.ts`.

## Next

- [ ] Create the Supabase project and run the init migration. Send the team the URL and publishable key privately, never in git.
- [ ] `registerAgent`, `publishIntent` (store only), `getInbox`, `fileOwner`: enough for the plugin lane to wire hooks
- [ ] Pick the embedding model, set the `vector` dimension in a new migration, and record the choice in `docs/decisions/`
- [ ] Overlap check: embed → `match_intents` → Claude judge (duplicate / partial / independent)
- [ ] On overlap: message the second agent through `messages`
- [ ] Day 2: `requestFeature` / `proposeContract` generate a stub and an acceptance test from the requirements
- [ ] Day 2: `markDelivered` pings the consumer

## Open questions

- Embeddings: Anthropic doesn't offer an embeddings API. Options are Voyage AI (the provider Anthropic recommends) or Supabase's built-in `gte-small` in an edge function (free, no extra key).
- Similarity threshold for `match_intents` (default 0.75). Tune it on the demo's two prompts.

## Needs from other lanes

-

## Notes for teammates

-

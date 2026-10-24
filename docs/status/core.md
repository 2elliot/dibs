# Lane: core

Owner: _TBD_ · Branch: `core/schema` · Updated: 2026-10-23

## Now

- Nothing started. The SpacetimeDB module in `spacetime/src/index.ts` has the four tables and reducers for registering agents, publishing intents, recording overlaps, requesting features and marking messages read. The core API is stubbed in `packages/core/src/index.ts`.

## Next

- [ ] **By H2:** SpacetimeDB go/no-go. `spacetime login`, `npm run publish:maincloud`, share the database name in chat. If it fights us, fall back to Supabase (see `docs/decisions/2026-10-23-spacetimedb-backend.md`).
- [ ] **H2–H10:** `registerAgent`, `publishIntent` (embed, store, find nearest), `getInbox`, `fileOwner`, so the plugin lane can wire hooks
- [ ] Pick the embedding model and record it in `docs/decisions/`
- [ ] **H10–H18:** the Claude judge (duplicate / partial / independent) → `recordOverlap`; `requestFeature` saves the contract
- [ ] **H18–H26:** `proposeContract` and `markDelivered` reducers; stub generation; requirements → a test file
- [ ] Stretch after H18: the Factory Droid stub-and-test writer, restricted to `contracts/` and `tests/` (see `docs/tracks.md`)

## Open questions

- Embeddings: Anthropic doesn't offer an embeddings API. Voyage AI is the provider Anthropic recommends; anything with a free tier works.
- Similarity threshold (start around 0.75). Tune it on the demo's two prompts during H26–H30.

## Needs from other lanes

-

## Notes for teammates

-

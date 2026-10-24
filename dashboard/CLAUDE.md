# demo lane: dashboard

The live view judges watch: every agent, what it's building, and when two of them collide. Next.js App Router, client-side SpacetimeDB subscriptions, no server code.

- Subscribes to SpacetimeDB directly, configured by `dashboard/.env.local`. It never calls `@dibs/core`.
- Connection, row types and tables come from `@dibs/shared` (generated bindings); don't redefine them here.
- `app/live-board.tsx` is the realtime wiring. Build the real UI from it.
- Design for a projector: large type, high contrast, and the overlap moment obvious from across a room. This is also the Spacetime track's "live dashboard".
- `npm run dev:dashboard` from the repo root serves on port 3001, since a local SpacetimeDB takes 3000.

# demo lane: dashboard

The live view judges watch: every agent, what it's building, and when two of them collide. Next.js App Router, client-side Supabase realtime, no server code.

- Reads Supabase directly with the publishable key from `dashboard/.env.local`. It never calls `@dibs/core`.
- Row types come from `@dibs/shared`; don't redefine them here.
- `app/live-board.tsx` is the realtime wiring. Build the real UI from it.
- Design for a projector: large type, high contrast, and the overlap moment obvious from across a room.
- `npm run dev:dashboard` from the repo root.

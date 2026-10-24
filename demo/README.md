# Demo target

The small app the agents work on during the demo. It's owned by the demo lane and isn't part of the npm workspaces. For the demo, copy it into its own repo so the two laptops work on branches of that, not of dibs.

## The scenario

Two teammates each ask their agent for a feature. The features have different names but both need the same thing underneath, so the overlap is guaranteed:

- **Laptop A:** "Add rate limiting to the login endpoint so people can't brute-force passwords."
- **Laptop B:** "Throttle the export API per user. It's getting hammered."

Both need a rate limiter. Without dibs, two agents write two of them and the merge conflicts. With dibs, A calls dibs on the limiter, B's intent is flagged as overlapping even though it never says "rate limit", B sends its requirements (per-user keys, a configurable window), gets a stub, and keeps building the export throttle against it.

## To build

- A tiny TypeScript HTTP API with `/login` and `/export` routes, a few tests, and nothing else.
- Keep it small enough that each agent finishes its feature in a few minutes on stage.
- Record the "without dibs" run ahead of time.

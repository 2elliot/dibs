// Revision timing for a lobby (fix 6 from lobby 3): per agent, whether its last edit to a shared
// file came after the first contract it could see. See packages/verifier/src/timing.ts.
//   npx tsx bench/scripts/revision-timing.ts <lobbyId> --transcript codex=<rollout.jsonl> \
//     --clone codex=<clone path> [--transcript claude=<project .jsonl> ...] [--deliveries <json>]
import { main } from "../../packages/verifier/src/timing.ts";

await main(process.argv.slice(2));

// Compare lobbies by arm (mode) with intervals and tests (bench/METRICS.md).
//   npx tsx bench/scripts/compare.ts [<lobbyId>... | --all] [--label <lobbyId>=<arm>]... \
//     [--baseline none] [--treatment dibs] [--exclude <lobbyId>]... [--out <dir>]
import { compareMain } from "../../packages/verifier/src/metrics-cli.ts";

await compareMain(process.argv.slice(2));

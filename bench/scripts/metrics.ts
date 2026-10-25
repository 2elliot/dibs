// Per-lobby metrics: time, coordination, work, cost and outcome (bench/METRICS.md).
//   npx tsx bench/scripts/metrics.ts <lobbyId> [--transcript <agent>=<path>]... \
//     [--interventions <n>] [--dump <db.json>] [--mode none|chat|dibs] [--local] [--json]
import { metricsMain } from "../../packages/verifier/src/metrics-cli.ts";

await metricsMain(process.argv.slice(2));

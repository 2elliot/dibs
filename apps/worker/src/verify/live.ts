// Live-DB verification harness for issue 3 (Phase B). Drives the REAL SpacetimeDibsDb + WorkerLoop
// against a local SpacetimeDB, using a deterministic FAKE model (no ANTHROPIC_API_KEY, no cost) so
// the four acceptance checks are repeatable. It acts as the `worker` participant via SPACETIME_TOKEN,
// which raw `spacetime call` cannot do (reducers authorize by ctx.sender role).
//
// Usage (env: SPACETIME_URI, SPACETIME_DB, SPACETIME_TOKEN):
//   tsx src/verify/live.ts analyze --relation conflict      # lease a queued job, submit -> proposal
//   tsx src/verify/live.ts analyze --relation compatible    # lease a queued job, submit -> aligned contract
//   tsx src/verify/live.ts crash-after-lease                # lease then exit without submitting (killed worker)
//   tsx src/verify/live.ts stale-input-key                  # lease, submit with a stale inputKey -> rejected
// Run `analyze` again after the lease expires (TIMING.leaseSec) to confirm the job is re-leased.
import { TIMING } from "@dibs/protocol";
import type {
  AnalysisInput,
  Finding,
  Findings,
  Relation,
} from "@dibs/protocol";
import { SpacetimeDibsDb } from "../worker/spacetime-db.ts";
import { WorkerLoop } from "../worker/loop.ts";
import { FakeModelClient } from "../model/fake.ts";
import { HealthState } from "../http/health.ts";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function parseFlags(argv: string[]): { mode: string; relation: Relation } {
  const [mode = "analyze", ...rest] = argv;
  let relation: Relation = "conflict";
  const i = rest.indexOf("--relation");
  if (i >= 0 && rest[i + 1]) relation = rest[i + 1] as Relation;
  return { mode, relation };
}

/** Deterministic findings built from the LIVE input, so cited ids are real and the module accepts them. */
function craftFindings(input: AnalysisInput, relation: Relation): Findings {
  const byKey = new Map<string, number[]>();
  const participantsByKey = new Map<string, Set<number>>();
  for (const it of input.items) {
    byKey.set(it.key, [...(byKey.get(it.key) ?? []), it.id]);
    participantsByKey.set(
      it.key,
      (participantsByKey.get(it.key) ?? new Set()).add(it.participantId),
    );
  }
  const findings: Finding[] = [];
  for (const [key, ids] of byKey) {
    if ((participantsByKey.get(key)?.size ?? 0) < 2) continue; // shared keys only
    findings.push({
      key,
      relation,
      citedItemIds: ids,
      explanation: `VERIFY harness: forced ${relation} for ${key}.`,
      contractText:
        relation === "unowned"
          ? ""
          : `VERIFY contract for ${key}: single agreed interface.`,
    });
  }
  if (findings.length === 0)
    throw new Error("no shared key found in the lobby's current plans");
  return { findings };
}

async function main(): Promise<void> {
  const { mode, relation } = parseFlags(process.argv.slice(2));
  const db = await SpacetimeDibsDb.connect({
    uri: env("SPACETIME_URI"),
    dbName: env("SPACETIME_DB"),
    token: env("SPACETIME_TOKEN"),
  });

  const job = await db.nextLeasableJob();
  if (!job) {
    console.error(
      "no leasable job (queued, or leased past expiry). Seed one with `dibs sim --worker none --stop-after plans`.",
    );
    process.exit(3);
  }
  console.error(
    `leasable job ${job.jobId} (lobby ${job.lobbyId}, kind ${job.kind}, inputKey ${job.inputKey})`,
  );
  const leaseToken = crypto.randomUUID();

  if (mode === "crash-after-lease") {
    const ok = await db.leaseJob(job.jobId, leaseToken);
    console.error(
      `leased=${ok} token=${leaseToken}. Exiting WITHOUT submitting (simulated crash).`,
    );
    console.error(
      `Wait ${TIMING.leaseSec}s, then run \`analyze\` to confirm the job is re-leased.`,
    );
    process.exit(ok ? 0 : 4);
  }

  if (mode === "stale-input-key") {
    const ok = await db.leaseJob(job.jobId, leaseToken);
    const input = await db.buildAnalysisInput(job.jobId);
    const findings = craftFindings(input, "conflict");
    console.error(
      `leased=${ok}. Submitting with a STALE inputKey; the module must reject it (rule 2).`,
    );
    await db.submitAnalysis(
      job.jobId,
      leaseToken,
      input.inputKey + ":stale",
      findings,
    );
    console.error(
      `Done. The job should still be 'leased' (not 'done'); wait ${TIMING.leaseSec}s then run \`analyze\` to re-lease.`,
    );
    process.exit(0);
  }

  if (mode === "analyze") {
    // Pre-read the live input so the fake returns findings with real cited ids, then run ONE real
    // WorkerLoop tick (lease -> analyze -> submit), exactly the production path.
    const input = await db.buildAnalysisInput(job.jobId);
    const findings = craftFindings(input, relation);
    const model = new FakeModelClient({ resolver: () => findings });
    const loop = new WorkerLoop({ db, model, health: new HealthState() });
    await loop.tick();
    console.error(
      `analyze (${relation}) submitted for job ${job.jobId}. Check the DB with the SQL in VERIFY.md.`,
    );
    process.exit(0);
  }

  console.error(
    `unknown mode "${mode}" (use: analyze | crash-after-lease | stale-input-key)`,
  );
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

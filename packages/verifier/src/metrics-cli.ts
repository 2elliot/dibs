// `metrics` and `compare` commands (bench/METRICS.md).
//   npx tsx bench/scripts/metrics.ts <lobbyId> [--transcript <agent>=<path>]... [--interventions <n>]
//       [--dump <db.json>] [--mode none|chat|dibs] [--local] [--json]
//   npx tsx bench/scripts/compare.ts [<lobbyId>... | --all] [--label <lobbyId>=<arm>]...
//       [--baseline <arm>] [--treatment <arm>] [--exclude <lobbyId>]... [--out <dir>]
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadManifest } from "./manifest.ts";
import { compare, toCsv, toMarkdown } from "./compare.ts";
import {
  computeMetrics,
  type LobbyDump,
  type LobbyMetrics,
} from "./metrics.ts";
import { benchDir, fixtureDir, resultsDir } from "./paths.ts";
import { createRecorder } from "./record.ts";

const readJson = <T>(path: string): T | undefined =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;

const camel = (s: string) =>
  s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Accepts the export's camelCase tables or a snake_case SQL dump (`plan_item`, `created_at_us`). */
export function normalizeDump(raw: Record<string, unknown>): LobbyDump {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const [table, rows] of Object.entries(raw)) {
    if (!Array.isArray(rows)) continue;
    out[camel(table)] = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row as Record<string, unknown>).map(([k, v]) => [
          camel(k),
          v,
        ]),
      ),
    );
  }
  return out as LobbyDump;
}

function pairs(
  values: string[] | undefined,
  flag: string,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const value of values ?? []) {
    const at = value.indexOf("=");
    if (at <= 0)
      throw new Error(`--${flag} expects <name>=<value>, got "${value}"`);
    const key = value.slice(0, at);
    (out[key] ??= []).push(value.slice(at + 1));
  }
  return out;
}

const show = (x: number | null | undefined, unit = "") =>
  x === null || x === undefined
    ? "–"
    : `${Number.isInteger(x) ? x : x.toFixed(1)}${unit}`;

export function printMetrics(m: LobbyMetrics) {
  const o = m.outcome;
  const lines = [
    `lobby ${m.lobbyId} (${m.mode ?? "mode ?"}, ${m.agents.length} agents: ${m.agents.join(", ") || "–"})`,
    `  outcome   ${o.passed ?? "–"}/${o.total ?? "–"} checks${o.fullPass ? " (full pass)" : ""} · merge ${o.mergeTreeClean === null ? "–" : o.mergeTreeClean ? "clean" : "conflicts"} · out-of-area ${show(o.outOfAreaFiles)} · review ${show(o.reviewConforms)} conform / ${show(o.reviewViolations)} violate`,
    `  time      all plans ${show(m.time.allPlansSec, "s")} · 1st contract ${show(m.time.firstContractSec, "s")} · all settled ${show(m.time.allSettledSec, "s")} · last edit ${show(m.time.lastEditSec, "s")} · last head ${show(m.time.lastHeadSec, "s")}`,
    `  coord     ${show(m.coordination.planRevisions)} plans · ${show(m.coordination.proposals)} proposals / ${show(m.coordination.proposalRounds)} rounds · ${show(m.coordination.rejects)} rejects · ${show(m.coordination.messages)} msgs · keys settled ${show(m.coordination.settledKeys)}/${show(m.coordination.sharedKeys)} · response p50 ${show(m.coordination.responseLatency.medianMs, "ms")}`,
    `  work      +${show(m.work.linesAdded)} −${show(m.work.linesRemoved)} lines in ${show(m.work.filesChanged)} files · shared edits ${show(m.work.sharedEditsBeforeContract)} before / ${show(m.work.sharedEditsAfterContract)} after contract`,
    `  cost      ${show(m.cost.totalTokens)} tokens (${show(m.cost.outputTokens)} out) · ${show(m.cost.toolCalls)} tool calls · ${show(m.cost.agentActiveSec, "s")} agent time · interventions ${show(m.interventions)}`,
  ];
  for (const a of m.perAgent)
    lines.push(
      `    ${a.name.padEnd(8)} plan@${show(a.firstPlanSec, "s")} rev ${a.planRevisions} · resp ${a.responses} (${a.rejects} rej) · +${show(a.linesAdded)}/−${show(a.linesRemoved)} · edits ${show(a.sharedEditsBeforeContract)}/${show(a.sharedEditsAfterContract)} ${a.timingVerdict ?? ""} · ${show(a.totalTokens)} tok · ${show(a.toolCalls)} calls`,
    );
  console.log(lines.join("\n"));
}

export async function metricsMain(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      transcript: { type: "string", multiple: true },
      interventions: { type: "string" },
      dump: { type: "string" },
      mode: { type: "string" },
      local: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const lobbyId = Number(positionals[0]);
  if (!Number.isInteger(lobbyId) || lobbyId <= 0) {
    console.error(
      "usage: metrics <lobbyId> [--transcript <agent>=<path>]... [--interventions <n>] [--dump <db.json>] [--mode <mode>] [--local] [--json]",
    );
    process.exitCode = 2;
    return;
  }
  const dir = resultsDir(lobbyId);
  mkdirSync(dir, { recursive: true });

  // The database rows: an explicit dump, else a fresh export as the verifier, else a saved one.
  const dbPath = join(dir, "db.json");
  let dump: LobbyDump | undefined;
  if (values.dump) {
    dump = normalizeDump(JSON.parse(readFileSync(values.dump, "utf8")));
    writeFileSync(dbPath, `${JSON.stringify(dump, null, 2)}\n`);
  } else {
    const recorder = await createRecorder(dir, { local: values.local });
    try {
      const rows = await recorder.dumpLobby(lobbyId);
      if (rows) {
        dump = normalizeDump(rows);
        writeFileSync(dbPath, `${JSON.stringify(dump, null, 2)}\n`);
      } else {
        const saved = readJson<Record<string, unknown>>(dbPath);
        dump = saved ? normalizeDump(saved) : undefined;
        if (!dump)
          console.error(
            `no database rows (${recorder.description}); pass --dump <db.json> for time and coordination metrics`,
          );
      }
    } catch (error) {
      const saved = readJson<Record<string, unknown>>(dbPath);
      dump = saved ? normalizeDump(saved) : undefined;
      console.error(
        `database export failed (${(error as Error).message})${dump ? "; using the saved db.json" : ""}`,
      );
    } finally {
      recorder.close();
    }
  }

  // Interventions and transcript paths persist, so a re-run without flags gives the same numbers.
  const inputsPath = join(dir, "metrics-inputs.json");
  const saved =
    readJson<{
      interventions?: number;
      transcripts?: Record<string, string[]>;
      mode?: string;
    }>(inputsPath) ?? {};
  const transcriptPaths = {
    ...saved.transcripts,
    ...pairs(values.transcript, "transcript"),
  };
  const interventions =
    values.interventions !== undefined
      ? Number(values.interventions)
      : saved.interventions;
  if (
    interventions !== undefined &&
    (!Number.isInteger(interventions) || interventions < 0)
  )
    throw new Error("--interventions expects a whole number");
  const mode = values.mode ?? saved.mode;
  writeFileSync(
    inputsPath,
    `${JSON.stringify({ interventions, transcripts: transcriptPaths, mode }, null, 2)}\n`,
  );

  const transcripts: Record<string, string> = {};
  for (const [agent, paths] of Object.entries(transcriptPaths))
    transcripts[agent] = paths.map((p) => readFileSync(p, "utf8")).join("\n");

  const diffPath = join(dir, "assembled.diff");
  const metrics = computeMetrics({
    lobbyId,
    dump,
    report: readJson(join(dir, "report.json")),
    timing: readJson(join(dir, "timing.json")),
    review: readJson(join(dir, "review.json")),
    diff: existsSync(diffPath) ? readFileSync(diffPath, "utf8") : undefined,
    manifest: loadManifest(fixtureDir),
    transcripts,
    interventions,
    mode,
  });
  const out = join(dir, "metrics.json");
  writeFileSync(out, `${JSON.stringify(metrics, null, 2)}\n`);
  if (values.json) console.log(JSON.stringify(metrics, null, 2));
  else {
    printMetrics(metrics);
    console.log(`metrics: ${out}`);
  }
}

export async function compareMain(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
      label: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      baseline: { type: "string" },
      treatment: { type: "string" },
      out: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const root = join(benchDir, "results");
  const exclude = new Set(values.exclude ?? []);
  const ids =
    values.all || positionals.length === 0
      ? existsSync(root)
        ? readdirSync(root).filter(
            (d) => /^\d+$/.test(d) && existsSync(join(root, d, "metrics.json")),
          )
        : []
      : positionals;
  const all = ids
    .filter((id) => !exclude.has(id))
    .map((id) => {
      const m = readJson<LobbyMetrics>(join(resultsDir(id), "metrics.json"));
      if (!m)
        throw new Error(
          `lobby ${id} has no metrics.json: run metrics ${id} first`,
        );
      return m;
    });
  if (!all.length) {
    console.error(
      "no lobbies with metrics.json; run `npx tsx bench/scripts/metrics.ts <lobbyId>` first",
    );
    process.exitCode = 2;
    return;
  }
  const labels = Object.fromEntries(
    Object.entries(pairs(values.label, "label")).map(([k, v]) => [
      k,
      v.at(-1)!,
    ]),
  );
  const report = compare(all, {
    labels,
    baseline: values.baseline,
    treatment: values.treatment,
  });
  const outDir = values.out ?? root;
  mkdirSync(outDir, { recursive: true });
  const md = toMarkdown(report);
  writeFileSync(
    join(outDir, "compare.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(join(outDir, "compare.md"), md);
  writeFileSync(join(outDir, "compare.csv"), toCsv(all, labels));
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else console.log(md);
  console.log(`written: ${join(outDir, "compare.{md,json,csv}")}`);
}

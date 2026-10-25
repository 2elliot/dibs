// Lobby evidence (bench/EVALUATION.md §4): assembles each lobby from its GitHub heads exactly as
// `dibs verify` does, then records what can be measured without the oracle key:
//   - assembled.diff, merge-tree, out-of-area files (as verify);
//   - a behaviour probe of the running app: the HTTP answers behind checks 1-5, and how the UI
//     carries the session (the thing check 6 depends on);
//   - with --mutants: the same probe on each oracle mutant (bench/oracle-mutants.json), confirming
//     each mutant breaks the behaviour it claims. That validates the mutants, not the oracle.
// The probe is evidence, never a score: scores come from the hidden oracle only.
//
//   npx tsx bench/scripts/lobby-evidence.ts 4 5 7 [--remote <repo>] [--mutants 7]
// Writes bench/results/<id>/{assembled.diff,evidence.json} and bench/results/mutant-probe.json.
import { spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  assemble,
  assembledDiff,
  commonBase,
  fetchHeads,
  mergeTreeClean,
  removeWorktree,
} from "../../packages/verifier/src/git.ts";
import { loadManifest } from "../../packages/verifier/src/manifest.ts";
import {
  applyMutant,
  type Mutant,
} from "../../packages/verifier/src/mutants.ts";
import { linkFixtureModules } from "../../packages/verifier/src/oracle-runner.ts";
import {
  benchDir,
  fixtureDir,
  PORT_RANGE,
  resultsDir,
  workDir,
} from "../../packages/verifier/src/paths.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    remote: {
      type: "string",
      default:
        process.env.DIBS_LOBBIES_REMOTE ??
        "https://github.com/2elliot/dibs.git",
    },
    mutants: { type: "string" },
  },
});
const manifest = loadManifest(fixtureDir);
const cache = join(workDir(), "lobbies.git");
// The fixture's seeded test accounts (src/data.js, frozen).
const ALICE = { email: "alice@example.com", password: "alice-pass" };
const BOB = { email: "bob@example.com", password: "bob-pass" };
let probes = 0;

export async function probe(tree: string) {
  // Rotate through issue 4's ports so a just-killed server never blocks the next one.
  const p = PORT_RANGE.min + (probes++ % (PORT_RANGE.max - PORT_RANGE.min + 1));
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: tree,
    env: { ...process.env, PORT: String(p) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    // Only talk to the server this probe started: wait for its own "Listening" line, and fail if it
    // exits first (a port still held by something else would otherwise answer instead).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`server in ${tree} did not start`)),
        10_000,
      );
      child.stdout!.on("data", (d) => {
        if (String(d).includes("Listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(`server in ${tree} exited (${code}) before listening`),
        );
      });
    });
    const u = `http://127.0.0.1:${p}`;
    const call = async (path: string, init: RequestInit = {}) => {
      const r = await fetch(u + path, init);
      let body: any = null;
      try {
        body = await r.json();
      } catch {}
      return { status: r.status, body, setCookie: r.headers.get("set-cookie") };
    };
    const login = (a: { email: string; password: string }) =>
      call("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(a),
      });
    const bearer = (t: unknown): Record<string, string> =>
      typeof t === "string" ? { Authorization: `Bearer ${t}` } : {};
    const la = await login(ALICE);
    const me = await call("/api/me", { headers: bearer(la.body?.token) });
    const bad = await login({ ...ALICE, password: "wrong" });
    const reg = () =>
      call("/api/events/evt-1/registrations", {
        method: "POST",
        headers: bearer(la.body?.token),
      });
    const r1 = await reg();
    const r2 = await reg();
    const lb = await login(BOB);
    const r3 = await call("/api/events/evt-1/registrations", {
      method: "POST",
      headers: bearer(lb.body?.token),
    });
    const un = await call("/api/events/evt-1/registrations", {
      method: "POST",
    });
    const ui = readFileSync(join(tree, "public/app.js"), "utf8");
    return {
      server: {
        loginStatus: la.status,
        loginReturnsToken: typeof la.body?.token === "string",
        loginSetsCookie: Boolean(la.setCookie),
        meStatus: me.status,
        badPasswordStatus: bad.status,
        registerStatus: r1.status,
        repeatStatus: r2.status,
        bobStatus: r3.status,
        bobDistinctId: Boolean(
          r1.body?.id && r3.body?.id && r1.body.id !== r3.body.id,
        ),
        unauthStatus: un.status,
      },
      ui: {
        sendsAuthorizationHeader:
          /Authorization['"]?\s*:\s*`Bearer/.test(ui) ||
          /['"]Authorization['"]\s*[,:]/.test(ui),
        readsTokenFromLogin: /\.token\b/.test(ui),
        credentials: [
          ...new Set(
            [...ui.matchAll(/credentials:\s*['"]([\w-]+)['"]/g)].map(
              (m) => m[1],
            ),
          ),
        ],
        successStatus: /status === 201\)/.test(ui)
          ? 201
          : /status === 200\)/.test(ui)
            ? 200
            : null,
      },
    };
  } finally {
    child.kill();
  }
}

for (const id of positionals) {
  const heads = fetchHeads(values.remote, id, cache);
  const base = commonBase(cache, heads);
  const tree = join(workDir(), `evidence-${id}`);
  const a = assemble({
    cacheGitDir: cache,
    baseSha: base,
    heads,
    manifest,
    tree,
  });
  const clean = mergeTreeClean(
    cache,
    heads,
    join(workDir(), `evidence-merge-${id}`),
  );
  const dir = resultsDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "assembled.diff"), assembledDiff(tree, base));
  linkFixtureModules(tree);
  const pr = await probe(tree);
  writeFileSync(
    join(dir, "evidence.json"),
    `${JSON.stringify({ lobbyId: Number(id), baseSha: base, heads, mergeTreeClean: clean, outOfArea: a.outOfArea, applied: a.applied, treeHash: a.treeHash, probe: pr }, null, 2)}\n`,
  );
  console.log(
    `lobby ${id}: base ${base.slice(0, 7)}, merge-tree ${clean ? "clean" : "conflicts"}, UI sends bearer: ${pr.ui.sendsAuthorizationHeader}`,
  );
  if (values.mutants !== id) removeWorktree(cache, tree);
}

if (values.mutants) {
  const control = join(workDir(), `evidence-${values.mutants}`);
  const { mutants } = JSON.parse(
    readFileSync(join(benchDir, "oracle-mutants.json"), "utf8"),
  ) as { mutants: Mutant[] };
  const rows: Record<string, unknown>[] = [
    { id: "control", probe: await probe(control) },
  ];
  for (const m of mutants) {
    const t = join(workDir(), `mutant-probe-${m.id}`);
    rmSync(t, { recursive: true, force: true });
    mkdirSync(t, { recursive: true });
    cpSync(control, t, {
      recursive: true,
      filter: (s) => !/[\\/](node_modules|\.git)$/.test(s),
    });
    applyMutant(t, m);
    linkFixtureModules(t);
    rows.push({ id: m.id, probe: await probe(t) });
    rmSync(t, { recursive: true, force: true });
  }
  removeWorktree(cache, control);
  // What changed relative to the unmutated control, field by field.
  const flat = (o: any) => ({
    ...o.probe.server,
    ...Object.fromEntries(
      Object.entries(o.probe.ui).map(([k, v]) => [
        `ui.${k}`,
        JSON.stringify(v),
      ]),
    ),
  });
  const base = flat(rows[0]);
  for (const r of rows.slice(1)) {
    const f = flat(r);
    r.changed = Object.keys(f).filter(
      (k) => JSON.stringify(f[k]) !== JSON.stringify(base[k]),
    );
    console.log(
      `  ${String(r.id).padEnd(30)} changed: ${(r.changed as string[]).join(", ")}`,
    );
  }
  writeFileSync(
    join(benchDir, "results", "mutant-probe.json"),
    `${JSON.stringify({ lobby: Number(values.mutants), createdAt: new Date().toISOString(), rows }, null, 2)}\n`,
  );
}

#!/usr/bin/env node
// Condense a recorded lobby for a short demo: keep every row and the order of everything, but
// shorten the quiet stretches between events so the whole run plays in about `seconds` at 1x.
//
//   node apps/dashboard/sim/condense.mjs <in.json> <out.json> [seconds=170] [label]
//
// Gaps between consecutive events longer than a cap are cut to the cap; the cap is chosen so the
// run lasts `seconds`. Every *Us timestamp in every table is mapped through the same monotonic
// function, so plans, votes, contracts and deliveries stay consistent with the events.
import fs from "node:fs";

const [input, output, secondsArg = "170", label] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node condense.mjs <in.json> <out.json> [seconds=170] [label]");
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(input, "utf8"));
const target = Number(secondsArg) * 1e6;

const points = [...new Set(data.tables.event.map((e) => Number(e.atUs)))].sort((a, b) => a - b);
const gaps = points.slice(1).map((t, i) => t - points[i]);
// The moments a viewer follows keep up to KEY_PAUSE before them, so they don't arrive in a blur.
const KEY = /^(plan_published|proposal_created|proposal_rejected|proposal_escalated|contract_agreed|contract_aligned)$/;
const KEY_PAUSE = 4e6;
const keyAt = new Set(data.tables.event.filter((e) => KEY.test(e.type)).map((e) => Number(e.atUs)));
const floor = gaps.map((g, i) => (keyAt.has(points[i + 1]) ? Math.min(g, KEY_PAUSE) : 0));
const condensed = (cap) => gaps.map((g, i) => Math.max(Math.min(g, cap), floor[i]));
const length = (cap) => condensed(cap).reduce((sum, g) => sum + g, 0);

// Largest cap whose condensed length fits the target.
let lo = 0, hi = Math.max(...gaps, 1);
if (length(hi) <= target) lo = hi;
else for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (length(mid) <= target) lo = mid; else hi = mid; }
const cap = Math.floor(lo); // whole microseconds: replay timestamps are integers

const kept = condensed(cap);
const mapped = [points[0]];
for (let i = 0; i < gaps.length; i++) mapped.push(mapped[i] + kept[i]);
const first = points[0], last = points.at(-1);
const map = (t) => {
  if (!t) return t; // 0 means "not set"
  if (t <= first) return t; // before the run starts (lobby creation): unchanged
  if (t >= last) return mapped.at(-1) + (t - last); // later deadlines keep their distance from the end
  let i = 0, j = points.length - 1; // binary search for the gap containing t
  while (j - i > 1) { const m = (i + j) >> 1; if (points[m] <= t) i = m; else j = m; }
  const span = points[j] - points[i];
  return Math.round(mapped[i] + (span ? ((t - points[i]) / span) * (mapped[j] - mapped[i]) : 0));
};

let changed = 0;
for (const rows of Object.values(data.tables))
  for (const row of rows)
    for (const [k, v] of Object.entries(row))
      if (/Us$/.test(k) && typeof v === "number") { row[k] = map(v); changed++; }
data.exportedAtUs = map(data.exportedAtUs);
if (label) data.label = label;
fs.writeFileSync(output, JSON.stringify(data, null, 2) + "\n");
console.log(
  `${((last - first) / 6e7).toFixed(1)} min -> ${((mapped.at(-1) - mapped[0]) / 6e7).toFixed(1)} min; ` +
    `gaps capped at ${(cap / 1e6).toFixed(1)} s; ${changed} timestamps mapped -> ${output}`,
);

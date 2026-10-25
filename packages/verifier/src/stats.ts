// Small, dependency-free statistics for comparing benchmark arms. Every function is
// deterministic (the bootstrap uses a seeded generator) so a re-run gives the same report.

export interface Summary {
  n: number;
  mean: number | null;
  sd: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
}

const finite = (values: (number | null | undefined)[]) =>
  values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );

/** Linear-interpolated quantile (the R-7 / numpy default). */
export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function summarize(values: (number | null | undefined)[]): Summary {
  const xs = finite(values);
  const sorted = [...xs].sort((a, b) => a - b);
  const n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : null;
  const sd =
    n > 1 && mean !== null
      ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
      : null;
  return {
    n,
    mean,
    sd,
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    min: n ? sorted[0]! : null,
    max: n ? sorted[n - 1]! : null,
  };
}

export interface Rate {
  k: number;
  n: number;
  rate: number | null;
  /** 95% Wilson score interval: honest at small n and at 0 or n successes. */
  low: number | null;
  high: number | null;
}

export function wilson(k: number, n: number, z = 1.96): Rate {
  if (n === 0) return { k, n, rate: null, low: null, high: null };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    k,
    n,
    rate: p,
    low: k === 0 ? 0 : Math.max(0, centre - half),
    high: k === n ? 1 : Math.min(1, centre + half),
  };
}

function logFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

/**
 * Two-sided Fisher exact test on a 2x2 table [[a, b], [c, d]] (rows: arms; columns:
 * success, failure). Sums the probabilities of every table with the same margins that is no
 * more likely than the observed one.
 */
export function fisherExact(
  a: number,
  b: number,
  c: number,
  d: number,
): number {
  const r1 = a + b;
  const r2 = c + d;
  const c1 = a + c;
  const n = r1 + r2;
  const lf = (x: number) => logFactorial(x);
  const base = lf(r1) + lf(r2) + lf(c1) + lf(n - c1) - lf(n);
  const p = (x: number) =>
    Math.exp(base - lf(x) - lf(r1 - x) - lf(c1 - x) - lf(r2 - c1 + x));
  const observed = p(a);
  let total = 0;
  for (let x = Math.max(0, c1 - r2); x <= Math.min(r1, c1); x++) {
    const px = p(x);
    if (px <= observed * (1 + 1e-7)) total += px;
  }
  return Math.min(1, total);
}

/** mulberry32: a tiny seeded PRNG so bootstrap intervals are reproducible. */
export function seeded(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Difference {
  /** mean(b) - mean(a) */
  delta: number | null;
  low: number | null;
  high: number | null;
  nA: number;
  nB: number;
}

/** Percentile-bootstrap 95% CI for the difference in means, mean(b) - mean(a). */
export function bootstrapMeanDiff(
  a: (number | null | undefined)[],
  b: (number | null | undefined)[],
  { iterations = 10_000, seed = 42 } = {},
): Difference {
  const xa = finite(a);
  const xb = finite(b);
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  if (!xa.length || !xb.length)
    return { delta: null, low: null, high: null, nA: xa.length, nB: xb.length };
  const delta = mean(xb) - mean(xa);
  // With one sample per arm there is nothing to resample: report the point estimate only.
  if (xa.length < 2 || xb.length < 2)
    return { delta, low: null, high: null, nA: xa.length, nB: xb.length };
  const rand = seeded(seed);
  const draw = (xs: number[]) => {
    let s = 0;
    for (let i = 0; i < xs.length; i++)
      s += xs[Math.floor(rand() * xs.length)]!;
    return s / xs.length;
  };
  const diffs = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) diffs[i] = draw(xb) - draw(xa);
  const sorted = Array.from(diffs).sort((x, y) => x - y);
  return {
    delta,
    low: quantile(sorted, 0.025),
    high: quantile(sorted, 0.975),
    nA: xa.length,
    nB: xb.length,
  };
}

/**
 * Trials per arm needed to detect a pass-rate change from p1 to p2 (two-sided alpha 0.05,
 * power 0.8, normal approximation). A planning aid for "how many lobbies do we need?".
 */
export function trialsNeeded(p1: number, p2: number): number {
  const za = 1.959964;
  const zb = 0.841621;
  const pbar = (p1 + p2) / 2;
  const num =
    za * Math.sqrt(2 * pbar * (1 - pbar)) +
    zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((num * num) / (p1 - p2) ** 2);
}

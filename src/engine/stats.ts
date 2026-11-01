/** Weighted quantile (q in 0..1) of values with non-negative weights. */
export function weightedQuantile(values: number[], weights: number[], q: number): number {
  if (values.length === 0) return NaN;
  const pairs = values
    .map((v, i) => ({ v, w: Math.max(0, weights[i] ?? 0) }))
    .filter((p) => p.w > 0)
    .sort((a, b) => a.v - b.v);
  if (pairs.length === 0) return NaN;
  const total = pairs.reduce((s, p) => s + p.w, 0);
  const target = q * total;
  let cum = 0;
  for (const p of pairs) {
    cum += p.w;
    if (cum >= target) return p.v;
  }
  return pairs[pairs.length - 1]!.v;
}

export function median(values: number[]): number {
  return weightedQuantile(values, values.map(() => 1), 0.5);
}

export function round(n: number, step: number): number {
  return Math.round(n / step) * step;
}

/** Deterministic PRNG (mulberry32) so demo data and tests are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function monthsBetween(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + (fromIso.length === 7 ? "-01" : ""));
  const b = new Date(toIso + (toIso.length === 7 ? "-01" : ""));
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) +
    (b.getUTCDate() - a.getUTCDate()) / 30;
}

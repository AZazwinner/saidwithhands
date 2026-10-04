/** Sequence resampling and dynamic time warping. Pure, no DOM. */
import { euclidean } from "./features";

/** Linearly resample a sequence of vectors to exactly `len` frames. */
export function resample(seq: readonly (readonly number[])[], len: number): number[][] {
  if (seq.length === 0) throw new Error("cannot resample an empty sequence");
  if (seq.length === 1) return Array.from({ length: len }, () => seq[0].slice());
  const out: number[][] = [];
  for (let i = 0; i < len; i++) {
    const pos = (i * (seq.length - 1)) / (len - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, seq.length - 1);
    const f = pos - lo;
    out.push(seq[lo].map((v, d) => v * (1 - f) + seq[hi][d] * f));
  }
  return out;
}

/**
 * DTW distance with a Sakoe-Chiba band, normalized by (n + m) so it reads as an average per-step
 * cost (identical sequences = 0). `window` is the max index offset; defaults to 25% of the longer one.
 */
export function dtw(
  a: readonly (readonly number[])[],
  b: readonly (readonly number[])[],
  window = Math.ceil(0.25 * Math.max(a.length, b.length)),
): number {
  const n = a.length;
  const m = b.length;
  const w = Math.max(window, Math.abs(n - m));
  let prev = new Float64Array(m + 1).fill(Infinity);
  let cur = new Float64Array(m + 1).fill(Infinity);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity);
    const jLo = Math.max(1, i - w);
    const jHi = Math.min(m, i + w);
    for (let j = jLo; j <= jHi; j++) {
      const cost = euclidean(a[i - 1], b[j - 1]);
      cur[j] = cost + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return (2 * prev[m]) / (n + m);
}

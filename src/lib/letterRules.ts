/**
 * Geometry rules for letters the landmark MLP confuses, and a within-group re-ranker.
 *
 * Rules ported from signscribe's `rules.py` (https://github.com/fokeesy/signscribe, MIT): each letter
 * is described the way a signing guide describes it ("index straight, others closed, thumb tucked
 * between index and middle") as fuzzy memberships over `handGeometry` features. Pure, no DOM.
 */
import type { GeoFeatures } from "./handGeometry";

type Rule = { crit: number[]; soft: [number, number][] };
const FLOOR = 0.04;

const up = (x: number, a: number, b: number) =>
  b === a ? (x >= b ? 1 : 0) : Math.min(1, Math.max(0, (x - a) / (b - a)));
const dn = (x: number, a: number, b: number) => 1 - up(x, a, b);
const band = (x: number, a: number, b: number, c: number, d: number) => Math.min(up(x, a, b), dn(x, c, d));
const straight = (e: number) => up(e, 0.6, 0.85);
const closed = (e: number) => dn(e, 0.12, 0.38);
const spreadMax = (f: GeoFeatures) => Math.max(f.spread_im, f.spread_mr, f.spread_rp);
const fist4 = (f: GeoFeatures) => [closed(f.ext_i), closed(f.ext_m), closed(f.ext_r), closed(f.ext_p)];
const gLike = (f: GeoFeatures) => [straight(f.ext_i), closed(f.ext_m), closed(f.ext_r), closed(f.ext_p)];
const twoUp = (f: GeoFeatures) => [straight(f.ext_i), straight(f.ext_m), closed(f.ext_r), closed(f.ext_p)];
const pinkyOnly = (f: GeoFeatures) => [straight(f.ext_p), closed(f.ext_i), closed(f.ext_m), closed(f.ext_r)];
const meanExt = (f: GeoFeatures) => (f.ext_i + f.ext_m + f.ext_r + f.ext_p) / 4;

const RULES: Record<string, (f: GeoFeatures) => Rule> = {
  A: (f) => ({
    crit: fist4(f),
    soft: [
      [dn(f.t_along, -0.02, 0.2), 3],
      [up(f.t_height, 0.85, 1.05), 1.5],
    ],
  }),
  S: (f) => ({
    crit: fist4(f),
    soft: [
      [band(f.t_along, 0.15, 0.3, 0.6, 0.75), 2],
      [up(f.t_pc, 0.4, 0.55), 2],
      [up(f.t_pip_i, 0.22, 0.32), 1],
    ],
  }),
  T: (f) => ({
    crit: fist4(f),
    soft: [
      [band(f.t_along, -0.02, 0.08, 0.28, 0.4), 2.5],
      [dn(f.t_pip_i, 0.24, 0.5), 2],
      [up(f.t_pc, 0.4, 0.55), 1],
    ],
  }),
  N: (f) => ({
    crit: fist4(f),
    soft: [
      [band(f.t_along, 0.32, 0.42, 0.56, 0.66), 2.5],
      [dn(f.t_pc, 0.38, 0.55), 2],
    ],
  }),
  M: (f) => ({
    crit: fist4(f),
    soft: [
      [up(f.t_along, 0.62, 0.78), 2.5],
      [dn(f.t_pc, 0.42, 0.6), 1.5],
    ],
  }),
  E: (f) => ({
    crit: [band(meanExt(f), 0.04, 0.1, 0.5, 0.68)],
    soft: [
      [dn(Math.max(f.d_ti, f.d_tm, f.d_tr, f.d_tp), 0.4, 0.75), 2],
      [dn(f.t_height, 0.7, 0.9), 1.5],
      [up(f.t_along, 0.45, 0.65), 1],
      [dn(f.t_pc, 0.4, 0.7), 1],
    ],
  }),
  B: (f) => ({
    crit: [straight(f.ext_i), straight(f.ext_m), straight(f.ext_r), straight(f.ext_p)],
    soft: [
      [dn(spreadMax(f), 10, 26), 2],
      [dn(f.t_pc, 0.55, 0.95), 2],
    ],
  }),
  C: (f) => ({
    crit: [f.ext_i, f.ext_m, f.ext_r, f.ext_p].map((e) => band(e, 0.25, 0.38, 0.75, 0.88)),
    soft: [
      [band(f.d_ti, 0.3, 0.5, 1.3, 1.7), 2],
      [dn(spreadMax(f), 15, 35), 1],
      [up(f.side, 0.15, 0.55), 1],
    ],
  }),
  D: (f) => ({
    crit: [straight(f.ext_i), dn(f.ext_m, 0.45, 0.75), dn(f.ext_r, 0.5, 0.8), dn(f.ext_p, 0.5, 0.8)],
    soft: [
      [dn(f.d_tm, 0.25, 0.6), 3],
      [dn(f.d_tr, 0.4, 0.9), 1],
    ],
  }),
  F: (f) => ({
    crit: [straight(f.ext_m), straight(f.ext_r), straight(f.ext_p), band(f.ext_i, 0.15, 0.3, 0.75, 0.9)],
    soft: [[dn(f.d_ti, 0.2, 0.5), 3]],
  }),
  G: (f) => ({
    crit: gLike(f),
    soft: [
      [dn(f.ang_ti, 30, 60), 2.5],
      [up(f.th_reach, 0.7, 0.9), 2],
      [up(f.side, 0.3, 0.7), 2],
      [dn(f.t_pc, 1.3, 1.8), 0.5],
    ],
  }),
  Q: (f) => ({
    crit: gLike(f),
    soft: [
      [dn(f.ang_ti, 30, 60), 2.5],
      [up(f.th_reach, 0.7, 0.9), 2],
      [up(-f.up, 0.3, 0.7), 2.5],
    ],
  }),
  H: (f) => ({
    crit: twoUp(f),
    soft: [
      [dn(f.spread_im, 10, 22), 2],
      [up(f.side, 0.35, 0.7), 3],
      [dn(f.cross_im, -0.12, 0.02), 1],
      [up(f.t_pip_m, 0.4, 0.75), 1],
    ],
  }),
  U: (f) => ({
    crit: twoUp(f),
    soft: [
      [dn(f.spread_im, 10, 22), 2],
      [up(f.up, 0, 0.5), 3],
      [dn(f.cross_im, -0.12, 0.02), 1.5],
      [dn(f.t_pc, 0.85, 1.25), 1],
      [up(f.t_pip_m, 0.4, 0.75), 1.5],
    ],
  }),
  V: (f) => ({
    crit: twoUp(f),
    soft: [
      [up(f.spread_im, 10, 22), 3],
      [up(f.t_pip_m, 0.5, 0.8), 1.5],
      [dn(f.cross_im, -0.1, 0.05), 1],
    ],
  }),
  K: (f) => ({
    crit: twoUp(f),
    soft: [
      [up(f.spread_im, 6, 16), 2],
      [dn(f.t_pip_m, 0.45, 0.85), 3],
      [up(f.up, -0.1, 0.4), 1.5],
    ],
  }),
  P: (f) => ({
    crit: twoUp(f),
    soft: [
      [up(f.spread_im, 6, 16), 2],
      [dn(f.t_pip_m, 0.45, 0.85), 3],
      [up(-f.up, 0.2, 0.6), 2.5],
    ],
  }),
  R: (f) => ({
    crit: twoUp(f),
    soft: [
      [up(f.cross_im, -0.1, 0.03), 3.5],
      [dn(f.spread_im, 10, 24), 1],
      [up(f.up, 0, 0.5), 1.5],
      [up(f.t_pip_m, 0.4, 0.75), 1],
    ],
  }),
  W: (f) => ({
    crit: [straight(f.ext_i), straight(f.ext_m), straight(f.ext_r), closed(f.ext_p)],
    soft: [[up(Math.min(f.spread_im, f.spread_mr), 4, 13), 2.5]],
  }),
  X: (f) => ({
    crit: [band(f.ext_i, 0.2, 0.3, 0.65, 0.78), closed(f.ext_m), closed(f.ext_r), closed(f.ext_p)],
    soft: [
      [up(f.pip_i, 40, 65), 3],
      [dn(f.mcp_i, 45, 75), 1.5],
    ],
  }),
  I: (f) => ({ crit: pinkyOnly(f), soft: [[dn(f.t_pc, 0.85, 1.2), 3]] }),
  Y: (f) => ({
    crit: pinkyOnly(f),
    soft: [
      [up(f.t_pc, 0.9, 1.25), 3],
      [up(f.th_reach, 0.7, 0.9), 1.5],
    ],
  }),
  L: (f) => ({
    crit: gLike(f),
    soft: [
      [up(f.t_pc, 0.9, 1.25), 2.5],
      [band(f.ang_ti, 45, 65, 115, 140), 2.5],
      [up(f.th_reach, 0.7, 0.9), 1],
    ],
  }),
  O: (f) => ({
    crit: [dn(f.d_ti, 0.25, 0.5), dn(f.d_tm, 0.3, 0.6)],
    soft: [
      [band(meanExt(f), 0.08, 0.18, 0.62, 0.8), 2],
      [dn(f.d_tr, 0.5, 1), 1],
      [dn(f.d_tp, 0.7, 1.2), 1],
    ],
  }),
};

function scoreRule({ crit, soft }: Rule): number {
  const gate = crit.length ? Math.min(...crit) : 1;
  let geo = 1;
  if (soft.length) {
    const wsum = soft.reduce((a, [, w]) => a + w, 0);
    geo = Math.exp(soft.reduce((a, [m, w]) => a + w * Math.log(Math.max(m, FLOOR)), 0) / wsum);
  }
  return Math.pow(gate, 0.7) * geo;
}

/** Rule score in 0..1 for one letter (0 if no rule). */
export function ruleScore(letter: string, f: GeoFeatures): number {
  const r = RULES[letter];
  return r ? scoreRule(r(f)) : 0;
}

/** Letter groups the landmark MLP confuses; rules re-rank probability mass within each group. */
export const CONFUSION_GROUPS: readonly (readonly string[])[] = [
  ["G", "H", "Q", "P"],
  // The fist group (A, E, M, N, S, T) is NOT re-ranked: its rules depend on where MediaPipe *guesses*
  // the hidden thumb tip is. On real M/N recordings that guess was reversed and the rules turned 98%
  // correct N into 0%. Those letters rely on the model, calibration and context.
];

/**
 * Re-rank probabilities within confusion groups using geometry rules.
 * The group's total mass is preserved; inside it, p_k is reweighted to p_k^(1-s) * r_k^s.
 * A group is skipped if it doesn't hold the top letter, or if no rule in it fits (max score < minFit).
 */
export function refineWithRules(
  labels: readonly string[],
  probs: readonly number[],
  geo: GeoFeatures,
  { strength = 0.7, minFit = 0.08, groups = CONFUSION_GROUPS } = {},
): number[] {
  const out = probs.slice();
  let top = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[top]) top = i;
  for (const group of groups) {
    if (!group.includes(labels[top])) continue;
    const idx = group.map((g) => labels.indexOf(g)).filter((i) => i >= 0);
    const mass = idx.reduce((a, i) => a + probs[i], 0);
    const scores = idx.map((i) => ruleScore(labels[i], geo));
    if (Math.max(...scores) < minFit) continue;
    const w = idx.map(
      (i, k) => Math.pow(Math.max(probs[i], 1e-6), 1 - strength) * Math.pow(scores[k] + 0.01, strength),
    );
    const sum = w.reduce((a, b) => a + b, 0);
    idx.forEach((i, k) => (out[i] = (mass * w[k]) / sum));
  }
  return out;
}

/**
 * Expected state of the index, middle, ring and pinky fingers for each letter:
 * S = straight, C = curled, . = either (bent / varies between signers).
 */
export const FINGER_STATES: Record<string, string> = {
  A: "CCCC", B: "SSSS", C: "....", D: "S...", E: "CCCC", F: ".SSS", G: "SCCC", H: "SSCC",
  I: "CCCS", K: "SSCC", L: "SCCC", M: "CCCC", N: "CCCC", O: "....", P: "SSCC", Q: "SCCC",
  R: "SSCC", S: "CCCC", T: "CCCC", U: "SSCC", V: "SSCC", W: "SSSC", X: ".CCC", Y: "CCCS",
}; // prettier-ignore

/** A finger clearly contradicts its expected state (loose thresholds: only blatant mismatches count). */
const CONTRADICTS = { S: (ext: number) => ext < 0.4, C: (ext: number) => ext > 0.8 } as const;

/** Number of fingers whose measured extension blatantly contradicts the letter's expected shape. */
export function fingerContradictions(letter: string, f: GeoFeatures): number {
  const want = FINGER_STATES[letter];
  if (!want) return 0;
  const ext = [f.ext_i, f.ext_m, f.ext_r, f.ext_p];
  let n = 0;
  for (let k = 0; k < 4; k++) {
    const w = want[k] as "S" | "C" | ".";
    if (w !== "." && CONTRADICTS[w](ext[k])) n++;
  }
  return n;
}

/**
 * "I don't know" support: scale each letter's probability down by `penalty` per finger that blatantly
 * contradicts the letter (e.g. "G" while the index finger is curled), WITHOUT renormalizing; the removed
 * mass is "unknown". Only finger states are used: they are robust across signers, unlike orientation or
 * exact thumb placement, which wrongly vetoed real G signs in testing.
 */
export function applyPlausibility(
  labels: readonly string[],
  probs: readonly number[],
  geo: GeoFeatures,
  { penalty = 0.4 } = {},
): number[] {
  return probs.map((p, i) => p * Math.pow(penalty, fingerContradictions(labels[i], geo)));
}

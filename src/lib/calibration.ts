/**
 * Personal letter calibration: the signer records a few seconds of letters the model gets wrong for
 * them, and a k-nearest-neighbor model over invariant geometry vectors (handGeometry.ts) is blended
 * into the letter probabilities, but only when the current hand is close to a recorded sample.
 * Pure, no DOM.
 */
import { euclidean } from "./features";

export type CalibrationSet = { version: 1; samples: Record<string, number[][]> };

export const EMPTY_CALIBRATION: CalibrationSet = { version: 1, samples: {} };
export const MIN_SAMPLES = 5;
const SINGLE_LETTER_SCALE = 0.3;

export function addSamples(set: CalibrationSet, letter: string, vecs: number[][]): CalibrationSet {
  return { ...set, samples: { ...set.samples, [letter]: [...(set.samples[letter] ?? []), ...vecs] } };
}

export function clearLetter(set: CalibrationSet, letter: string): CalibrationSet {
  const samples = { ...set.samples };
  delete samples[letter];
  return { ...set, samples };
}

/** Letters with enough samples to be used. */
export function calibratedLetters(set: CalibrationSet): string[] {
  return Object.keys(set.samples).filter((l) => set.samples[l].length >= MIN_SAMPLES);
}

export function isCalibrationSet(x: unknown): x is CalibrationSet {
  if (!x || typeof x !== "object") return false;
  const s = (x as CalibrationSet).samples;
  return (
    (x as CalibrationSet).version === 1 &&
    !!s &&
    typeof s === "object" &&
    Object.values(s).every(
      (arr) => Array.isArray(arr) && arr.every((v) => Array.isArray(v) && v.every(Number.isFinite)),
    )
  );
}

export type Knn = {
  letters: string[];
  /** typical separation between calibrated letters (median nearest-other-centroid distance) */
  scale: number;
  classify: (vec: readonly number[]) => { probs: Record<string, number>; dmin: number };
};

/** Build a k-NN over calibrated letters. Returns null if fewer than 2 letters are calibrated. */
export function buildKnn(set: CalibrationSet, k = 7): Knn | null {
  const letters = calibratedLetters(set);
  if (letters.length === 0) return null;
  const pts = letters.flatMap((l) => set.samples[l].map((vec) => ({ l, vec })));

  // "Close enough" scale = typical separation between letters (median distance from each letter's
  // centroid to the nearest other letter's centroid). Not frame-to-frame jitter: consecutive frames of
  // one recording are nearly identical, which made the window so tight that a fresh attempt at the same
  // letter never counted as close (seen with real M/N recordings).
  const centroid = (vs: number[][]) => vs[0].map((_, i) => vs.reduce((a, v) => a + v[i], 0) / vs.length);
  const centroids = letters.map((l) => centroid(set.samples[l]));
  const seps = centroids.map((c, i) =>
    Math.min(...centroids.filter((_, j) => j !== i).map((o) => euclidean(c, o))),
  );
  seps.sort((x, y) => x - y);
  // With a single calibrated letter (e.g. after the first tap-to-fix) there is no separation to measure;
  // use a conservative scale so it only applies to hands very close to the recorded samples.
  const scale =
    letters.length === 1 ? SINGLE_LETTER_SCALE : Math.max(seps[Math.floor(seps.length / 2)], 0.15);

  return {
    letters,
    scale,
    classify(vec) {
      const ds = pts.map((p) => ({ l: p.l, d: euclidean(vec, p.vec) })).sort((a, b) => a.d - b.d);
      const near = ds.slice(0, Math.min(k, ds.length));
      const votes: Record<string, number> = {};
      for (const { l, d } of near) votes[l] = (votes[l] ?? 0) + 1 / (d + scale * 0.25);
      const sum = Object.values(votes).reduce((a, b) => a + b, 0);
      const probs: Record<string, number> = {};
      for (const l of letters) probs[l] = (votes[l] ?? 0) / sum;
      return { probs, dmin: ds[0].d };
    },
  };
}

/**
 * Blend k-NN probabilities into model probabilities: p = (1-λ)·model + λ·knn, where
 * λ = maxWeight when the hand is within `near`×scale of a recorded sample, fading to 0 at `far`×scale
 * (scale = typical separation between calibrated letters).
 */
export function refineWithCalibration(
  labels: readonly string[],
  probs: readonly number[],
  vec: readonly number[],
  knn: Knn,
  { maxWeight = 0.8, near = 0.5, far = 1.5 } = {},
): number[] {
  const { probs: kp, dmin } = knn.classify(vec);
  const r = dmin / knn.scale;
  const lambda = maxWeight * Math.max(0, Math.min(1, (far - r) / (far - near)));
  if (lambda === 0) return probs.slice();
  return probs.map((p, i) => (1 - lambda) * p + lambda * (kp[labels[i]] ?? 0));
}

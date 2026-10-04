/**
 * Recorded letter datasets (the brief's "Record letter" seed data): raw landmarks per frame, so any
 * pipeline stage can be re-evaluated offline (scripts/analyze-letters.ts) and team recordings can be
 * shipped as a built-in k-NN seed. Pure, no DOM.
 */
import type { Hand, Landmark } from "./features";
import { extractGeometry, geometryVector, rollFromImage } from "./handGeometry";
import { addSamples, EMPTY_CALIBRATION, type CalibrationSet } from "./calibration";

export type Lighting = "bright" | "normal" | "dim" | "backlit";

export type LetterSample = {
  label: string;
  hand: Hand;
  aspect: number;
  /** 21 image landmarks flattened [x0,y0,z0,...], rounded */
  lm: number[];
  /** 21 world landmarks flattened, rounded */
  world: number[];
};

export type LetterDataset = {
  version: 1;
  kind: "letters";
  signer: string;
  lighting: Lighting;
  recordedAt: string;
  /** "corrected" = hand labels recorded after the handedness fix; absent = legacy, swapped */
  handLabels?: "corrected";
  samples: LetterSample[];
};

/** Legacy datasets (before the handedness fix) stored swapped hand labels; return them corrected. */
export function withCorrectHands(d: LetterDataset): LetterDataset {
  if (d.handLabels === "corrected") return d;
  return {
    ...d,
    handLabels: "corrected",
    samples: d.samples.map((s) => ({ ...s, hand: s.hand === "Left" ? "Right" : "Left" })),
  };
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

export function toSample(
  label: string,
  hand: Hand,
  aspect: number,
  landmarks: readonly Landmark[],
  world: readonly Landmark[],
): LetterSample {
  return {
    label,
    hand,
    aspect: r4(aspect),
    lm: landmarks.flatMap((p) => [r4(p.x), r4(p.y), r4(p.z)]),
    world: world.flatMap((p) => [r5(p.x), r5(p.y), r5(p.z)]),
  };
}

export function unflatten(v: readonly number[]): Landmark[] {
  const out: Landmark[] = [];
  for (let i = 0; i < v.length; i += 3) out.push({ x: v[i], y: v[i + 1], z: v[i + 2] });
  return out;
}

export function sampleGeometryVector(s: LetterSample): number[] {
  const lm = unflatten(s.lm);
  return geometryVector(extractGeometry(unflatten(s.world), rollFromImage(lm, s.aspect)));
}

export function isLetterDataset(x: unknown): x is LetterDataset {
  if (!x || typeof x !== "object") return false;
  const d = x as LetterDataset;
  return (
    d.version === 1 &&
    d.kind === "letters" &&
    Array.isArray(d.samples) &&
    d.samples.every(
      (s) =>
        typeof s.label === "string" &&
        (s.hand === "Left" || s.hand === "Right") &&
        Array.isArray(s.lm) &&
        s.lm.length === 63 &&
        Array.isArray(s.world) &&
        s.world.length === 63,
    )
  );
}

/** Convert datasets into a calibration set (geometry vectors per letter) for the k-NN. */
export function datasetsToCalibration(datasets: readonly LetterDataset[]): CalibrationSet {
  let set = EMPTY_CALIBRATION;
  for (const d of datasets) {
    const byLetter = new Map<string, number[][]>();
    for (const s of d.samples) {
      const arr = byLetter.get(s.label) ?? [];
      arr.push(sampleGeometryVector(s));
      byLetter.set(s.label, arr);
    }
    for (const [l, vecs] of byLetter) set = addSamples(set, l, vecs);
  }
  return set;
}

/** Count of samples per letter. */
export function countByLabel(samples: readonly LetterSample[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of samples) out[s.label] = (out[s.label] ?? 0) + 1;
  return out;
}

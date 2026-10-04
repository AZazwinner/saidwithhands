import type { Landmark } from "../features";

export type SynthOpts = {
  /** wrist position in image coords */
  cx?: number;
  cy?: number;
  /** overall scale in image units */
  size?: number;
  /** +1: thumb toward +x (raw-camera right hand, palm facing camera); -1: mirrored */
  thumbSide?: 1 | -1;
  /** 0 = open palm, 1 = fist-ish; per finger [thumb, index, middle, ring, pinky] */
  curl?: [number, number, number, number, number];
  /** in-plane rotation in radians */
  rotation?: number;
};

/**
 * Builds a plausible 21-point hand: each finger is a chain of 4 points fanning out from the
 * wrist, bending back toward the palm as `curl` increases. Deterministic, for tests only.
 */
export function synthHand(opts: SynthOpts = {}): Landmark[] {
  const { cx = 0.5, cy = 0.7, size = 0.25, thumbSide = 1, curl = [0, 0, 0, 0, 0], rotation = 0 } = opts;
  // finger base angles (radians from "up"), thumb outermost
  const baseAngles = [1.0, 0.35, 0.1, -0.15, -0.4];
  const segLens = [
    [0.25, 0.2, 0.15, 0.12],
    [0.42, 0.2, 0.12, 0.1],
    [0.42, 0.22, 0.14, 0.1],
    [0.4, 0.2, 0.12, 0.09],
    [0.38, 0.15, 0.1, 0.08],
  ];
  const pts: { x: number; y: number; z: number }[] = [{ x: 0, y: 0, z: 0 }];
  for (let f = 0; f < 5; f++) {
    let x = 0;
    let y = 0;
    let z = 0;
    let ang = baseAngles[f];
    for (let s = 0; s < 4; s++) {
      if (s > 0) ang += curl[f] * 1.1 * Math.sign(baseAngles[f] || 1) * (f === 0 ? 0.5 : 1);
      const len = segLens[f][s];
      x += Math.sin(ang) * len;
      y -= Math.cos(ang) * len * (s > 0 ? 1 - curl[f] * 0.6 : 1);
      z -= s > 0 ? curl[f] * 0.05 : 0.01;
      pts.push({ x, y, z });
    }
  }
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return pts.map((p) => {
    const rx = (p.x * cos - p.y * sin) * thumbSide;
    const ry = p.x * sin + p.y * cos;
    return { x: cx + rx * size, y: cy + ry * size, z: p.z * size };
  });
}

/** Horizontal mirror of an image-space hand (x -> 1 - x). */
export function mirrorX(lms: Landmark[]): Landmark[] {
  return lms.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z }));
}

/**
 * Landmark normalization: pure functions, no DOM, no MediaPipe imports.
 *
 * Canonical space (what every classifier in this app sees):
 *   - a RIGHT hand, as it appears in a horizontally MIRRORED (selfie) image,
 *   - wrist at the origin,
 *   - scaled so the landmark farthest from the wrist is at distance 1.
 *
 * Why mirrored-right: the reused pretrained letter model (Ahmed7610/real-time-asl-recognition,
 * MIT) was trained on mirrored webcam frames of right hands with exactly this wrist-relative,
 * max-distance scaling (credited in the README).
 */

export type Landmark = { x: number; y: number; z: number };
export type Hand = "Left" | "Right";

export const NUM_LANDMARKS = 21;
export const FEATURE_DIM = NUM_LANDMARKS * 3;

/** MediaPipe landmark indices. */
export const LM = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_TIP: 12,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_TIP: 20,
} as const;

/** Bone connections for drawing a skeleton. */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17],
];

/**
 * Signer's real hand from MediaPipe's handedness label.
 *
 * MediaPipe's docs say the label assumes a mirrored (selfie) image, so we originally swapped it for raw
 * webcam frames. Measured on real recordings, that was wrong: with raw frames from the browser webcam,
 * a right hand (palm out, index knuckle on the camera's right of the pinky knuckle, 61/61 B frames) is
 * labelled "Right". So raw input -> label as-is; mirrored input -> swapped.
 */
export function realHandFromMediaPipe(label: string, inputMirrored: boolean): Hand {
  const l = label.toLowerCase().startsWith("l") ? "Left" : "Right";
  if (!inputMirrored) return l;
  return l === "Left" ? "Right" : "Left";
}

/** Whether x must be flipped to bring this hand into canonical (mirrored right-hand) space. */
export function needsFlip(hand: Hand, inputMirrored: boolean): boolean {
  // Raw right hand -> flip. Raw left hand already looks like a mirrored right hand.
  return (hand === "Right") !== inputMirrored;
}

/** Largest wrist-to-landmark distance; a rotation-invariant measure of hand size in image units. */
export function handSize(lms: readonly Landmark[]): number {
  const w = lms[LM.WRIST];
  let max = 0;
  for (const p of lms) {
    const d = Math.hypot(p.x - w.x, p.y - w.y, p.z - w.z);
    if (d > max) max = d;
  }
  return max;
}

/**
 * Normalize 21 landmarks to a 63-dim feature vector [x0,y0,z0, x1,y1,z1, ...]
 * in canonical space. Throws on wrong landmark count.
 */
export function normalizeLandmarks(lms: readonly Landmark[], hand: Hand, inputMirrored = false): number[] {
  if (lms.length !== NUM_LANDMARKS) {
    throw new Error(`expected ${NUM_LANDMARKS} landmarks, got ${lms.length}`);
  }
  const flip = needsFlip(hand, inputMirrored) ? -1 : 1;
  const w = lms[LM.WRIST];
  const size = handSize(lms);
  const scale = size > 1e-6 ? 1 / size : 1;
  const out = new Array<number>(FEATURE_DIM);
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    const p = lms[i];
    out[i * 3] = flip * (p.x - w.x) * scale;
    out[i * 3 + 1] = (p.y - w.y) * scale;
    out[i * 3 + 2] = (p.z - w.z) * scale;
  }
  return out;
}

/**
 * Wrist speed in hand-sizes per second between two frames (scale-invariant motion gate).
 * Returns 0 if dt <= 0.
 */
export function handSpeed(
  prev: readonly Landmark[],
  prevT: number,
  cur: readonly Landmark[],
  t: number,
): number {
  const dt = (t - prevT) / 1000;
  if (dt <= 0) return 0;
  const a = prev[LM.WRIST];
  const b = cur[LM.WRIST];
  const size = Math.max(handSize(cur), 1e-6);
  return Math.hypot(b.x - a.x, b.y - a.y) / size / dt;
}

/** Mean of the wrist and the four finger bases (x, y): steadier than the wrist alone. */
export function palmCenter(lms: readonly Landmark[]): { x: number; y: number } {
  const ids = [LM.WRIST, 5, 9, 13, 17];
  let x = 0;
  let y = 0;
  for (const i of ids) {
    x += lms[i].x / ids.length;
    y += lms[i].y / ids.length;
  }
  return { x, y };
}

/** Euclidean distance between two equal-length vectors. */
export function euclidean(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

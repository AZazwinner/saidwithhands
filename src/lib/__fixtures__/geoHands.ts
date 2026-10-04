import type { Landmark } from "../features";

/**
 * Explicit 3D "world" hands in a palm frame (y up = negative, z toward camera = negative),
 * for testing geometry features and rules. Knuckles: index x=0.3 ... pinky x=-0.3 at y=-1.
 */
const P = (x: number, y: number, z: number): Landmark => ({ x, y, z });
const KNUCKLE_X = [0.3, 0.1, -0.1, -0.3];

function curledFinger(x: number): Landmark[] {
  return [P(x, -1, 0), P(x, -1.2, -0.35), P(x, -0.95, -0.45), P(x, -0.75, -0.3)];
}
function straightFinger(x: number, len = 1): Landmark[] {
  return [P(x, -1, 0), P(x, -1 - 0.45 * len, 0), P(x, -1 - 0.75 * len, 0), P(x, -1 - 0.98 * len, 0)];
}

function build(thumb: Landmark[], fingers: ("curl" | "straight")[]): Landmark[] {
  const out = [P(0, 0, 0), ...thumb];
  fingers.forEach((f, i) =>
    out.push(...(f === "curl" ? curledFinger(KNUCKLE_X[i]) : straightFinger(KNUCKLE_X[i]))),
  );
  return out;
}

/** Fist with the thumb tip tucked across the knuckle line at fraction t (0 = index, 1 = pinky). */
export function fistWithThumbAt(t: number, depth = -0.4, height = -1.05): Landmark[] {
  const x = 0.3 - 0.6 * t;
  const tip = P(x, height, depth);
  const thumb = [
    P(0.25, -0.25, -0.05),
    P(0.35, -0.55, -0.2),
    P((0.35 + x) / 2, (height - 0.55) / 2 - 0.05, depth),
    tip,
  ];
  return build(thumb, ["curl", "curl", "curl", "curl"]);
}

/** "A": fist with the thumb straight up along the side of the index finger. */
export function fistThumbSide(): Landmark[] {
  const thumb = [P(0.3, -0.25, -0.05), P(0.4, -0.6, -0.05), P(0.42, -0.85, -0.05), P(0.42, -1.1, -0.05)];
  return build(thumb, ["curl", "curl", "curl", "curl"]);
}

/** Thumb extended roughly parallel to the index, as in G and H. */
const parallelThumb = [
  P(0.3, -0.25, -0.05),
  P(0.42, -0.55, -0.1),
  P(0.45, -0.85, -0.12),
  P(0.46, -1.1, -0.12),
];

export const handG = () => build(parallelThumb, ["straight", "curl", "curl", "curl"]);
export const handH = () => build(parallelThumb, ["straight", "straight", "curl", "curl"]);

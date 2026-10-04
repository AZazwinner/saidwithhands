// Simulation: teach a handshape sign exactly like the Teach screen does (5 examples, each the mean of
// ~1.6 s of frames), then hold the sign again and see whether the real Recognizer accepts it.
// Noise is MediaPipe-like per-frame landmark jitter (in hand-size units) plus the pose drift of
// re-forming the sign each time. Run: npx tsx scripts/sim-teach.mts
import type { Hand, Landmark } from "../src/lib/features";
import { normalizeLandmarks } from "../src/lib/features";
import { DEFAULT_HOLD } from "../src/lib/holdConfirm";
import type { Classifier } from "../src/lib/letterModel";
import { Recognizer } from "../src/lib/recognizer";
import { buildLibrary, handshapeExample, signThreshold, type TaughtSign } from "../src/lib/signs";
import { synthHand } from "../src/lib/__fixtures__/synthHand";

// Letters: a classifier that doesn't recognize this shape at all ("no other character resembled it").
const unsure: Classifier = { labels: ["U", "V", "B"], predict: () => [0.34, 0.33, 0.33] };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());

const SIZE = 0.25; // hand size in image units (synthHand's farthest landmark is ~0.8 of this)
/** One webcam frame of `base`: pose drift `drift` (fixed per repetition) + per-frame jitter. */
function frame(base: Landmark[], drift: Landmark[], jitter: number, zJitter: number, r: () => number): Landmark[] {
  return base.map((p, i) => ({
    x: p.x + drift[i].x + gauss(r) * jitter * SIZE,
    y: p.y + drift[i].y + gauss(r) * jitter * SIZE,
    z: p.z + drift[i].z + gauss(r) * zJitter * SIZE,
  }));
}
/** Tilt the hand about the wrist: `roll` in the image plane, `yaw` turning it toward/away from the camera. */
function tilt(lms: Landmark[], roll: number, yaw: number): Landmark[] {
  const w = lms[0];
  return lms.map((p) => {
    let x = p.x - w.x;
    let y = p.y - w.y;
    let z = p.z - w.z;
    [x, y] = [x * Math.cos(roll) - y * Math.sin(roll), x * Math.sin(roll) + y * Math.cos(roll)];
    [x, z] = [x * Math.cos(yaw) - z * Math.sin(yaw), x * Math.sin(yaw) + z * Math.cos(yaw)];
    return { x: w.x + x, y: w.y + y, z: w.z + z };
  });
}
const DEG = Math.PI / 180;
// Hand angle differences (SD, degrees): between back-to-back teaching repetitions, and when signing later.
// Assumptions, like the jitter.
const TILT = { teach: Number(process.env.TEACH_TILT ?? 3), live: Number(process.env.LIVE_TILT ?? 0) };

const driftFor = (r: () => number, amount: number): Landmark[] =>
  Array.from({ length: 21 }, () => ({ x: gauss(r) * amount * SIZE, y: gauss(r) * amount * SIZE, z: gauss(r) * amount * SIZE }));

function trial(
  jitter: number,
  drift: number,
  seed: number,
  curl: [number, number, number, number, number],
  heldCurl: [number, number, number, number, number] = curl,
  turn: [number, number] = [0, 0],
) {
  const r = rng(seed);
  const base = synthHand({ curl });
  const hand: Hand = "Right";

  // ---- teach: 5 examples, each = handshapeExample(mean of ~48 frames at 30 fps over 1.6 s)
  const examples: number[][] = [];
  for (let e = 0; e < 5; e++) {
    const d = driftFor(r, drift);
    const tilted = tilt(base, gauss(r) * TILT.teach * DEG, gauss(r) * TILT.teach * DEG);
    const shapes = Array.from({ length: 48 }, () =>
      normalizeLandmarks(frame(tilted, d, jitter, jitter * 2, r), hand),
    );
    examples.push(handshapeExample(shapes));
  }
  const sign: TaughtSign = { id: "s", meaning: "MY MEDICATION", kind: "handshape", examples };
  const threshold = signThreshold(sign);

  // ---- use: hold the sign for 3 s, as the user would on the Communicate page
  const rec = new Recognizer(unsure, {
    signs: buildLibrary([sign]),
    hold: { ...DEFAULT_HOLD },
  });
  const d = driftFor(r, drift);
  const held = tilt(
    synthHand({ curl: heldCurl }),
    (gauss(r) * TILT.live + turn[0]) * DEG,
    (gauss(r) * TILT.live + turn[1]) * DEG,
  );
  let acceptedAt: number | null = null;
  const dists: number[] = [];
  for (let t = 0; t < 3000; t += 33) {
    const lms = frame(held, d, jitter, jitter * 2, r);
    dists.push(Math.min(...examples.map((ex) => Math.hypot(...normalizeLandmarks(lms, hand).map((v, i) => v - ex[i])))));
    const out = rec.process({ t, landmarks: lms, hand }, t);
    if (out.accepted?.v === "MY MEDICATION" && acceptedAt === null) acceptedAt = t;
  }
  dists.sort((a, b) => a - b);
  return { threshold, acceptedAt, medianD: dists[Math.floor(dists.length / 2)] };
}

const CURLS: [number, number, number, number, number][] = [
  [0.9, 0, 0, 0, 0.9], // like a "shaka"
  [0, 1, 1, 1, 0.2],
  [0.6, 0.2, 1, 1, 1],
];
console.log("jitter = per-coordinate landmark noise per frame, in hand sizes (xy; z is 2x). drift = pose change between repetitions.");
console.log("jitter  drift | accepted / 30 trials | median live distance vs limit");
for (const [jitter, drift] of [
  [0.004, 0.01],
  [0.007, 0.015],
  [0.01, 0.02],
  [0.015, 0.03],
] as const) {
  let ok = 0;
  const ratios: number[] = [];
  for (let k = 0; k < 30; k++) {
    const res = trial(jitter, drift, 1000 + k * 7919, CURLS[k % CURLS.length]);
    if (res.acceptedAt !== null) ok++;
    ratios.push(res.medianD / res.threshold);
  }
  ratios.sort((a, b) => a - b);
  console.log(
    `${jitter.toFixed(3)}  ${drift.toFixed(3)} | ${String(ok).padStart(2)}/30 | median d/limit = ${ratios[15].toFixed(2)} (accepted when the sign's score holds >= 0.6 for 700 ms)`,
  );
}

console.log("\nRejection: hold a DIFFERENT shape than the one taught (must NOT be accepted)");
const OTHERS: [string, [number, number, number, number, number]][] = [
  ["open hand", [0, 0, 0, 0, 0]],
  ["fist", [0.8, 1, 1, 1, 1]],
  ["peace sign", [0.6, 0, 0, 1, 1]],
  ["thumbs up", [0, 1, 1, 1, 1]],
];
// Same hand shape as taught, turned well past the tilt allowance (must also NOT be accepted).
const TURNED: [string, number, number][] = [
  ["turned 45 deg in the image plane", 45, 0],
  ["turned 90 deg (e.g. thumb sideways)", 90, 0],
  ["upside down (thumbs up -> down)", 180, 0],
  ["turned 60 deg toward the camera", 0, 60],
];
for (const [name, other] of OTHERS) {
  let wrong = 0;
  for (let k = 0; k < 30; k++) {
    const res = trial(0.007, 0.015, 5000 + k * 104729, CURLS[k % CURLS.length], other);
    if (res.acceptedAt !== null) wrong++;
  }
  console.log(`  taught shaka/point/etc., held ${name.padEnd(10)}: wrongly accepted ${wrong}/30`);
}
for (const [name, roll, yaw] of TURNED) {
  let wrong = 0;
  for (let k = 0; k < 30; k++) {
    const curl = CURLS[k % CURLS.length];
    if (trial(0.007, 0.015, 7000 + k * 104729, curl, curl, [roll, yaw]).acceptedAt !== null) wrong++;
  }
  console.log(`  same shape ${name.padEnd(36)}: wrongly accepted ${wrong}/30`);
}

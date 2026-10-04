// Simulation: teach a MOTION sign exactly like the Teach screen does (5 recordings of 1.6 s, trimmed and
// resampled), then perform it again later on the Communicate page through the real Recognizer and see
// whether it is accepted. Also checks that a different movement is NOT accepted.
// Run: npx tsx scripts/sim-motion.mts
// The variation numbers are assumptions (how much a person's repetitions differ), not measurements.
import type { Hand, Landmark } from "../src/lib/features";
import type { Classifier } from "../src/lib/letterModel";
import { Recognizer } from "../src/lib/recognizer";
import { DEFAULT_SEGMENTER } from "../src/lib/motionSegmenter";
import { buildLibrary, motionSequence, signThreshold, THRESHOLDS, trimToMotion, type MotionFrame, type TaughtSign } from "../src/lib/signs";
import { synthHand } from "../src/lib/__fixtures__/synthHand";

// Tuning: MOTION_MIN / MOTION_FACTOR override the motion rejection limit for a sweep.
if (process.env.MOTION_MIN) (THRESHOLDS.motion as { min: number }).min = Number(process.env.MOTION_MIN);
if (process.env.DIP) DEFAULT_SEGMENTER.dipFraction = Number(process.env.DIP);
if (process.env.MOTION_FACTOR) (THRESHOLDS.motion as { factor: number }).factor = Number(process.env.MOTION_FACTOR);

const unsure: Classifier = { labels: ["U", "V", "B"], predict: () => [0.34, 0.33, 0.33] };
const SIZE = 0.2; // hand size in image units
const FPS = 30;
const RECORD_MS = 1600; // Teacher.tsx

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());

type Path = (s: number) => [number, number]; // s in [0,1] -> offset in hand sizes
const PATHS: Record<string, { path: Path; curl: [number, number, number, number, number] }> = {
  arc: { path: (s) => [1.2 - 1.2 * Math.cos(Math.PI * s), -1.2 * Math.sin(Math.PI * s)], curl: [0, 0, 0, 0, 0] },
  "swipe down": { path: (s) => [0, 2 * s], curl: [0.8, 1, 1, 1, 1] },
  zigzag: { path: (s) => [s < 0.5 ? 2.4 * s : 2.4 * (1 - s), 0.6 * s], curl: [0.6, 0, 0, 1, 1] },
  circle: { path: (s) => [0.8 * Math.sin(2 * Math.PI * s), 0.8 - 0.8 * Math.cos(2 * Math.PI * s)], curl: [0.9, 0, 1, 1, 1] },
  "out and back": { path: (s) => [1.6 * Math.sin(Math.PI * s), 0], curl: [0, 1, 1, 1, 0] },
};
// Near misses for the rejection test: same hand, similar but different movement.
const LOOKALIKES: Record<string, (typeof PATHS)[string]> = {
  "straight right": { path: (s) => [2.4 * s, 0], curl: [0, 0, 0, 0, 0] }, // arc's chord
  "swipe diagonal": { path: (s) => [1.4 * s, 1.4 * s], curl: [0.8, 1, 1, 1, 1] }, // swipe down, 45 degrees off
  "up and back": { path: (s) => [0, -1.6 * Math.sin(Math.PI * s)], curl: [0, 1, 1, 1, 0] }, // out and back, turned 90
  "half circle": { path: (s) => [0.8 * Math.sin(Math.PI * s), 0.8 - 0.8 * Math.cos(Math.PI * s)], curl: [0.9, 0, 1, 1, 1] },
  "single zag": { path: (s) => [1.2 * s, 0.3 * s], curl: [0.6, 0, 0, 1, 1] }, // zigzag without the return
};

type Var = { dur: number; amp: number; rot: number; wobble: number; curl: number; jitter: number };
const TEACH: Var = { dur: 0.15, amp: 0.08, rot: 0.09, wobble: 0.08, curl: 0.04, jitter: 0.007 };
const LIVE: Var = { dur: 0.3, amp: 0.2, rot: 0.2, wobble: 0.15, curl: 0.08, jitter: 0.007 };

/** One performance: frames (landmarks per frame) = rest `pre` ms, the movement, rest `post` ms. */
function perform(name: string, v: Var, r: () => number, pre: number, post: number): { t: number; lms: Landmark[] }[] {
  const { path, curl } = PATHS[name] ?? LOOKALIKES[name];
  const D = 900 * (1 + v.dur * gauss(r));
  const amp = 1 + v.amp * gauss(r);
  const rot = v.rot * gauss(r);
  const w1 = v.wobble * gauss(r), w2 = v.wobble * gauss(r), ph = r() * 6;
  const c = curl.map((x) => Math.min(1, Math.max(0, x + v.curl * gauss(r)))) as typeof curl;
  const cx0 = 0.4 + 0.1 * r(), cy0 = 0.55 + 0.1 * r();
  const out: { t: number; lms: Landmark[] }[] = [];
  const total = pre + D + post;
  for (let t = 0; t <= total; t += 1000 / FPS) {
    const lin = Math.min(1, Math.max(0, (t - pre) / D));
    const s = lin * lin * (3 - 2 * lin); // smooth start and stop
    let [x, y] = path(s);
    x = x * amp + w1 * Math.sin(Math.PI * s + ph);
    y = y * amp + w2 * Math.sin(2 * Math.PI * s + ph);
    const rx = x * Math.cos(rot) - y * Math.sin(rot);
    const ry = x * Math.sin(rot) + y * Math.cos(rot);
    const base = synthHand({ curl: c, size: SIZE, cx: cx0 + rx * SIZE * 0.8, cy: cy0 + ry * SIZE * 0.8 });
    out.push({
      t,
      lms: base.map((p) => ({
        x: p.x + gauss(r) * v.jitter * SIZE,
        y: p.y + gauss(r) * v.jitter * SIZE,
        z: p.z + gauss(r) * v.jitter * 2 * SIZE,
      })),
    });
  }
  return out;
}

/**
 * Several movements flowing into each other with NO rest between them (only the whole chain starts and ends
 * smoothly): `{ transition }` is a short straight movement in a random direction (a false start, or getting
 * into position for the next sign); `{ name }` is a taught sign with the LIVE variation. Each piece starts
 * where the previous one ended. Each sign has its own handshape; during a transition the hand changes
 * from the previous sign's shape to the next one's.
 */
type Piece = { name: string } | { transition: true };
function performChain(pieces: Piece[], r: () => number, pre: number, post: number): { t: number; lms: Landmark[] }[] {
  const curlOf = (name: string) =>
    (PATHS[name] ?? LOOKALIKES[name]).curl.map((x) => Math.min(1, Math.max(0, x + LIVE.curl * gauss(r))));
  const signCurls = pieces.map((p) => ("name" in p ? curlOf(p.name) : null));
  const near = (i: number, dir: 1 | -1) => {
    for (let j = i; j >= 0 && j < pieces.length; j += dir) if (signCurls[j]) return signCurls[j]!;
    return null;
  };
  const parts = pieces.map((p, i) => {
    if ("transition" in p) {
      const th = r() * 2 * Math.PI;
      const L = 0.6 + 0.6 * r();
      const from = near(i, -1) ?? near(i, 1)!;
      const to = near(i, 1) ?? from;
      return {
        D: 250 + 200 * r(),
        at: (s: number): [number, number] => [L * s * Math.cos(th), L * s * Math.sin(th)],
        curl: (s: number) => from.map((c, k) => c + (to[k] - c) * s),
      };
    }
    const { path } = PATHS[p.name] ?? LOOKALIKES[p.name];
    const amp = 1 + LIVE.amp * gauss(r);
    const rot = LIVE.rot * gauss(r);
    const w1 = LIVE.wobble * gauss(r), w2 = LIVE.wobble * gauss(r), ph = r() * 6;
    return {
      D: 900 * (1 + LIVE.dur * gauss(r)),
      at: (s: number): [number, number] => {
        const [x0, y0] = path(s);
        const x = x0 * amp + w1 * Math.sin(Math.PI * s + ph);
        const y = y0 * amp + w2 * Math.sin(2 * Math.PI * s + ph);
        return [x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot)];
      },
      curl: () => signCurls[i]!,
    };
  });
  const total = parts.reduce((a, p) => a + p.D, 0);
  const cx0 = 0.4 + 0.1 * r(), cy0 = 0.5 + 0.1 * r();
  const out: { t: number; lms: Landmark[] }[] = [];
  for (let t = 0; t <= pre + total + post; t += 1000 / FPS) {
    // smooth start and stop of the whole chain; constant pace inside it, so no pause at the joins
    const lin = Math.min(1, Math.max(0, (t - pre) / total));
    let tau = (lin < 0.1 ? (lin * lin) / 0.2 : lin > 0.9 ? 0.9 - ((1 - lin) * (1 - lin)) / 0.2 : lin - 0.05) / 0.9 * total;
    let x = 0, y = 0;
    let curl = parts[0].curl(0);
    for (const p of parts) {
      const s = Math.min(1, Math.max(0, tau / p.D));
      const [dx, dy] = p.at(s);
      const [ex, ey] = p.at(0);
      x += dx - ex;
      y += dy - ey;
      curl = p.curl(s);
      tau -= p.D;
      if (tau < 0) break;
    }
    const base = synthHand({ curl: curl as never, size: SIZE, cx: cx0 + x * SIZE * 0.8, cy: cy0 + y * SIZE * 0.8 });
    out.push({
      t,
      lms: base.map((p) => ({ x: p.x + gauss(r) * LIVE.jitter * SIZE, y: p.y + gauss(r) * LIVE.jitter * SIZE, z: p.z + gauss(r) * LIVE.jitter * 2 * SIZE })),
    });
  }
  return out;
}

const hand: Hand = "Right";
function teach(name: string, r: () => number): TaughtSign {
  const examples: number[][][] = [];
  for (let e = 0; e < 5; e++) {
    // Teacher: frames from the recognizer's motionFrame during the 1.6 s window; the user starts after a
    // short reaction time.
    const rec = new Recognizer(unsure, {});
    const frames: MotionFrame[] = [];
    for (const f of perform(name, TEACH, r, 150 + 200 * r(), 1000)) {
      const out = rec.process({ t: f.t, landmarks: f.lms, hand }, f.t);
      if (f.t <= RECORD_MS && out.motionFrame) frames.push(out.motionFrame);
    }
    examples.push(motionSequence(trimToMotion(frames)));
  }
  return { id: name, meaning: name.toUpperCase(), kind: "motion", examples };
}

/** d / limit of the best match for every movement the recognizer cut out (for the summary). */
const ratios: number[] = [];
function liveAccepts(lib: ReturnType<typeof buildLibrary>, name: string, r: () => number): string | null {
  const match = lib.matchMotion;
  lib.matchMotion = (q) => {
    const m = match(q);
    if (m.best) ratios.push(m.best.d / m.best.threshold);
    return m;
  };
  const rec = new Recognizer(unsure, { signs: lib });
  let got: string | null = null;
  for (const f of perform(name, LIVE, r, 600, 900)) {
    const out = rec.process({ t: f.t, landmarks: f.lms, hand }, f.t);
    if (out.accepted?.kind === "sign") got ??= out.accepted.v;
  }
  return got;
}

const names = Object.keys(PATHS);
console.log("Taught alone, performed again later (30 trials each): accepted / threshold");
for (const name of names) {
  let ok = 0;
  const ths: number[] = [];
  for (let k = 0; k < 30; k++) {
    const r = rng(100 + k * 7919 + name.length);
    const sign = teach(name, r);
    ths.push(signThreshold(sign));
    if (liveAccepts(buildLibrary([sign]), name, r) === sign.meaning) ok++;
  }
  ths.sort((a, b) => a - b);
  const rs = ratios.splice(0).sort((a, b) => a - b);
  console.log(
    `  ${name.padEnd(13)} ${String(ok).padStart(2)}/30   median limit ${ths[15].toFixed(2)}   ` +
      `${rs.length} movements matched, d/limit median ${rs[rs.length >> 1]?.toFixed(2)}, 90th ${rs[Math.floor(rs.length * 0.9)]?.toFixed(2)}`,
  );
}

console.log("\nAll five taught together; perform each (30 trials): right / wrong / none");
let right = 0, wrong = 0, none = 0;
for (let k = 0; k < 30; k++) {
  const r = rng(9000 + k * 104729);
  const lib = buildLibrary(names.map((n) => teach(n, r)));
  for (const name of names) {
    const got = liveAccepts(lib, name, r);
    if (got === name.toUpperCase()) right++;
    else if (got) wrong++;
    else none++;
  }
}
console.log(`  ${right} right, ${wrong} wrong, ${none} not recognized (of ${30 * names.length})`);

console.log("\nRejection: teach one movement, perform a DIFFERENT one (must not be accepted)");
for (const [taught, done] of [
  ["arc", "swipe down"],
  ["circle", "out and back"],
  ["arc", "straight right"],
  ["swipe down", "swipe diagonal"],
  ["out and back", "up and back"],
  ["circle", "half circle"],
  ["zigzag", "single zag"],
]) {
  let bad = 0;
  for (let k = 0; k < 30; k++) {
    const r = rng(5000 + k * 31 + taught.length);
    if (liveAccepts(buildLibrary([teach(taught, r)]), done, r)) bad++;
  }
  console.log(`  taught ${taught.padEnd(11)} did ${done.padEnd(13)} wrongly accepted ${bad}/30`);
}

// ---- continuous signing: false starts and signs back to back, no rest in between ----
function chainAccepts(lib: ReturnType<typeof buildLibrary>, pieces: Piece[], r: () => number): string[] {
  const rec = new Recognizer(unsure, { signs: lib });
  const got: string[] = [];
  for (const f of performChain(pieces, r, 600, 900)) {
    const out = rec.process({ t: f.t, landmarks: f.lms, hand }, f.t);
    if (out.accepted?.kind === "sign") got.push(out.accepted.v);
  }
  return got;
}
console.log("\nContinuous signing, all five taught (30 trials x 5 signs each):");
let fsOk = 0, fsWrong = 0, b2bBoth = 0, b2bFirst = 0, b2bSecond = 0, b2bWrong = 0;
for (let k = 0; k < 30; k++) {
  const r = rng(12000 + k * 7919);
  const lib = buildLibrary(names.map((n) => teach(n, r)));
  for (const [i, name] of names.entries()) {
    // false start, then the sign
    const a = chainAccepts(lib, [{ transition: true }, { name }], r);
    if (a.includes(name.toUpperCase())) fsOk++;
    if (a.some((v) => v !== name.toUpperCase())) fsWrong++;
    // this sign, then the next one, with no rest between
    const next = names[(i + 1) % names.length];
    const b = chainAccepts(lib, [{ name }, { transition: true }, { name: next }], r);
    const firstOk = b.includes(name.toUpperCase()), secondOk = b.includes(next.toUpperCase());
    if (firstOk && secondOk) b2bBoth++;
    if (firstOk) b2bFirst++;
    if (secondOk) b2bSecond++;
    if (b.some((v) => v !== name.toUpperCase() && v !== next.toUpperCase())) b2bWrong++;
  }
}
console.log(`  false start then sign: sign recognized ${fsOk}/150, something else typed ${fsWrong}/150`);
console.log(`  two signs, no rest:    both ${b2bBoth}/150 (first ${b2bFirst}, second ${b2bSecond}), something else typed ${b2bWrong}/150`);

import { describe, expect, it } from "vitest";
import { dtw, resample } from "./dtw";
import { normalizeLandmarks, type Hand, type Landmark } from "./features";
import { MotionSegmenter } from "./motionSegmenter";
import {
  buildLibrary,
  handshapeExample,
  isSignLibraryJson,
  mergeSigns,
  motionSequence,
  normalizeMeaning,
  pathLength,
  signThreshold,
  signLetter,
  trackOf,
  trackSequence,
  representativeExample,
  motionFrames,
  trimToMotion,
  type MotionFrame,
  type TaughtSign,
} from "./signs";
import { synthHand } from "./__fixtures__/synthHand";

/** Deterministic pseudo-random generator. */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
}

// ---------- synthetic motion ----------
type Path = (u: number) => { x: number; y: number }; // u in 0..1, offset in hand sizes
const circle: Path = (u) => ({ x: Math.cos(u * 2 * Math.PI) - 1, y: Math.sin(u * 2 * Math.PI) });
const swipeRight: Path = (u) => ({ x: 2 * u, y: 0 });
const swipeDown: Path = (u) => ({ x: 0, y: 2 * u });
const zigzag: Path = (u) => ({ x: 2 * u, y: Math.abs(((u * 3) % 1) - 0.5) * 2 }); // like Z

const HAND = synthHand();
const SHAPE = normalizeLandmarks(HAND, "Right");
const SIZE = 0.2;

/** Render a path as tracked frames: `ms` long, optional time warp and noise, still padding around it. */
function perform(
  path: Path,
  { ms = 900, warp = 1, noise = 0.01, seed = 1, padMs = 300, t0 = 0, hand = "Right" as Hand } = {},
) {
  const r = rng(seed);
  const frames: MotionFrame[] = [];
  const at = (u: number, t: number): MotionFrame => {
    const p = path(Math.min(1, Math.max(0, u)));
    const wrist: Landmark = {
      x: 0.5 + p.x * SIZE + r() * noise * SIZE,
      y: 0.5 + p.y * SIZE + r() * noise * SIZE,
      z: 0,
    };
    return { t, shape: SHAPE.map((v) => v + r() * noise), wrist, size: SIZE, hand };
  };
  let t = t0;
  for (; t < t0 + padMs; t += 33) frames.push(at(0, t));
  const start = t;
  for (; t < start + ms; t += 33) frames.push(at(Math.pow((t - start) / ms, warp), t));
  for (const end = t + padMs; t < end; t += 33) frames.push(at(1, t));
  return frames;
}

const motionSign = (meaning: string, path: Path, n = 5): TaughtSign => ({
  id: meaning,
  meaning,
  kind: "motion",
  examples: Array.from({ length: n }, (_, i) =>
    motionSequence(trimToMotion(perform(path, { seed: 10 + i, ms: 800 + i * 60, warp: 0.85 + i * 0.07 }))),
  ),
});

describe("dtw", () => {
  const a = resample(
    perform(circle).map((f) => [f.wrist.x, f.wrist.y]),
    24,
  );

  it("is zero for identical sequences", () => {
    expect(dtw(a, a)).toBeCloseTo(0, 12);
  });

  it("is small for a time-warped copy and large for a different path", () => {
    const warped = resample(
      perform(circle, { warp: 1.6, seed: 3 }).map((f) => [f.wrist.x, f.wrist.y]),
      24,
    );
    const other = resample(
      perform(swipeRight).map((f) => [f.wrist.x, f.wrist.y]),
      24,
    );
    expect(dtw(a, warped)).toBeLessThan(dtw(a, other) / 3);
  });

  it("is symmetric", () => {
    const b = resample(
      perform(zigzag).map((f) => [f.wrist.x, f.wrist.y]),
      24,
    );
    expect(dtw(a, b)).toBeCloseTo(dtw(b, a), 12);
  });

  it("resamples to the requested length, keeping endpoints", () => {
    const r = resample([[0], [10]], 5);
    expect(r.map((v) => v[0])).toEqual([0, 2.5, 5, 7.5, 10]);
  });
});

describe("motion signs (DTW nearest neighbor with rejection)", () => {
  const lib = buildLibrary([
    motionSign("PLEASE", circle),
    motionSign("THANK YOU", swipeDown),
    motionSign("Z", zigzag),
  ]);
  const query = (path: Path, seed: number, opts = {}) =>
    lib.matchMotion(motionSequence(trimToMotion(perform(path, { seed, ...opts }))));

  it("recognizes new performances of each taught sign, even slower/faster", () => {
    expect(query(circle, 99, { ms: 1200, warp: 1.3 }).candidates[0]?.v).toBe("PLEASE");
    expect(query(swipeDown, 98, { ms: 700 }).candidates[0]?.v).toBe("THANK YOU");
    expect(query(zigzag, 97).candidates[0]?.v).toBe("Z");
  });

  it("rejects a movement it was never taught", () => {
    expect(query(swipeRight, 96).candidates).toEqual([]);
  });

  it("matches a left-handed signer mirrored", () => {
    const mirrored: Path = (u) => ({ x: -swipeRight(u).x, y: 0 });
    const right = buildLibrary([motionSign("NEXT", swipeRight)]);
    const leftFrames = trimToMotion(perform(mirrored, { seed: 5, hand: "Left" }));
    expect(right.matchMotion(motionSequence(leftFrames)).candidates[0]?.v).toBe("NEXT");
  });
});

describe("handshape signs", () => {
  const shapeOf = (curl: [number, number, number, number, number], seed: number) => {
    const r = rng(seed);
    const frames = Array.from({ length: 30 }, () =>
      normalizeLandmarks(synthHand({ curl }), "Right").map((v) => v + r() * 0.01),
    );
    return handshapeExample(frames);
  };
  const ily: [number, number, number, number, number] = [0, 0, 1, 1, 0];
  const sign: TaughtSign = {
    id: "ily",
    meaning: "I LOVE YOU",
    kind: "handshape",
    examples: [1, 2, 3, 4, 5].map((s) => shapeOf(ily, s)),
  };
  const lib = buildLibrary([sign]);

  it("recognizes the taught handshape", () => {
    expect(lib.matchHandshape(shapeOf(ily, 42)).candidates[0]?.v).toBe("I LOVE YOU");
  });

  it("rejects a different handshape", () => {
    expect(lib.matchHandshape(shapeOf([0, 0, 0, 0, 0], 43)).candidates).toEqual([]);
    expect(lib.matchHandshape(shapeOf([1, 1, 1, 1, 1], 44)).candidates).toEqual([]);
  });

  it("keeps thresholds within the configured bounds", () => {
    const t = signThreshold(sign);
    expect(t).toBeGreaterThanOrEqual(0.18);
    expect(t).toBeLessThanOrEqual(0.6);
  });
});

describe("teaching helpers", () => {
  it("auto-detects movement by wrist path length", () => {
    expect(pathLength(perform(circle))).toBeGreaterThan(3);
    expect(pathLength(perform(() => ({ x: 0, y: 0 })))).toBeLessThan(1);
  });

  it("trims still frames around the movement", () => {
    const frames = perform(swipeRight, { padMs: 600 });
    const trimmed = trimToMotion(frames);
    expect(trimmed.length).toBeLessThan(frames.length * 0.8);
    expect(trimmed.length).toBeGreaterThan(20);
  });

  it("validates and merges imported libraries", () => {
    const s = motionSign("hello", swipeRight, 2);
    expect(isSignLibraryJson({ version: 1, signs: [s] })).toBe(true);
    expect(isSignLibraryJson({ version: 1, signs: [{ ...s, examples: [] }] })).toBe(false);
    expect(isSignLibraryJson({ version: 2, signs: [] })).toBe(false);
    const merged = mergeSigns([s], [{ ...s, id: "new", meaning: " Hello " }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("new");
    expect(normalizeMeaning("  my   medication ")).toBe("MY MEDICATION");
  });
});

describe("MotionSegmenter", () => {
  /** Speeds as the recognizer computes them (hand sizes / s), from consecutive frames. */
  function run(frames: (MotionFrame | null)[]) {
    const seg = new MotionSegmenter();
    const out: MotionFrame[][] = [];
    let prev: MotionFrame | null = null;
    let speed = 0;
    for (const f of frames) {
      const s =
        f && prev
          ? Math.hypot(f.wrist.x - prev.wrist.x, f.wrist.y - prev.wrist.y) / f.size / ((f.t - prev.t) / 1000)
          : 0;
      speed = f ? 0.5 * speed + 0.5 * s : 0; // same EMA as the recognizer
      const done = seg.push(f, speed);
      if (done?.final) out.push(done.frames); // mid-movement slow-downs are checked separately
      prev = f;
    }
    return out;
  }

  it("emits one segment per movement between rests", () => {
    const a = perform(swipeRight, { padMs: 500 });
    const back: Path = (u) => ({ x: 2 - 2 * u, y: Math.sin(u * Math.PI) }); // starts where `a` ended
    const b = perform(back, { padMs: 500, t0: a.at(-1)!.t + 33 });
    const segs = run([...a, ...b]);
    expect(segs).toHaveLength(2);
    expect(segs[0].length).toBeGreaterThan(15);
  });

  it("ignores tiny jitter", () => {
    expect(run(perform(() => ({ x: 0, y: 0 }), { padMs: 1000 }))).toHaveLength(0);
  });

  it("ends a segment when the hand leaves the frame", () => {
    const a = perform(swipeDown, { padMs: 200 }).slice(0, -6);
    expect(run([...a.slice(0, 25), null])).toHaveLength(1);
  });
});

describe("fixed limit", () => {
  it("uses a sign's own limit instead of deriving one, and validates it on import", () => {
    const ex = [Array(63).fill(0), Array(63).fill(0.2)];
    const sign = { id: "d", meaning: "[DELETE]", kind: "handshape" as const, examples: ex, action: "delete" as const };
    expect(signThreshold({ ...sign, limit: 0.3 })).toBe(0.3);
    expect(signThreshold(sign)).not.toBe(0.3);
    expect(isSignLibraryJson({ version: 1, signs: [{ ...sign, limit: 0.3 }] })).toBe(true);
    expect(isSignLibraryJson({ version: 1, signs: [{ ...sign, limit: -1 }] })).toBe(false);
  });
});

describe("preview helpers", () => {
  it("picks the most typical example, and unpacks motion frames into wrist path + hand shape", () => {
    const a = Array(63).fill(0);
    const sign = { id: "h", meaning: "X", kind: "handshape" as const, examples: [a.map(() => 0.5), a, a.map(() => 0.05)] };
    expect(representativeExample(sign)).toBe(sign.examples[2]); // closest to both others
    const frames = motionFrames([[0.5, -0.25, ...Array(63).fill(0.35)]]);
    expect(frames[0].wrist).toEqual({ x: 0.5, y: -0.25 });
    expect(frames[0].shape[0]).toBeCloseTo(1); // shape columns are stored x SHAPE_W
  });
});

describe("letter signs (J, Z)", () => {
  it("names like LETTER Z type the letter, and J/Z follow the drawing fingertip", () => {
    expect(signLetter({ meaning: "LETTER Z" })).toBe("Z");
    expect(signLetter({ meaning: "LETTERS" })).toBeNull();
    const seq = [[0, 0, ...Array(63).fill(0)], [0.1, 0, ...Array(63).fill(0)]];
    const z = { id: "z", meaning: "LETTER Z", kind: "motion" as const, examples: [seq] };
    expect(trackOf(z)).toBe(8);
    expect(trackOf({ ...z, meaning: "LETTER J" })).toBe(20);
    expect(trackOf({ ...z, meaning: "WAVE" })).toBe(0);
    // index tip (landmark 8) moving right by 0.35 canonical units = 1 hand size, while the wrist moves 0.1
    const tipMove = [[0, 0, ...Array(63).fill(0)], [0.1, 0, ...Array(63).fill(0).map((_, i) => (i === 24 ? 0.35 : 0))]];
    expect(trackSequence(tipMove, 8)[1][0]).toBeCloseTo(1.1);
  });
});

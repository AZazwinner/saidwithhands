import { describe, expect, it } from "vitest";
import type { Landmark } from "./features";
import { handSize, normalizeLandmarks } from "./features";
import type { Classifier } from "./letterModel";
import { Recognizer, type RecognizerOutput } from "./recognizer";
import { DEFAULT_HOLD } from "./holdConfirm";

/** Tests are written for a 600 ms hold, independent of the app default. */
const hold = { ...DEFAULT_HOLD, holdMs: 600 };
import {
  buildLibrary,
  handshapeExample,
  handshapeScore,
  motionSequence,
  signThreshold,
  trimToMotion,
  type MotionFrame,
  type TaughtSign,
} from "./signs";
import { synthHand } from "./__fixtures__/synthHand";

/** Fake classifier: "A" for an open hand, "S" for a fist, decided by index-tip height. */
const fake: Classifier = {
  labels: ["A", "S", "B"],
  predict: (f) => {
    const indexTipY = f[8 * 3 + 1];
    return indexTipY < -0.6 ? [0.9, 0.05, 0.05] : [0.05, 0.9, 0.05];
  },
};
/** Fake classifier that never knows: flat distribution. */
const unsure: Classifier = { labels: ["U", "V", "B"], predict: () => [0.4, 0.35, 0.25] };

const open = synthHand();
const fist = synthHand({ curl: [0.8, 1, 1, 1, 1] });

type Seg = {
  lms: Landmark[] | null;
  ms: number;
  dx?: number;
  path?: (u: number) => { x: number; y: number };
};

function run(r: Recognizer, segs: Seg[]) {
  let t = 0;
  const outs: RecognizerOutput[] = [];
  for (const f of segs) {
    const t0 = t;
    for (; t < t0 + f.ms; t += 33) {
      const u = (t - t0) / f.ms;
      const off = f.path ? f.path(u) : { x: (f.dx ?? 0) * (t / 1000), y: 0 };
      const lms = f.lms?.map((p) => ({ ...p, x: p.x + off.x, y: p.y + off.y }));
      outs.push(r.process(lms ? { t, landmarks: lms, hand: "Right" } : null, t));
    }
  }
  return outs;
}
const acceptedOf = (outs: RecognizerOutput[]) => outs.filter((o) => o.accepted).map((o) => o.accepted!.v);

describe("Recognizer: letters", () => {
  it("accepts held letters and ignores the transition between them", () => {
    const r = new Recognizer(fake, { hold });
    expect(
      acceptedOf(
        run(r, [
          { lms: open, ms: 900 },
          { lms: fist, ms: 900 },
        ]),
      ),
    ).toEqual(["A", "S"]);
  });

  it("does not accept while the hand moves fast", () => {
    const r = new Recognizer(fake, { hold });
    expect(acceptedOf(run(r, [{ lms: open, ms: 1500, dx: 1.0 }]))).toEqual([]);
  });

  it("re-arms after the hand leaves the frame (double letters), but never repeats while held", () => {
    const r = new Recognizer(fake, { hold });
    expect(
      acceptedOf(
        run(r, [
          { lms: open, ms: 800 },
          { lms: null, ms: 200 },
          { lms: open, ms: 3000 },
        ]),
      ),
    ).toEqual(["A", "A"]);
  });

  it("treats disabled letters as unknown instead of redistributing them", () => {
    const r = new Recognizer(fake, { hold, enabledLetters: new Set(["S", "B"]) });
    const outs = run(r, [{ lms: open, ms: 900 }]);
    expect(acceptedOf(outs)).toEqual([]);
    expect(outs.at(-1)!.status).toBe("unsure");
  });
});

describe("Recognizer: rearm", () => {
  it("lets a letter that is still being held be accepted again after rearm()", () => {
    const r = new Recognizer(fake, { hold });
    expect(acceptedOf(run(r, [{ lms: open, ms: 1500 }]))).toEqual(["A"]);
    r.rearm();
    const outs: RecognizerOutput[] = [];
    for (let t = 2000; t < 3000; t += 33) outs.push(r.process({ t, landmarks: open, hand: "Right" }, t));
    expect(acceptedOf(outs)).toEqual(["A"]);
  });
});

describe("Recognizer: I don't know", () => {
  it("reports 'unsure' and types nothing when no letter is confident", () => {
    const outs = run(new Recognizer(unsure, { hold }), [{ lms: open, ms: 2000 }]);
    expect(acceptedOf(outs)).toEqual([]);
    expect(outs.at(-1)!.status).toBe("unsure");
  });

  it("reports 'out-of-frame' and types nothing when the hand is cut off", () => {
    const edge = open.map((p) => ({ ...p, y: p.y + 0.3 })); // wrist below the frame
    const outs = run(new Recognizer(fake, { hold }), [{ lms: edge, ms: 1500 }]);
    expect(acceptedOf(outs)).toEqual([]);
    expect(outs.at(-1)!.status).toBe("out-of-frame");
  });

  it("reports 'too-far' for a tiny hand", () => {
    const tiny = synthHand({ size: 0.03 });
    const outs = run(new Recognizer(fake, { hold }), [{ lms: tiny, ms: 1500 }]);
    expect(acceptedOf(outs)).toEqual([]);
    expect(outs.at(-1)!.status).toBe("too-far");
  });

  it("reports 'no-hand' with no hand", () => {
    expect(run(new Recognizer(fake, { hold }), [{ lms: null, ms: 100 }]).at(-1)!.status).toBe("no-hand");
  });
});

describe("Recognizer: taught signs", () => {
  const SIZE = 0.25;
  const circle = (u: number) => ({
    x: (Math.cos(u * 2 * Math.PI) - 1) * SIZE,
    y: Math.sin(u * 2 * Math.PI) * SIZE,
  });
  const swipe = (u: number) => ({ x: 0, y: -2 * u * SIZE });

  /** Teach a motion sign from 5 synthetic performances. */
  function teachMotion(
    meaning: string,
    path: (u: number) => { x: number; y: number },
    lms: Landmark[] = open,
  ): TaughtSign {
    const examples = [0, 1, 2, 3, 4].map((i) => {
      const frames: MotionFrame[] = [];
      for (let t = 0; t < 1400; t += 33) {
        const u = Math.min(1, Math.max(0, (t - 300) / (800 + 50 * i)));
        const o = path(u);
        const w = open[0];
        frames.push({
          t,
          shape: normalizeLandmarks(lms, "Right"),
          wrist: { x: (w.x + o.x) * (4 / 3), y: w.y + o.y, z: 0 },
          size: handSize(lms),
          hand: "Right",
        });
      }
      return motionSequence(trimToMotion(frames));
    });
    return { id: meaning, meaning, kind: "motion", examples };
  }

  const signs = buildLibrary([teachMotion("PLEASE", circle), teachMotion("THANK YOU", swipe)]);

  it("accepts a completed motion sign, and does not type the resting handshape afterwards", () => {
    const r = new Recognizer(fake, { hold, signs });
    const outs = run(r, [
      { lms: open, ms: 400 },
      { lms: open, ms: 900, path: circle },
      { lms: open, ms: 1500 }, // rest after the sign, open hand would be letter "A"
    ]);
    expect(acceptedOf(outs)).toEqual(["PLEASE"]);
    expect(outs.find((o) => o.accepted)!.accepted!.kind).toBe("sign");
  });

  it("replaces a letter typed from a motion sign's starting handshape with the sign", () => {
    // Teach a motion sign that starts from a fist (the fake classifier calls a fist "S").
    const fistSign = teachMotion("THANK YOU", swipe, fist);
    const r = new Recognizer(fake, { hold, signs: buildLibrary([fistSign]) });
    const outs = run(r, [
      { lms: fist, ms: 900 }, // pause in the starting handshape: "S" gets typed
      { lms: fist, ms: 900, path: swipe },
      { lms: fist, ms: 600, path: () => swipe(1) },
    ]);
    const acc = outs.filter((o) => o.accepted).map((o) => o.accepted!);
    expect(acc.map((a) => a.v)).toEqual(["S", "THANK YOU"]);
    expect(acc[1].retracts).toBe("S");
  });

  it("does not replace a letter from a different handshape or typed long before", () => {
    const r = new Recognizer(fake, { hold, signs });
    const outs = run(r, [
      { lms: fist, ms: 900 }, // "S" typed from a fist
      { lms: open, ms: 2500 }, // hand changes to open, waits well over 1.2 s
      { lms: open, ms: 900, path: circle },
      { lms: open, ms: 600 },
    ]);
    const sign = outs.find((o) => o.accepted?.kind === "sign")!.accepted!;
    expect(sign.retracts).toBeUndefined();
  });

  it("finds a motion sign after a false start that flows straight into it (no rest)", () => {
    // Regression: the whole movement (false start + sign) was matched as one and rejected.
    const falseStart = (u: number) => ({ x: 0.7 * u * SIZE, y: 0.2 * u * SIZE });
    const chain = (u: number) => {
      if (u < 0.3) return falseStart(u / 0.3);
      const a = falseStart(1);
      const b = swipe((u - 0.3) / 0.7);
      return { x: a.x + b.x, y: a.y + b.y };
    };
    const r = new Recognizer(fake, { hold, signs });
    const outs = run(r, [
      { lms: open, ms: 400 },
      { lms: open, ms: 1300, path: chain },
      { lms: open, ms: 800, path: () => chain(1) },
    ]);
    expect(acceptedOf(outs).filter((v) => v !== "A")).toEqual(["THANK YOU"]);
  });

  it("recognizes two motion signs made back to back without a rest", () => {
    // Regression: the second sign was swallowed into the first one's movement.
    const chain = (u: number) => {
      if (u < 0.5) return circle(u / 0.5);
      const a = circle(1);
      const b = swipe((u - 0.5) / 0.5);
      return { x: a.x + b.x, y: a.y + b.y };
    };
    const r = new Recognizer(fake, { hold, signs });
    const outs = run(r, [
      { lms: open, ms: 400 },
      { lms: open, ms: 1800, path: chain },
      { lms: open, ms: 800, path: () => chain(1) },
    ]);
    expect(acceptedOf(outs).filter((v) => v !== "A")).toEqual(["PLEASE", "THANK YOU"]);
  });

  it("types the letter for a motion sign named LETTER Z", () => {
    const lib = buildLibrary([teachMotion("LETTER Z", swipe)]); // constant hand shape: fingertip path = wrist path
    const outs = run(new Recognizer(fake, { hold, signs: lib }), [
      { lms: open, ms: 400 },
      { lms: open, ms: 900, path: swipe },
      { lms: open, ms: 800, path: () => swipe(1) },
    ]);
    const acc = outs.find((o) => o.accepted && o.accepted.v !== "A")!.accepted!;
    expect(acc).toMatchObject({ kind: "letter", v: "Z" });
  });

  it("ignores a movement that ends with the hand leaving the view (e.g. lowering the hand)", () => {
    // Regression: lowering the hand after a letter could be taken for a small motion sign like Z.
    const r = new Recognizer(fake, { hold, signs });
    const outs = run(r, [
      { lms: open, ms: 400 },
      { lms: open, ms: 900, path: swipe },
      { lms: null, ms: 600 },
    ]);
    expect(acceptedOf(outs).filter((v) => v !== "A")).toEqual([]);
  });

  it("rejects a movement that matches no taught sign", () => {
    const r = new Recognizer(fake, { hold, signs });
    const zig = (u: number) => ({ x: 2 * u * SIZE, y: Math.abs(((u * 3) % 1) - 0.5) * SIZE });
    const outs = run(r, [
      { lms: open, ms: 400 },
      { lms: open, ms: 900, path: zig },
      { lms: open, ms: 600, path: () => zig(1) }, // rest where the movement ended
    ]);
    expect(acceptedOf(outs).filter((v) => v !== "A")).toEqual([]);
    expect(outs.some((o) => o.motionRejected)).toBe(true);
  });

  it("accepts a held handshape sign as a sign token", () => {
    const shape = normalizeLandmarks(fist, "Right");
    const lib = buildLibrary([
      { id: "x", meaning: "MY MEDICATION", kind: "handshape", examples: [shape, shape.map((v) => v + 0.01)] },
    ]);
    const outs = run(new Recognizer(fake, { hold, signs: lib }), [{ lms: fist, ms: 1000 }]);
    const acc = outs.find((o) => o.accepted)!.accepted!;
    expect(acc).toMatchObject({ kind: "sign", v: "MY MEDICATION" });
    expect(acc.action).toBeUndefined();
  });

  it("marks a sign taught as the Space key with its action", () => {
    const shape = normalizeLandmarks(fist, "Right");
    const lib = buildLibrary([
      { id: "k", meaning: "[SPACE]", kind: "handshape", examples: [shape, shape.map((v) => v + 0.01)], action: "space" },
    ]);
    const outs = run(new Recognizer(fake, { hold, signs: lib }), [{ lms: fist, ms: 1000 }]);
    expect(outs.find((o) => o.accepted)!.accepted).toMatchObject({ kind: "sign", v: "[SPACE]", action: "space" });
  });
});

describe("Recognizer: a repeated handshape sign survives webcam noise", () => {
  // Regression: examples are MEANS of ~48 frames, live frames are single noisy frames. With the old limit
  // (floor 0.18, only the inner 40% of it scoring >= 0.6) a correctly repeated sign was almost never
  // accepted. The numbers here are MediaPipe-like jitter in hand sizes (z twice the xy jitter).
  const SIZE = 0.25;
  const JITTER = 0.007;
  const DRIFT = 0.015;
  const shaka = synthHand({ curl: [0.9, 0, 0, 0, 0.9] });

  function rng(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }
  const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());
  const noisy = (base: Landmark[], drift: number[], r: () => number): Landmark[] =>
    base.map((p, i) => ({
      x: p.x + drift[i * 3] + gauss(r) * JITTER * SIZE,
      y: p.y + drift[i * 3 + 1] + gauss(r) * JITTER * SIZE,
      z: p.z + drift[i * 3 + 2] + gauss(r) * JITTER * 2 * SIZE,
    }));
  const driftOf = (r: () => number) => Array.from({ length: 63 }, () => gauss(r) * DRIFT * SIZE);

  function taught(seed: number): TaughtSign {
    const r = rng(seed);
    const examples = Array.from({ length: 5 }, () => {
      const d = driftOf(r);
      return handshapeExample(Array.from({ length: 48 }, () => normalizeLandmarks(noisy(shaka, d, r), "Right")));
    });
    return { id: "s", meaning: "MY MEDICATION", kind: "handshape", examples };
  }

  function hold(sign: TaughtSign, shape: Landmark[], seed: number) {
    const r = rng(seed);
    const d = driftOf(r);
    const rec = new Recognizer(unsure, { signs: buildLibrary([sign]) });
    const outs: RecognizerOutput[] = [];
    for (let t = 0; t < 3000; t += 33) outs.push(rec.process({ t, landmarks: noisy(shape, d, r), hand: "Right" }, t));
    return acceptedOf(outs);
  }

  it("scores anything inside the limit at 0.6 or more, falling toward the boundary", () => {
    expect(handshapeScore(0)).toBe(1);
    expect(handshapeScore(0.99)).toBeGreaterThanOrEqual(0.6);
    expect(handshapeScore(0.5)).toBeGreaterThan(handshapeScore(0.9));
  });

  it("keeps the limit above single-frame jitter for consistent examples", () => {
    expect(signThreshold(taught(1))).toBeGreaterThanOrEqual(0.28);
  });

  it("accepts the taught shape when it is held again", () => {
    let ok = 0;
    for (let k = 0; k < 10; k++) if (hold(taught(100 + k), shaka, 900 + k).includes("MY MEDICATION")) ok++;
    expect(ok).toBeGreaterThanOrEqual(9);
  });

  /** The taught shape, tilted about the wrist: `roll` in the image plane, `yaw` toward the camera (degrees). */
  const tilted = (roll: number, yaw: number) => {
    const [w] = shaka;
    const [r, y] = [(roll * Math.PI) / 180, (yaw * Math.PI) / 180];
    return shaka.map((p) => {
      let [dx, dy, dz] = [p.x - w.x, p.y - w.y, p.z - w.z];
      [dx, dy] = [dx * Math.cos(r) - dy * Math.sin(r), dx * Math.sin(r) + dy * Math.cos(r)];
      [dx, dz] = [dx * Math.cos(y) - dz * Math.sin(y), dx * Math.sin(y) + dz * Math.cos(y)];
      return { x: w.x + dx, y: w.y + dy, z: w.z + dz };
    });
  };

  it("accepts the taught shape held at a slightly different angle", () => {
    // Regression: canonical landmarks aren't rotation-invariant, so ~10 degrees of tilt was rejected.
    let ok = 0;
    for (const [k, [roll, yaw]] of [[15, 0], [-15, 0], [0, 15], [10, -10], [-12, 8]].entries())
      for (let j = 0; j < 2; j++) if (hold(taught(300 + k * 2 + j), tilted(roll, yaw), 600 + k * 2 + j).length) ok++;
    expect(ok).toBeGreaterThanOrEqual(9);
  });

  it("accepts the taught shape when the tracker mislabels the hand (left/right flicker or always wrong)", () => {
    // Regression: on a hand seen edge-on the tracker's left/right label flickers; each wrong frame mirrored the
    // whole shape, so a flat hand taught as Space was never accepted.
    for (const flicker of [0.3, 1]) {
      let ok = 0;
      for (let k = 0; k < 5; k++) {
        const r = rng(800 + k);
        const d = driftOf(r);
        const rec = new Recognizer(unsure, { signs: buildLibrary([taught(820 + k)]) });
        const outs: RecognizerOutput[] = [];
        for (let t = 0; t < 3000; t += 33)
          outs.push(rec.process({ t, landmarks: noisy(shaka, d, r), hand: r() < flicker ? "Left" : "Right" }, t));
        if (acceptedOf(outs).includes("MY MEDICATION")) ok++;
      }
      expect(ok).toBeGreaterThanOrEqual(4);
    }
  });

  it("still rejects the same shape turned well past the allowance (e.g. upside down)", () => {
    for (const [roll, yaw] of [[90, 0], [180, 0], [-90, 0], [0, 70]])
      for (let k = 0; k < 3; k++) expect(hold(taught(400 + k), tilted(roll, yaw), 700 + k)).toEqual([]);
  });

  it("still rejects clearly different shapes", () => {
    const others = [synthHand(), synthHand({ curl: [0.8, 1, 1, 1, 1] }), synthHand({ curl: [0.6, 0, 0, 1, 1] })];
    for (const [i, shape] of others.entries())
      for (let k = 0; k < 5; k++) expect(hold(taught(200 + k), shape, 500 + i * 10 + k)).toEqual([]);
  });
});

describe("Recognizer: a repeated motion sign survives webcam noise", () => {
  // Regressions (scripts/sim-motion.mts): (1) under a pixel of landmark jitter made a resting fist read
  // ~0.6 hand sizes/s frame to frame, so the movement never "ended" and was dropped; (2) the same sign
  // made a bit bigger than when taught was rejected, because paths were compared in absolute size.
  const SIZE = 0.2;
  const JITTER = 0.007;
  const swipe = (u: number) => ({ x: 0, y: 2 * u * SIZE * 0.8 });
  const diagonal = (u: number) => ({ x: 1.4 * u * SIZE * 0.8, y: 1.4 * u * SIZE * 0.8 });

  function rng(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }
  const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());

  /** Frames of: rest, the movement (scaled), rest. Smooth start and stop, landmark jitter throughout. */
  function perform(path: typeof swipe, scale: number, ms: number, r: () => number) {
    const base = synthHand({ curl: [0.8, 1, 1, 1, 1], size: SIZE, cy: 0.4 });
    const frames: { t: number; landmarks: Landmark[] }[] = [];
    for (let t = 0; t < 400 + ms + 900; t += 33) {
      const lin = Math.min(1, Math.max(0, (t - 400) / ms));
      const o = path(lin * lin * (3 - 2 * lin));
      frames.push({
        t,
        landmarks: base.map((p) => ({
          x: p.x + o.x * scale + gauss(r) * JITTER * SIZE,
          y: p.y + o.y * scale + gauss(r) * JITTER * SIZE,
          z: p.z + gauss(r) * JITTER * 2 * SIZE,
        })),
      });
    }
    return frames;
  }

  function teach(seed: number): TaughtSign {
    const r = rng(seed);
    const examples = [0, 1, 2, 3, 4].map((i) => {
      const rec = new Recognizer(unsure, {});
      const frames: MotionFrame[] = [];
      for (const f of perform(swipe, 1 + 0.04 * (i - 2), 850 + 30 * i, r)) {
        const out = rec.process({ ...f, hand: "Right" }, f.t);
        if (f.t <= 1600) frames.push(out.motionFrame!);
      }
      return motionSequence(trimToMotion(frames));
    });
    return { id: "s", meaning: "THANK YOU", kind: "motion", examples };
  }

  function live(sign: TaughtSign, path: typeof swipe, scale: number, seed: number) {
    const r = rng(seed);
    const rec = new Recognizer(unsure, { signs: buildLibrary([sign]) });
    const outs = perform(path, scale, 1000, r).map((f) => rec.process({ ...f, hand: "Right" }, f.t));
    return { accepted: acceptedOf(outs), matched: outs.some((o) => o.motionBest) };
  }

  it("ends the movement when a jittery hand comes to rest", () => {
    for (let k = 0; k < 5; k++) expect(live(teach(10 + k), swipe, 1, 50 + k).matched).toBe(true);
  });

  it("accepts the sign made 25% bigger or smaller than taught", () => {
    let ok = 0;
    for (let k = 0; k < 10; k++) {
      if (live(teach(20 + k), swipe, 1.25, 60 + k).accepted.includes("THANK YOU")) ok++;
      if (live(teach(30 + k), swipe, 0.8, 70 + k).accepted.includes("THANK YOU")) ok++;
    }
    expect(ok).toBeGreaterThanOrEqual(18);
  });

  it("still rejects the same hand moving in a different direction", () => {
    for (let k = 0; k < 10; k++) expect(live(teach(40 + k), diagonal, 1, 80 + k).accepted).toEqual([]);
  });
});

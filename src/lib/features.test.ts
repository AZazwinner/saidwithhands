import { describe, expect, it } from "vitest";
import {
  FEATURE_DIM,
  euclidean,
  handSize,
  needsFlip,
  normalizeLandmarks,
  realHandFromMediaPipe,
} from "./features";
import { mirrorX, synthHand } from "./__fixtures__/synthHand";

const close = (a: number[], b: number[], eps = 1e-9) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(eps);
};

describe("normalizeLandmarks", () => {
  const hand = synthHand();

  it("returns 63 values with the wrist at the origin", () => {
    const f = normalizeLandmarks(hand, "Right");
    expect(f).toHaveLength(FEATURE_DIM);
    expect(f.slice(0, 3).map(Math.abs)).toEqual([0, 0, 0]);
  });

  it("scales so the farthest landmark from the wrist is at distance 1", () => {
    const f = normalizeLandmarks(hand, "Right");
    let max = 0;
    for (let i = 0; i < 21; i++) max = Math.max(max, Math.hypot(f[i * 3], f[i * 3 + 1], f[i * 3 + 2]));
    expect(max).toBeCloseTo(1, 9);
  });

  it("is invariant to translation and scale", () => {
    const a = normalizeLandmarks(synthHand({ cx: 0.3, cy: 0.4, size: 0.1 }), "Right");
    const b = normalizeLandmarks(synthHand({ cx: 0.7, cy: 0.8, size: 0.35 }), "Right");
    close(a, b);
  });

  it("maps a left hand onto the same canonical features as the mirrored right hand", () => {
    // A left hand seen by the camera is (geometrically) the mirror image of a right hand.
    const right = synthHand({ thumbSide: 1 });
    const left = mirrorX(right);
    close(normalizeLandmarks(right, "Right"), normalizeLandmarks(left, "Left"));
  });

  it("handles mirrored input: a mirrored frame of the right hand needs no flip", () => {
    const raw = synthHand();
    close(normalizeLandmarks(raw, "Right", false), normalizeLandmarks(mirrorX(raw), "Right", true));
  });

  it("keeps different handshapes apart", () => {
    const open = normalizeLandmarks(synthHand(), "Right");
    const fist = normalizeLandmarks(synthHand({ curl: [0.8, 1, 1, 1, 1] }), "Right");
    expect(euclidean(open, fist)).toBeGreaterThan(0.5);
  });

  it("does not divide by zero for a degenerate hand", () => {
    const flat = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    expect(normalizeLandmarks(flat, "Right").every((v) => v === 0)).toBe(true);
  });

  it("rejects the wrong number of landmarks", () => {
    expect(() => normalizeLandmarks(hand.slice(0, 20), "Right")).toThrow(/21/);
  });
});

describe("handedness helpers", () => {
  it("keeps MediaPipe labels for raw webcam frames, swaps them for mirrored input (measured)", () => {
    expect(realHandFromMediaPipe("Right", false)).toBe("Right");
    expect(realHandFromMediaPipe("Left", false)).toBe("Left");
    expect(realHandFromMediaPipe("Right", true)).toBe("Left");
  });

  it("flips exactly when the hand is not already a mirrored right hand", () => {
    expect(needsFlip("Right", false)).toBe(true);
    expect(needsFlip("Left", false)).toBe(false);
    expect(needsFlip("Right", true)).toBe(false);
    expect(needsFlip("Left", true)).toBe(true);
  });

  it("handSize is the max wrist distance", () => {
    expect(handSize(synthHand({ size: 0.2 }))).toBeCloseTo(2 * handSize(synthHand({ size: 0.1 })), 9);
  });
});

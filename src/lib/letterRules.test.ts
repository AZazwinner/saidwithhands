import { describe, expect, it } from "vitest";
import { extractGeometry, geometryVector, rollFromImage, VECTOR_KEYS } from "./handGeometry";
import { applyPlausibility, refineWithRules, ruleScore } from "./letterRules";
import { fistThumbSide, fistWithThumbAt, handG, handH } from "./__fixtures__/geoHands";

const SIDEWAYS = Math.PI / 2;
const UPRIGHT = 0;

describe("handGeometry", () => {
  it("measures finger extension: straight ~1, curled low", () => {
    const g = extractGeometry(handG(), SIDEWAYS);
    expect(g.ext_i).toBeGreaterThan(0.9);
    expect(g.ext_m).toBeLessThan(0.3);
    expect(extractGeometry(handH(), SIDEWAYS).ext_m).toBeGreaterThan(0.9);
  });

  it("places the thumb tip along the knuckle line (t_along)", () => {
    for (const t of [0.15, 0.5, 0.8]) {
      expect(extractGeometry(fistWithThumbAt(t), UPRIGHT).t_along).toBeCloseTo(t, 1);
    }
  });

  it("is invariant to mirroring (left vs right hand)", () => {
    const right = fistWithThumbAt(0.5);
    const left = right.map((p) => ({ ...p, x: -p.x }));
    const a = geometryVector(extractGeometry(right, UPRIGHT));
    const b = geometryVector(extractGeometry(left, UPRIGHT));
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));
  });

  it("produces a finite vector of the expected length", () => {
    const vec = geometryVector(extractGeometry(handH(), SIDEWAYS));
    expect(vec).toHaveLength(VECTOR_KEYS.length);
    expect(vec.every(Number.isFinite)).toBe(true);
  });

  it("computes roll from image landmarks (0 = up, pi/2 = pointing right)", () => {
    const img = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    img[9] = { x: 0.5, y: 0.3, z: 0 };
    expect(rollFromImage(img)).toBeCloseTo(0, 6);
    img[9] = { x: 0.7, y: 0.5, z: 0 };
    expect(rollFromImage(img)).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe("letter rules", () => {
  const best = (letters: string[], geo: ReturnType<typeof extractGeometry>) =>
    letters.map((l) => [l, ruleScore(l, geo)] as const).sort((a, b) => b[1] - a[1])[0][0];
  const FIST = ["A", "S", "T", "N", "M", "E"];

  it("separates T / N / M by where the thumb tucks", () => {
    expect(best(FIST, extractGeometry(fistWithThumbAt(0.18), UPRIGHT))).toBe("T");
    expect(best(FIST, extractGeometry(fistWithThumbAt(0.5, -0.3, -1.0), UPRIGHT))).toBe("N");
    expect(best(FIST, extractGeometry(fistWithThumbAt(0.8, -0.3, -1.0), UPRIGHT))).toBe("M");
  });

  it("recognizes A (thumb along the side) vs T", () => {
    expect(best(FIST, extractGeometry(fistThumbSide(), UPRIGHT))).toBe("A");
  });

  it("separates G (one finger) from H (two fingers)", () => {
    expect(best(["G", "H"], extractGeometry(handG(), SIDEWAYS))).toBe("G");
    expect(best(["G", "H"], extractGeometry(handH(), SIDEWAYS))).toBe("H");
  });
});

describe("refineWithRules", () => {
  const labels = ["A", "B", "G", "H", "M", "N", "S", "T"];

  it("flips a G/H confusion toward the geometry, preserving group mass", () => {
    const probs = [0, 0.1, 0.5, 0.4, 0, 0, 0, 0];
    const out = refineWithRules(labels, probs, extractGeometry(handH(), SIDEWAYS));
    expect(out[3]).toBeGreaterThan(out[2]);
    expect(out[2] + out[3]).toBeCloseTo(0.9, 9);
    expect(out[1]).toBe(0.1);
  });

  it("does not re-rank the fist letters (hidden-thumb guesses were wrong on real recordings)", () => {
    const probs = [0, 0, 0, 0, 0.35, 0.55, 0.05, 0.05];
    expect(
      refineWithRules(labels, probs, extractGeometry(fistWithThumbAt(0.8, -0.3, -1.0), UPRIGHT)),
    ).toEqual(probs);
  });

  it("leaves probabilities alone when the top letter is outside every group", () => {
    const probs = [0.05, 0.8, 0.05, 0.05, 0, 0, 0, 0.05];
    expect(refineWithRules(labels, probs, extractGeometry(handH(), SIDEWAYS))).toEqual(probs);
  });
});

describe("applyPlausibility (I-don't-know)", () => {
  const labels = ["A", "G", "H", "T"];

  it("cuts confidence when the geometry contradicts the letter (fist read as G)", () => {
    const out = applyPlausibility(labels, [0, 1, 0, 0], extractGeometry(fistWithThumbAt(0.18), SIDEWAYS));
    expect(out[1]).toBeLessThanOrEqual(0.4); // below the 0.6 accept threshold
  });

  it("keeps confidence when the geometry agrees", () => {
    const out = applyPlausibility(labels, [0, 0.95, 0.05, 0], extractGeometry(handG(), SIDEWAYS));
    expect(out[1]).toBeCloseTo(0.95, 9);
  });

  it("does not veto a real G for orientation or thumb details (pointing forward, loosely curled fingers)", () => {
    const g = extractGeometry(handG(), UPRIGHT); // not sideways
    expect(
      applyPlausibility(labels, [0, 0.9, 0.1, 0], { ...g, ext_m: 0.6, ext_r: 0.55, ang_ti: 80 })[1],
    ).toBeCloseTo(0.9, 9);
  });

  it("never renormalizes (removed mass = unknown)", () => {
    const out = applyPlausibility(labels, [0.25, 0.25, 0.25, 0.25], extractGeometry(handG(), SIDEWAYS));
    expect(out.reduce((a, b) => a + b, 0)).toBeLessThan(1);
  });
});

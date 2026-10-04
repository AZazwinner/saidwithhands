import { describe, expect, it } from "vitest";
import {
  EMPTY_CALIBRATION,
  addSamples,
  buildKnn,
  calibratedLetters,
  clearLetter,
  isCalibrationSet,
  refineWithCalibration,
} from "./calibration";

/** Deterministic jittered cluster around a center. */
function cluster(center: number[], n: number, jitter = 0.02, seed = 1): number[][] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  return Array.from({ length: n }, () => center.map((c) => c + rnd() * jitter));
}

const M = [1, 0, 0, 0];
const N = [0.8, 0.2, 0, 0];
const set = addSamples(addSamples(EMPTY_CALIBRATION, "M", cluster(M, 10)), "N", cluster(N, 10, 0.02, 7));

describe("calibration set", () => {
  it("tracks letters with enough samples", () => {
    expect(calibratedLetters(set).sort()).toEqual(["M", "N"]);
    expect(calibratedLetters(addSamples(set, "T", cluster(M, 2)))).not.toContain("T");
    expect(calibratedLetters(clearLetter(set, "M"))).toEqual(["N"]);
  });

  it("validates imported JSON", () => {
    expect(isCalibrationSet(set)).toBe(true);
    expect(isCalibrationSet({ version: 1, samples: { A: [[1, "x"]] } })).toBe(false);
    expect(isCalibrationSet(null)).toBe(false);
  });

  it("works with a single calibrated letter, but only very close to its samples", () => {
    expect(buildKnn(EMPTY_CALIBRATION)).toBeNull();
    const one = buildKnn(clearLetter(set, "M"))!;
    expect(one.letters).toEqual(["N"]);
    const model = [0.1, 0.8, 0.1]; // A, M, N
    expect(refineWithCalibration(["A", "M", "N"], model, [0.8, 0.2, 0, 0], one)[2]).toBeGreaterThan(0.5);
    expect(refineWithCalibration(["A", "M", "N"], model, [0, 1, 1, 0], one)).toEqual(model);
  });
});

describe("k-NN refinement", () => {
  const knn = buildKnn(set)!;
  const labels = ["A", "M", "N"];

  it("classifies samples near each cluster", () => {
    expect(knn.classify([0.99, 0.01, 0, 0]).probs.M).toBeGreaterThan(0.8);
    expect(knn.classify([0.81, 0.19, 0, 0]).probs.N).toBeGreaterThan(0.8);
  });

  it("overrides a model confusion when the hand matches a recorded sample", () => {
    const model = [0.05, 0.3, 0.65]; // model says N
    const out = refineWithCalibration(labels, model, [0.99, 0.01, 0, 0], knn); // hand looks like M
    expect(out[1]).toBeGreaterThan(out[2]);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("still applies to a fresh attempt that differs more than frame-to-frame jitter (real M/N bug)", () => {
    const tight = addSamples(
      addSamples(EMPTY_CALIBRATION, "M", cluster(M, 30, 0.003)),
      "N",
      cluster(N, 30, 0.003, 7),
    );
    const k = buildKnn(tight)!;
    const model = [0.05, 0.1, 0.85]; // model says N
    const out = refineWithCalibration(labels, model, [0.95, 0.03, 0.02, 0.01], k); // a new M, 0.05 away
    expect(out[1]).toBeGreaterThan(out[2]);
  });

  it("does not interfere with hands far from every recorded sample", () => {
    const model = [0.9, 0.05, 0.05];
    expect(refineWithCalibration(labels, model, [0, 0, 1, 1], knn)).toEqual(model);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMlp, topK, type MlpJson } from "./letterModel";

const model = JSON.parse(readFileSync("public/models/letter-mlp.json", "utf8")) as MlpJson;
const fixture = JSON.parse(readFileSync("src/lib/__fixtures__/letter-mlp-fixture.json", "utf8")) as {
  inputs: number[][];
  outputs: number[][];
};

describe("letter MLP", () => {
  const mlp = createMlp(model);

  it("has 24 static letters (no J, Z)", () => {
    expect(mlp.labels).toHaveLength(24);
    expect(mlp.labels).not.toContain("J");
    expect(mlp.labels).not.toContain("Z");
  });

  it("matches the original Keras model output (Python reference fixture)", () => {
    fixture.inputs.forEach((x, n) => {
      const p = mlp.predict(x);
      p.forEach((v, i) => expect(Math.abs(v - fixture.outputs[n][i])).toBeLessThan(1e-4));
    });
  });

  it("outputs a probability distribution", () => {
    const p = mlp.predict(fixture.inputs[0]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(p.every((v) => v >= 0)).toBe(true);
  });

  it("rejects wrong input size", () => {
    expect(() => mlp.predict([1, 2, 3])).toThrow();
  });
});

describe("topK", () => {
  it("sorts descending and truncates", () => {
    expect(topK(["A", "B", "C", "D"], [0.1, 0.5, 0.3, 0.1], 2)).toEqual([
      { v: "B", p: 0.5 },
      { v: "C", p: 0.3 },
    ]);
  });
});

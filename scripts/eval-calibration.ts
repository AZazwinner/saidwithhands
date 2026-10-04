/**
 * How well does the letter pipeline work for ONE signer, with and without their calibration?
 *
 *   npx tsx scripts/eval-calibration.ts data/letters/<file>.json
 *
 * Calibration is trained on the first half of each letter's recording and tested on the second half
 * (temporal split, a gap of 10 frames). Same session, so it's optimistic: a real second session or
 * a different person will score lower. Use analyze-letters.ts with 2+ signers for that.
 */
import { readFileSync } from "node:fs";
import { normalizeLandmarks } from "../src/lib/features";
import { createMlp, type MlpJson } from "../src/lib/letterModel";
import { extractGeometry, geometryVector, rollFromImage } from "../src/lib/handGeometry";
import { applyPlausibility, refineWithRules } from "../src/lib/letterRules";
import { addSamples, buildKnn, EMPTY_CALIBRATION, refineWithCalibration } from "../src/lib/calibration";
import { isLetterDataset, unflatten, withCorrectHands } from "../src/lib/letterData";

const raw = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!isLetterDataset(raw)) throw new Error("not a letter dataset");
const d = withCorrectHands(raw);
const mlp = createMlp(JSON.parse(readFileSync("public/models/letter-mlp.json", "utf8")) as MlpJson);
const labels = mlp.labels;
const GAP = 10;

type Row = { label: string; probs: number[]; geoVec: number[] };
const byLetter = new Map<string, Row[]>();
for (const s of d.samples) {
  const lm = unflatten(s.lm);
  const geo = extractGeometry(unflatten(s.world), rollFromImage(lm, s.aspect));
  let p = mlp.predict(normalizeLandmarks(lm, s.hand));
  p = applyPlausibility(labels, refineWithRules(labels, p, geo), geo);
  const rows = byLetter.get(s.label) ?? [];
  rows.push({ label: s.label, probs: p, geoVec: geometryVector(geo) });
  byLetter.set(s.label, rows);
}

let calib = EMPTY_CALIBRATION;
const test: Row[] = [];
for (const [l, rows] of byLetter) {
  const half = Math.floor(rows.length / 2);
  calib = addSamples(
    calib,
    l,
    rows.slice(0, half).map((r) => r.geoVec),
  );
  test.push(...rows.slice(half + GAP));
}
const knn = buildKnn(calib)!;
console.log(`k-NN scale (letter separation): ${knn.scale.toFixed(3)}`);

const top = (p: number[]) => labels[p.indexOf(Math.max(...p))];
const variants: Record<string, (r: Row) => number[]> = {
  "model + rules (no calibration)": (r) => r.probs,
  "+ your calibration": (r) => refineWithCalibration(labels, r.probs, r.geoVec, knn),
};
for (const [name, f] of Object.entries(variants)) {
  const per = new Map<string, [number, number, string[]]>();
  let ok = 0;
  for (const r of test) {
    const pred = top(f(r));
    const e = per.get(r.label) ?? [0, 0, []];
    e[1]++;
    if (pred === r.label) {
      e[0]++;
      ok++;
    } else e[2].push(pred);
    per.set(r.label, e);
  }
  console.log(`\n${name}: ${Math.round((100 * ok) / test.length)}% of ${test.length} held-out frames`);
  const weak = [...per.entries()]
    .filter(([, [a, n]]) => a / n < 0.9)
    .map(([l, [a, n, w]]) => {
      const counts = new Map<string, number>();
      w.forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1));
      const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      return `${l} ${Math.round((100 * a) / n)}%${worst ? ` (→${worst[0]})` : ""}`;
    });
  console.log(`  below 90%: ${weak.join(", ") || "none"}`);
}

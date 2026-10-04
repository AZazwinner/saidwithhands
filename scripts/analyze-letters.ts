/**
 * Offline letter analysis on recorded datasets (export from /calibrate → "Export recordings").
 *
 *   npx tsx scripts/analyze-letters.ts data/letters/*.json
 *
 * For every frame it runs each pipeline stage and reports per-stage accuracy, per-letter accuracy,
 * top confusions, and the geometry measurements behind the rules, so we can see exactly which layer
 * breaks which letter instead of guessing. With 2+ signers it also evaluates the team-seed k-NN
 * leave-one-signer-out (the honest number for a new person).
 */
import { readFileSync } from "node:fs";
import { normalizeLandmarks } from "../src/lib/features";
import { createMlp, type MlpJson } from "../src/lib/letterModel";
import { extractGeometry, geometryVector, rollFromImage } from "../src/lib/handGeometry";
import { applyPlausibility, refineWithRules, fingerContradictions } from "../src/lib/letterRules";
import { buildKnn, refineWithCalibration } from "../src/lib/calibration";
import {
  datasetsToCalibration,
  isLetterDataset,
  withCorrectHands,
  unflatten,
  type LetterDataset,
} from "../src/lib/letterData";
import { DEFAULT_HOLD } from "../src/lib/holdConfirm";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: npx tsx scripts/analyze-letters.ts <dataset.json> [...]");
  process.exit(1);
}
const datasets: LetterDataset[] = files.map((f) => {
  const d = JSON.parse(readFileSync(f, "utf8"));
  if (!isLetterDataset(d)) throw new Error(`${f}: not a letter dataset`);
  return withCorrectHands(d);
});
const mlp = createMlp(JSON.parse(readFileSync("public/models/letter-mlp.json", "utf8")) as MlpJson);
const labels = mlp.labels;
const argmax = (p: number[]) => p.reduce((b, v, i) => (v > p[b] ? i : b), 0);

type Stage = "mlp" | "rules" | "plausible" | "seedKnn";
const stages: Stage[] = ["mlp", "rules", "plausible"];
const signers = [...new Set(datasets.map((d) => d.signer))];
if (signers.length > 1) stages.push("seedKnn");

const confusion: Record<Stage, Map<string, Map<string, number>>> = {
  mlp: new Map(),
  rules: new Map(),
  plausible: new Map(),
  seedKnn: new Map(),
};
const bump = (st: Stage, truth: string, pred: string) => {
  const row = confusion[st].get(truth) ?? new Map<string, number>();
  row.set(pred, (row.get(pred) ?? 0) + 1);
  confusion[st].set(truth, row);
};
const decisions = { correct: 0, wrong: 0, unsure: 0 };
const geoStats = new Map<string, { n: number; sums: Record<string, number>; contra: number }>();
const GEO_KEYS = ["ext_i", "ext_m", "ext_r", "ext_p", "t_along", "t_pc", "side", "up", "ang_ti"];

// Seed k-NN per held-out signer
const knnFor = new Map<string, ReturnType<typeof buildKnn>>();
if (signers.length > 1) {
  for (const s of signers)
    knnFor.set(s, buildKnn(datasetsToCalibration(datasets.filter((d) => d.signer !== s))));
}

for (const d of datasets) {
  for (const s of d.samples) {
    const lm = unflatten(s.lm);
    const world = unflatten(s.world);
    const geo = extractGeometry(world, rollFromImage(lm, s.aspect));
    let p = mlp.predict(normalizeLandmarks(lm, s.hand));
    bump("mlp", s.label, labels[argmax(p)]);
    p = refineWithRules(labels, p, geo);
    bump("rules", s.label, labels[argmax(p)]);
    p = applyPlausibility(labels, p, geo);
    bump("plausible", s.label, labels[argmax(p)]);

    // single-frame accept decision (threshold + margin with ambiguous sets), as hold-to-confirm would
    const order = p.map((v, i) => ({ v: labels[i], p: v })).sort((a, b) => b.p - a.p);
    const set = DEFAULT_HOLD.ambiguous.find((g) => g.includes(order[0].v));
    const inSet = (v: string) => (set ? set.includes(v) : v === order[0].v);
    const mass = order.filter((c) => inSet(c.v)).reduce((a, c) => a + c.p, 0);
    const rival = order.find((c) => !inSet(c.v))?.p ?? 0;
    if (mass >= DEFAULT_HOLD.threshold && mass - rival >= DEFAULT_HOLD.margin) {
      if (inSet(s.label)) decisions.correct++;
      else decisions.wrong++;
    } else decisions.unsure++;

    const knn = knnFor.get(d.signer);
    if (knn) {
      const pk = refineWithCalibration(labels, p, geometryVector(geo), knn);
      bump("seedKnn", s.label, labels[argmax(pk)]);
    }

    const g = geoStats.get(s.label) ?? { n: 0, sums: {}, contra: 0 };
    g.n++;
    for (const k of GEO_KEYS) g.sums[k] = (g.sums[k] ?? 0) + geo[k];
    g.contra += fingerContradictions(s.label, geo) > 0 ? 1 : 0;
    geoStats.set(s.label, g);
  }
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
console.log(
  `\nDatasets: ${datasets.map((d) => `${d.signer}/${d.lighting} (${d.samples.length})`).join(", ")}`,
);

console.log("\n== Accuracy per stage (single frames) ==");
for (const st of stages) {
  let ok = 0;
  let n = 0;
  for (const [truth, row] of confusion[st]) {
    for (const [pred, c] of row) {
      n += c;
      if (truth === pred) ok += c;
    }
  }
  console.log(`${st.padEnd(10)} ${pct(ok, n)} of ${n}`);
}
const nDec = decisions.correct + decisions.wrong + decisions.unsure;
console.log(
  `\nAccept decision: correct ${pct(decisions.correct, nDec)}, WRONG ${pct(decisions.wrong, nDec)}, unsure ${pct(decisions.unsure, nDec)}`,
);

const last = stages[stages.length - 1];
console.log(`\n== Per letter (${stages.join(" → ")}) and top confusion at '${last}' ==`);
for (const l of labels) {
  const cells = stages.map((st) => {
    const row = confusion[st].get(l);
    if (!row) return "  -  ";
    const n = [...row.values()].reduce((a, b) => a + b, 0);
    return pct(row.get(l) ?? 0, n).padStart(5);
  });
  const row = confusion[last].get(l);
  const wrong = row
    ? [...row.entries()]
        .filter(([p]) => p !== l)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([p, c]) => `${p}×${c}`)
        .join(" ")
    : "";
  console.log(`${l}  ${cells.join(" ")}   ${wrong}`);
}

console.log("\n== Geometry means per letter (what the rules see) ==");
console.log(`L  ${GEO_KEYS.map((k) => k.padStart(8)).join("")}  contradicted`);
for (const l of labels) {
  const g = geoStats.get(l);
  if (!g) continue;
  console.log(
    `${l}  ${GEO_KEYS.map((k) => (g.sums[k] / g.n).toFixed(2).padStart(8)).join("")}  ${pct(g.contra, g.n)}`,
  );
}

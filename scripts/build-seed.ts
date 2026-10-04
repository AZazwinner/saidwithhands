/**
 * Build the built-in letter seed (team recordings → geometry vectors per letter) used as a k-NN prior.
 *
 *   npx tsx scripts/build-seed.ts data/letters/*.json
 *
 * Writes public/models/letter-seed.json. Frames are subsampled to keep the file small.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { datasetsToCalibration, isLetterDataset, withCorrectHands } from "../src/lib/letterData";

const MAX_PER_LETTER = 120;
const files = process.argv.slice(2);
const datasets = files.map((f) => {
  const d = JSON.parse(readFileSync(f, "utf8"));
  if (!isLetterDataset(d)) throw new Error(`${f}: not a letter dataset`);
  return withCorrectHands(d);
});
const set = datasetsToCalibration(datasets);
for (const [l, vecs] of Object.entries(set.samples)) {
  const step = Math.max(1, Math.ceil(vecs.length / MAX_PER_LETTER));
  set.samples[l] = vecs.filter((_, i) => i % step === 0).map((v) => v.map((x) => Math.round(x * 1e4) / 1e4));
}
const signers = [...new Set(datasets.map((d) => d.signer))];
writeFileSync(
  "public/models/letter-seed.json",
  JSON.stringify({ ...set, signers, builtAt: new Date().toISOString() }),
);
console.log(
  `letter-seed.json: ${signers.length} signer(s), ` +
    Object.entries(set.samples)
      .map(([l, v]) => `${l}:${v.length}`)
      .join(" "),
);

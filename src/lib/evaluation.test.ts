import { describe, expect, it } from "vitest";
import {
  LETTER_LIST,
  NOTHING,
  confusionMatrix,
  isTrialArray,
  summarize,
  toCsv,
  wordRecall,
  type Trial,
} from "./evaluation";

let n = 0;
const T = (p: Partial<Trial>): Trial => ({
  id: String(n++),
  session: "s1",
  signer: "Ana",
  unseen: true,
  lighting: "normal",
  kind: "letter",
  target: "A",
  recognized: "A",
  at: "2026-10-03T00:00:00Z",
  ...p,
});

describe("LETTER_LIST", () => {
  it("has the 24 static letters once each, no J/Z", () => {
    expect(new Set(LETTER_LIST).size).toBe(24);
    expect(LETTER_LIST).not.toContain("J");
    expect(LETTER_LIST).not.toContain("Z");
  });
});

describe("wordRecall", () => {
  it("ignores extra glue words and punctuation", () => {
    expect(wordRecall("my name", "What is my name?")).toBe(1);
    expect(wordRecall("my name", "ny name")).toBe(0.5);
    expect(wordRecall("help", "")).toBe(0);
  });
  it("requires order", () => {
    expect(wordRecall("my name", "name my")).toBe(0.5);
  });
});

describe("summarize + confusion", () => {
  const trials = [
    T({ target: "M", recognized: "N" }),
    T({ target: "M", recognized: "M" }),
    T({ target: "N", recognized: "N" }),
    T({ target: "G", recognized: null }),
    T({ kind: "sign", target: "THANK YOU", recognized: "THANK YOU" }),
    T({ kind: "sign", target: "PLEASE", recognized: null }),
    T({
      kind: "phrase",
      target: "MY NAME",
      recognized: null,
      raw: "ny name",
      bestGuess: "My name.",
      bestGuessOk: true,
    }),
    T({
      kind: "phrase",
      target: "HELP",
      recognized: null,
      raw: "help",
      bestGuess: "Help.",
      bestGuessOk: true,
    }),
    T({ signer: "Bo", unseen: false, target: "A", recognized: "A" }),
  ];
  const s = summarize(trials);

  it("counts letters, signs and phrases", () => {
    expect(s.letters).toMatchObject({ n: 5, correct: 3, nothing: 1 });
    expect(s.signs).toEqual({ n: 2, correct: 1, nothing: 1, wrong: 0 });
    expect(s.phrases).toMatchObject({ n: 2, rawExact: 1, bestExact: 2, rawRecall: 0.75, bestRecall: 1 });
    expect(s.signers).toEqual(["Ana", "Bo"]);
    expect(s.unseenSigners).toEqual(["Ana"]);
  });

  it("builds a confusion matrix with a 'nothing recognized' column", () => {
    const c = confusionMatrix(trials);
    expect(c.rows).toEqual(["M", "A", "G", "N"].filter((l) => c.rows.includes(l)));
    expect(c.cols).toContain(NOTHING);
    const m = c.rows.indexOf("M");
    expect(c.counts[m][c.cols.indexOf("N")]).toBe(1);
    expect(c.counts[m][c.cols.indexOf("M")]).toBe(1);
  });

  it("exports CSV with escaping and validates imports", () => {
    const csv = toCsv([T({ kind: "phrase", target: "HI", raw: 'say "hi", ok', recognized: null })]);
    expect(csv.split("\n")[1]).toContain('"say ""hi"", ok"');
    expect(isTrialArray(trials)).toBe(true);
    expect(isTrialArray([{ signer: 1 }])).toBe(false);
  });
});

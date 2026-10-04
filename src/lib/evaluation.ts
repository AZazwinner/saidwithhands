/**
 * /evaluate bookkeeping (pure): trials, summaries, confusion matrix, phrase scoring.
 * A small, informal test (a few signers who didn't record training/calibration data), not a study.
 */
import type { Lighting } from "./letterData";

export type TrialKind = "letter" | "sign" | "phrase";

export type Trial = {
  id: string;
  /** one sitting of one signer */
  session: string;
  signer: string;
  /** signer did not record calibration/seed data (the honest "new user" condition) */
  unseen: boolean;
  lighting: Lighting;
  /** the signer's own calibration was ON (they calibrated before the test) */
  calibrated?: boolean;
  kind: TrialKind;
  target: string;
  /** letter/sign: first accepted token, or null if nothing was recognized in time */
  recognized: string | null;
  /** phrase: recognizer top-1 text */
  raw?: string;
  /** phrase: best-guess sentence (or the raw fallback) */
  bestGuess?: string;
  /** phrase: whether Gemini answered (false = fallback was used) */
  bestGuessOk?: boolean;
  at: string;
};

/** Fixed letter list (all 24 static letters, fixed shuffled order so every signer gets the same). */
export const LETTER_LIST = "MAGNTHSEOBRUYICVDLKWFPQX".split("");
/** Fixed phrase list for the use case; fingerspellable without J/Z. */
export const DEFAULT_PHRASES = ["HI", "HELP", "WATER", "MY NAME", "PHARMACY"];
export const NOTHING = "∅";

export const normalizeText = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Fraction of the target's words found in the output, in order (extra words like "is", "the" in a
 * best-guess sentence don't count against it). 1 = every target word present.
 */
export function wordRecall(target: string, output: string): number {
  const t = normalizeText(target).split(" ").filter(Boolean);
  const o = normalizeText(output).split(" ").filter(Boolean);
  if (t.length === 0) return 1;
  let j = 0;
  let hit = 0;
  for (const w of t) {
    const k = o.indexOf(w, j);
    if (k >= 0) {
      hit++;
      j = k + 1;
    }
  }
  return hit / t.length;
}

export type Confusion = { rows: string[]; cols: string[]; counts: number[][] };

export function confusionMatrix(trials: readonly Trial[]): Confusion {
  const letters = trials.filter((t) => t.kind === "letter");
  const rows = LETTER_LIST.filter((l) => letters.some((t) => t.target === l));
  const predicted = new Set(letters.map((t) => t.recognized ?? NOTHING));
  const cols = [...rows, ...[...predicted].filter((p) => !rows.includes(p)).sort()];
  const counts = rows.map(() => cols.map(() => 0));
  for (const t of letters) {
    const r = rows.indexOf(t.target);
    const c = cols.indexOf(t.recognized ?? NOTHING);
    if (r >= 0 && c >= 0) counts[r][c]++;
  }
  return { rows, cols, counts };
}

export type Summary = {
  signers: string[];
  unseenSigners: string[];
  letters: {
    n: number;
    correct: number;
    nothing: number;
    perLetter: { letter: string; n: number; correct: number }[];
  };
  signs: { n: number; correct: number; nothing: number; wrong: number };
  phrases: {
    n: number;
    rawExact: number;
    bestExact: number;
    rawRecall: number;
    bestRecall: number;
    geminiAnswered: number;
  };
};

export function summarize(trials: readonly Trial[]): Summary {
  const letters = trials.filter((t) => t.kind === "letter");
  const signs = trials.filter((t) => t.kind === "sign");
  const phrases = trials.filter((t) => t.kind === "phrase");
  const perLetter = LETTER_LIST.map((letter) => {
    const ts = letters.filter((t) => t.target === letter);
    return { letter, n: ts.length, correct: ts.filter((t) => t.recognized === t.target).length };
  }).filter((x) => x.n > 0);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const rawR = phrases.map((t) => wordRecall(t.target, t.raw ?? ""));
  const bestR = phrases.map((t) => wordRecall(t.target, t.bestGuess ?? ""));
  return {
    signers: [...new Set(trials.map((t) => t.signer))],
    unseenSigners: [...new Set(trials.filter((t) => t.unseen).map((t) => t.signer))],
    letters: {
      n: letters.length,
      correct: letters.filter((t) => t.recognized === t.target).length,
      nothing: letters.filter((t) => t.recognized === null).length,
      perLetter,
    },
    signs: {
      n: signs.length,
      correct: signs.filter((t) => t.recognized === t.target).length,
      nothing: signs.filter((t) => t.recognized === null).length,
      wrong: signs.filter((t) => t.recognized !== null && t.recognized !== t.target).length,
    },
    phrases: {
      n: phrases.length,
      rawExact: rawR.filter((r) => r === 1).length,
      bestExact: bestR.filter((r) => r === 1).length,
      rawRecall: mean(rawR),
      bestRecall: mean(bestR),
      geminiAnswered: phrases.filter((t) => t.bestGuessOk).length,
    },
  };
}

export function toCsv(trials: readonly Trial[]): string {
  const cols: (keyof Trial)[] = [
    "at",
    "session",
    "signer",
    "unseen",
    "lighting",
    "kind",
    "target",
    "recognized",
    "raw",
    "bestGuess",
    "bestGuessOk",
  ];
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...trials.map((t) => cols.map((c) => esc(t[c])).join(","))].join("\n");
}

export function isTrialArray(x: unknown): x is Trial[] {
  return (
    Array.isArray(x) &&
    x.every(
      (t) =>
        t &&
        typeof t.signer === "string" &&
        typeof t.target === "string" &&
        ["letter", "sign", "phrase"].includes(t.kind) &&
        (t.recognized === null || typeof t.recognized === "string" || t.kind === "phrase"),
    )
  );
}

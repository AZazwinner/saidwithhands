"use client";

import { DEFAULT_HOLD } from "./holdConfirm";
import { EMPTY_CALIBRATION, isCalibrationSet, type CalibrationSet } from "./calibration";
import { loadBig, loadJson, saveBig, saveJson } from "./storage";
import { isSignLibraryJson, type SignLibraryJson, type TaughtSign } from "./signs";
import type { LetterSample, Lighting } from "./letterData";

export type Settings = {
  swapHands: boolean;
  letters: string;
  holdMs: number;
  threshold: number;
  useRules: boolean;
  useCalibration: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  swapHands: false,
  letters: "",
  holdMs: DEFAULT_HOLD.holdMs,
  threshold: DEFAULT_HOLD.threshold,
  useRules: true,
  useCalibration: true,
};

const SETTINGS_KEY = "signnote.settings.v1";
const CALIBRATION_KEY = "signnote.calibration.v1";

export const loadSettings = (): Settings => ({
  ...DEFAULT_SETTINGS,
  ...loadJson<Partial<Settings>>(SETTINGS_KEY, {}),
});
export const saveSettings = (s: Settings) => saveJson(SETTINGS_KEY, s);

// Calibration, taught signs and letter recordings are big (megabytes): they live in IndexedDB.
export async function loadCalibration(): Promise<CalibrationSet> {
  const c = await loadBig<unknown>(CALIBRATION_KEY);
  return isCalibrationSet(c) ? c : EMPTY_CALIBRATION;
}
export const saveCalibration = (c: CalibrationSet) => saveBig(CALIBRATION_KEY, c);

/** Letters filter string -> set (null = all). */
export function parseLetters(s: string): Set<string> | null {
  const letters = s.toUpperCase().replace(/[^A-Z]/g, "");
  return letters ? new Set(letters.split("")) : null;
}

// ---- taught signs ----
const SIGNS_KEY = "signnote.signs.v1";

/** Saved signs, or null if this browser has never saved any (then the starter set is offered). */
export async function loadSigns(): Promise<TaughtSign[] | null> {
  const s = await loadBig<unknown>(SIGNS_KEY);
  return isSignLibraryJson(s) ? s.signs : null;
}
export const saveSigns = (signs: TaughtSign[]) =>
  saveBig(SIGNS_KEY, { version: 1, signs } satisfies SignLibraryJson);

export async function fetchStarterSigns(): Promise<TaughtSign[]> {
  const res = await fetch("/signs/starter.json");
  if (!res.ok) throw new Error(`starter signs: HTTP ${res.status}`);
  const json = await res.json();
  if (!isSignLibraryJson(json)) throw new Error("starter signs: invalid file");
  return json.signs;
}

// ---- recorded letter dataset (raw landmarks, for analysis and the team seed) ----
const LETTER_DATA_KEY = "signnote.letterdata.v1";
export type LetterDataMeta = { signer: string; lighting: Lighting };

export async function loadLetterData(): Promise<{ meta: LetterDataMeta; samples: LetterSample[] }> {
  const d = await loadBig<{ meta: LetterDataMeta; samples: LetterSample[]; handLabels?: "corrected" }>(
    LETTER_DATA_KEY,
  );
  if (!d || !Array.isArray(d.samples)) return { meta: { signer: "", lighting: "normal" }, samples: [] };
  // Recordings saved before the handedness fix have swapped hand labels.
  const samples =
    d.handLabels === "corrected"
      ? d.samples
      : d.samples.map((s) => ({ ...s, hand: s.hand === "Left" ? ("Right" as const) : ("Left" as const) }));
  return { meta: d.meta, samples };
}
export const saveLetterData = (meta: LetterDataMeta, samples: LetterSample[]) =>
  saveBig(LETTER_DATA_KEY, { meta, samples, handLabels: "corrected" });

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildKnn,
  EMPTY_CALIBRATION,
  isCalibrationSet,
  type CalibrationSet,
  type Knn,
} from "@/lib/calibration";
import { DEFAULT_HOLD } from "@/lib/holdConfirm";
import { loadLetterModel, type Classifier } from "@/lib/letterModel";
import { Recognizer } from "@/lib/recognizer";
import { buildLibrary, mergeSigns, normalizeMeaning, type TaughtSign } from "@/lib/signs";
import {
  DEFAULT_SETTINGS,
  fetchStarterSigns,
  loadCalibration,
  loadSettings,
  loadSigns,
  parseLetters,
  saveCalibration,
  saveSettings,
  saveSigns,
  type Settings,
} from "@/lib/settings";

let modelPromise: Promise<Classifier> | null = null;
let builtinPromise: Promise<TaughtSign[]> | null = null;
let seedPromise: Promise<Knn | null> | null = null;

/** Team letter recordings shipped with the app (public/models/letter-seed.json), as a k-NN prior. */
async function loadSeed(): Promise<Knn | null> {
  const res = await fetch("/models/letter-seed.json");
  if (!res.ok) return null;
  const json = await res.json();
  return isCalibrationSet(json) ? buildKnn(json) : null;
}

/**
 * Shared recognition state for every page: letter model, settings, calibration and taught signs
 * (settings in localStorage, the rest in IndexedDB), and a Recognizer rebuilt whenever any of them change.
 */
export function useRecognizer(overrides?: Partial<Settings>) {
  const [model, setModel] = useState<Classifier | null>(null);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [calibration, setCalibrationState] = useState<CalibrationSet>(EMPTY_CALIBRATION);
  const [signs, setSignsState] = useState<TaughtSign[]>([]);
  /** built-in signs (public/signs/starter.json: Space, Delete, J, Z): always available, not part of the user's list */
  const [builtins, setBuiltins] = useState<TaughtSign[]>([]);
  const [storageOk, setStorageOk] = useState(true);
  const [seed, setSeed] = useState<Knn | null>(null);
  const changed = useRef({ calibration: false, signs: false });

  useEffect(() => {
    modelPromise ??= loadLetterModel();
    modelPromise.then(setModel).catch((e) => {
      modelPromise = null;
      setError(String(e?.message ?? e));
    });
    seedPromise ??= loadSeed().catch(() => null);
    seedPromise.then(setSeed);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate from localStorage after mount
    setSettings(loadSettings());
    // Calibration and signs come from IndexedDB (async); a change made before they arrive wins.
    let live = true;
    loadCalibration().then((c) => {
      if (live && !changed.current.calibration) setCalibrationState(c);
    });
    loadSigns().then((saved) => {
      if (live && saved && !changed.current.signs) setSignsState(saved);
    });
    builtinPromise ??= fetchStarterSigns().catch(() => {
      builtinPromise = null;
      return [];
    });
    builtinPromise.then((b) => live && setBuiltins(b));
    return () => {
      live = false;
    };
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);
  const setCalibration = useCallback((c: CalibrationSet) => {
    changed.current.calibration = true;
    setCalibrationState(c);
    saveCalibration(c).then(setStorageOk);
  }, []);
  const setSigns = useCallback((s: TaughtSign[]) => {
    changed.current.signs = true;
    setSignsState(s);
    saveSigns(s).then(setStorageOk);
  }, []);

  // Page-specific overrides (e.g. /evaluate turns personal calibration off) without touching saved settings.
  const overridesKey = JSON.stringify(overrides ?? {});
  const eff = useMemo(
    () => ({ ...settings, ...(JSON.parse(overridesKey) as Partial<Settings>) }),
    [settings, overridesKey],
  );

  const knn = useMemo(
    () => (eff.useCalibration ? buildKnn(calibration) : null),
    [calibration, eff.useCalibration],
  );
  // The user's signs plus the built-in ones; a sign of the user's with the same meaning replaces a built-in one.
  // (Built-ins used to be copied into the user's list once, so deleting them lost them for good.)
  const allSigns = useMemo(() => mergeSigns(builtins, signs), [builtins, signs]);
  const shownBuiltins = useMemo(() => {
    const mine = new Set(signs.map((s) => normalizeMeaning(s.meaning)));
    return builtins.filter((b) => !mine.has(normalizeMeaning(b.meaning)));
  }, [builtins, signs]);
  const library = useMemo(() => (allSigns.length ? buildLibrary(allSigns) : null), [allSigns]);

  const recognizer = useMemo(() => {
    if (!model) return null;
    return new Recognizer(model, {
      swapHands: eff.swapHands,
      enabledLetters: parseLetters(eff.letters),
      useRules: eff.useRules,
      seed, // built-in team seed applies to everyone; "my calibration" only toggles personal data
      calibration: knn,
      signs: library,
      hold: { ...DEFAULT_HOLD, holdMs: eff.holdMs, threshold: eff.threshold },
    });
  }, [model, eff, seed, knn, library]);

  return {
    model,
    recognizer,
    error,
    settings,
    updateSettings,
    calibration,
    setCalibration,
    signs,
    setSigns,
    /** built-in signs not replaced by one of the user's */
    builtins: shownBuiltins,
    allSigns,
    library,
    storageOk,
  };
}

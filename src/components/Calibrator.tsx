"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, Download, Info, TriangleAlert, Upload } from "lucide-react";
import CameraView from "./CameraView";
import Lead from "./Lead";
import { useRecognizer } from "./useRecognizer";
import type { HandFrame } from "@/lib/handTracker";
import type { Candidate } from "@/lib/letterModel";
import type { Recognizer } from "@/lib/recognizer";
import {
  EMPTY_CALIBRATION,
  MIN_SAMPLES,
  addSamples,
  clearLetter,
  isCalibrationSet,
  type CalibrationSet,
} from "@/lib/calibration";
import {
  countByLabel,
  toSample,
  type LetterDataset,
  type LetterSample,
  type Lighting,
} from "@/lib/letterData";
import { loadLetterData, saveLetterData, type LetterDataMeta } from "@/lib/settings";

const LETTERS = "ABCDEFGHIKLMNOPQRSTUVWXY".split("");
const RECOMMENDED = ["G", "H", "A", "T", "M", "N", "S", "E"];
/** Letters most often confused for new signers (eval + per-signer analysis): about 40 s to record. */
const QUICK = ["A", "E", "S", "T", "M", "N", "O", "C", "G", "H", "R", "U"];
const RECORD_MS = 2000;
const READY_MS = 1500;

export const TIPS: Record<string, string> = {
  A: "Fist, thumb resting against the side of the index finger.",
  B: "Flat hand, fingers together pointing up, thumb folded across the palm.",
  C: "Curved hand, as if holding a cup.",
  D: "Index finger up; the other fingertips touch the thumb.",
  E: "Fingertips curled down onto the thumb, which is tucked under them.",
  F: "Index fingertip touches the thumb; the other three fingers up and spread.",
  G: "Index finger points sideways, thumb parallel above it; other fingers closed.",
  H: "Index AND middle fingers together, pointing sideways.",
  I: "Fist with the pinky up.",
  K: "Index up, middle angled forward, thumb touching the middle finger.",
  L: "Index up and thumb out: an L.",
  M: "Thumb tucked under three fingers. Tip: angle your palm slightly to the side so the camera sees the thumb.",
  N: "Thumb tucked under two fingers. Tip: angle your palm slightly to the side so the camera sees the thumb.",
  O: "All fingertips touch the thumb in an O.",
  P: "Like K, but pointing down.",
  Q: "Like G, but pointing down.",
  R: "Index and middle fingers crossed.",
  S: "Fist with the thumb wrapped across the front of the fingers.",
  T: "Fist with the thumb tip poking up between index and middle fingers.",
  U: "Index and middle fingers together, pointing up.",
  V: "Index and middle fingers apart, pointing up.",
  W: "Index, middle and ring fingers up and spread.",
  X: "Index finger hooked.",
  Y: "Thumb and pinky out.",
};

type Phase = { kind: "idle" } | { kind: "ready"; letter: string } | { kind: "recording"; letter: string };

type Capture = { letter: string; until: number; vecs: number[][]; raw: LetterSample[]; frame: number };

export default function Calibrator() {
  const [letter, setLetter] = useState("G");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [live, setLive] = useState<Candidate[]>([]);
  const [message, setMessage] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [meta, setMeta] = useState<LetterDataMeta>({ signer: "", lighting: "normal" });
  const [samples, setSamples] = useState<LetterSample[]>([]);
  const { recognizer, error, calibration, setCalibration, storageOk } = useRecognizer();
  const recRef = useRef<Recognizer | null>(null);
  const calibRef = useRef<CalibrationSet>(calibration);
  const samplesRef = useRef<LetterSample[]>([]);
  const metaRef = useRef(meta);
  const capture = useRef<Capture | null>(null);
  const queue = useRef<string[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const startNext = useRef<() => void>(() => {});

  useEffect(() => {
    let live = true;
    loadLetterData().then((d) => {
      // A recording made before the saved ones arrive keeps its samples (they'd otherwise be overwritten).
      if (!live) return;
      setMeta(d.meta);
      setSamples((cur) => (cur.length ? [...d.samples, ...cur] : d.samples));
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    recRef.current = recognizer;
    calibRef.current = calibration;
    samplesRef.current = samples;
    metaRef.current = meta;
  }, [recognizer, calibration, samples, meta]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const updateMeta = (patch: Partial<LetterDataMeta>) => {
    const next = { ...meta, ...patch };
    setMeta(next);
    saveLetterData(next, samples);
  };

  // Run through the queue: show the letter, a ready pause, then record.
  useEffect(() => {
    startNext.current = () => {
      const l = queue.current.shift();
      setRemaining(queue.current.length);
      if (!l) {
        setPhase({ kind: "idle" });
        return;
      }
      setLetter(l);
      setPhase({ kind: "ready", letter: l });
      timers.current.push(
        setTimeout(() => {
          capture.current = { letter: l, until: performance.now() + RECORD_MS, vecs: [], raw: [], frame: 0 };
          setPhase({ kind: "recording", letter: l });
        }, READY_MS),
      );
    };
  }, []);

  const onFrame = useCallback(
    (frame: HandFrame | null) => {
      const rec = recRef.current;
      if (!rec) return;
      const out = rec.process(frame, performance.now());
      setLive(out.live);
      const cap = capture.current;
      if (!cap) return;
      // Every 2nd frame with a hand -> roughly 30 samples in 2 s.
      if (frame && out.geoVec && cap.frame++ % 2 === 0) {
        cap.vecs.push(out.geoVec);
        cap.raw.push(toSample(cap.letter, frame.hand, frame.aspect, frame.landmarks, frame.world));
      }
      if (performance.now() < cap.until) return;
      capture.current = null;
      if (cap.vecs.length < MIN_SAMPLES) {
        setMessage(`Only ${cap.vecs.length} frames of ${cap.letter} had a hand in view. Recording it again.`);
        queue.current.unshift(cap.letter);
      } else {
        setCalibration(addSamples(calibRef.current, cap.letter, cap.vecs));
        const next = [...samplesRef.current, ...cap.raw];
        samplesRef.current = next;
        setSamples(next);
        const n = cap.vecs.length;
        saveLetterData(metaRef.current, next).then((ok) =>
          setMessage(
            ok
              ? `Saved ${n} samples of ${cap.letter}.`
              : "Couldn't save the recordings to this browser's storage. Export them now so they aren't lost.",
          ),
        );
      }
      startNext.current();
    },
    [setCalibration],
  );

  const run = (letters: string[]) => {
    setMessage("");
    queue.current = letters.slice();
    startNext.current();
  };
  const stop = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    queue.current = [];
    capture.current = null;
    setPhase({ kind: "idle" });
  };

  const download = (data: unknown, name: string) => {
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const exportDataset = () => {
    const ds: LetterDataset = {
      version: 1,
      kind: "letters",
      signer: meta.signer || "anonymous",
      lighting: meta.lighting,
      recordedAt: new Date().toISOString(),
      handLabels: "corrected",
      samples,
    };
    const who = (meta.signer || "anonymous").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    download(ds, `signnote-letters-${who}-${meta.lighting}.json`);
  };

  const importCalibration = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (!isCalibrationSet(data)) throw new Error("not a SignNote calibration file");
      setCalibration(data);
      setMessage(`Imported calibration for ${Object.keys(data.samples).join(", ")}.`);
    } catch (e) {
      setMessage(`Import failed: ${(e as Error).message}`);
    }
  };

  const clearAll = () => {
    setCalibration(EMPTY_CALIBRATION);
    setSamples([]);
    saveLetterData(meta, []);
  };
  const clearOne = (l: string) => {
    setCalibration(clearLetter(calibration, l));
    const next = samples.filter((s) => s.label !== l);
    setSamples(next);
    saveLetterData(meta, next);
  };

  const count = (l: string) => calibration.samples[l]?.length ?? 0;
  const rawCounts = countByLabel(samples);
  const busy = phase.kind !== "idle";
  const current = phase.kind === "idle" ? letter : phase.letter;

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:items-start">
      <div className="flex flex-col gap-3 md:sticky md:top-24">
        <CameraView onFrame={onFrame} autoStart>
          {phase.kind !== "idle" && (
            <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
              <div className="card flex items-center gap-4 px-4 py-2" role="status">
                <span className="flex items-center gap-2 text-2xl font-medium">
                  {phase.kind === "recording" && (
                    <span className="h-2 w-2 rounded-full bg-danger" aria-hidden />
                  )}
                  {phase.letter}
                </span>
                <span className="text-sm text-muted tabular-nums">
                  {phase.kind === "ready" ? "Get ready…" : "Hold it, move slightly."} {remaining} left
                </span>
              </div>
            </div>
          )}
        </CameraView>
        <div className="flex min-h-8 flex-wrap items-center gap-2">
          <span className="text-xs text-muted">
            {live.length ? "Seeing, with your calibration" : "Nothing recognized yet"}
          </span>
          {live.map((c, i) => (
            <span key={c.v} className={`chip ${i === 0 ? "border-accent text-text" : "text-muted"}`}>
              <span className="text-sm">{c.v}</span>
              {Math.round(c.p * 100)}%
            </span>
          ))}
        </div>
        <div className="flex items-baseline gap-4">
          <span className="text-2xl font-medium">{current}</span>
          <span className="text-sm text-muted">{TIPS[current] ?? "Hold the letter steady."}</span>
        </div>
        {error && (
          <p className="flex items-start gap-2 text-sm text-danger" title={error}>
            <Lead icon={CircleAlert} />
            The letter model didn&apos;t load. Reload the page to try again.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <section className="card">
          <div className="flex flex-col gap-4 p-4 md:p-6">
            <div className="grid grid-cols-2 gap-2">
              {busy ? (
                <button onClick={stop} className="btn btn-secondary col-span-2">
                  Stop
                </button>
              ) : (
                <>
                  <button onClick={() => run(QUICK)} disabled={!recognizer} className="btn btn-primary">
                    Quick, 12 letters
                  </button>
                  <button onClick={() => run(LETTERS)} disabled={!recognizer} className="btn btn-secondary">
                    Whole alphabet
                  </button>
                </>
              )}
            </div>
            <p className="text-xs text-muted">
              Quick takes about 40 s and covers the letters people mix up most; the whole alphabet takes about
              90 s. Hold each letter for 2 s and move your hand slightly. Using the app teaches it too: tap a
              wrong letter in the transcript and pick the right one.
            </p>
          </div>

          <div className="flex flex-col gap-3 border-t border-border p-4 md:p-6">
            <div className="flex items-center justify-between gap-4">
              <h2 className="label">Letters</h2>
              {!busy && (
                <div className="flex gap-1">
                  <button onClick={() => run([letter])} disabled={!recognizer} className="btn btn-ghost px-3">
                    Record {letter}
                  </button>
                  <button
                    onClick={() => clearOne(letter)}
                    disabled={!count(letter)}
                    className="btn btn-danger px-3"
                  >
                    Clear {letter}
                  </button>
                </div>
              )}
            </div>
            <div className="grid grid-cols-6 gap-2 sm:grid-cols-8">
              {LETTERS.map((l) => (
                <button
                  key={l}
                  onClick={() => setLetter(l)}
                  disabled={busy}
                  aria-current={l === current ? "true" : undefined}
                  aria-label={`${l}, ${count(l)} samples${RECOMMENDED.includes(l) ? ", often confused" : ""}`}
                  className={`relative flex h-12 cursor-pointer flex-col items-center justify-center rounded-control border text-base leading-none transition-colors duration-150 disabled:cursor-not-allowed ${
                    l === current ? "border-text font-semibold" : "border-border hover:bg-surface-2"
                  }`}
                >
                  {RECOMMENDED.includes(l) && (
                    <span aria-hidden className="absolute top-1 right-1 h-1 w-1 rounded-full bg-warning" />
                  )}
                  {l}
                  <span className="mt-1 text-xs text-muted tabular-nums">{count(l) || "–"}</span>
                </button>
              ))}
            </div>
            <p className="flex items-center gap-2 text-xs text-muted">
              <span aria-hidden className="h-1 w-1 rounded-full bg-warning" />
              Often confused. The number is your samples.
            </p>
          </div>
        </section>

        <section className="card">
          <div className="flex flex-col gap-4 p-4 md:p-6">
            <h2 className="text-base font-semibold tracking-tight">Share recordings with the team</h2>
            <p className="text-xs text-muted tabular-nums">
              {samples.length} raw frames across {Object.keys(rawCounts).length} letters, for testing and the
              built-in seed data. Exports contain hand landmark coordinates only, no video.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={meta.signer}
                onChange={(e) => updateMeta({ signer: e.target.value })}
                placeholder="Signer name or initials"
                aria-label="Signer name or initials"
                className="field"
              />
              <select
                value={meta.lighting}
                onChange={(e) => updateMeta({ lighting: e.target.value as Lighting })}
                className="field"
                aria-label="Lighting"
              >
                <option value="bright">Bright</option>
                <option value="normal">Normal</option>
                <option value="dim">Dim</option>
                <option value="backlit">Backlit</option>
              </select>
            </div>
          </div>
          <div className="flex flex-wrap gap-1 border-t border-border p-3 md:px-4">
            <button onClick={exportDataset} disabled={!samples.length} className="btn btn-ghost px-3">
              <Download size={16} strokeWidth={1.5} aria-hidden />
              Export recordings
            </button>
            <button
              onClick={() => download(calibration, "signnote-calibration.json")}
              className="btn btn-ghost px-3"
            >
              <Download size={16} strokeWidth={1.5} aria-hidden />
              Export calibration
            </button>
            <label className="btn btn-ghost px-3 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
              <Upload size={16} strokeWidth={1.5} aria-hidden />
              Import calibration
              <input
                type="file"
                accept="application/json"
                className="sr-only"
                onChange={(e) => e.target.files?.[0] && importCalibration(e.target.files[0])}
              />
            </label>
            <button onClick={clearAll} disabled={busy} className="btn btn-danger px-3">
              Clear all
            </button>
          </div>
        </section>

        {!storageOk && (
          <p className="flex items-start gap-2 text-sm text-warning">
            <Lead icon={TriangleAlert} />
            Couldn&apos;t save to this browser&apos;s storage; use Export to keep your calibration.
          </p>
        )}
        {message && (
          <p role="status" className="flex items-start gap-2 text-sm text-muted">
            <Lead icon={Info} />
            {message}
          </p>
        )}
      </div>
    </div>
  );
}

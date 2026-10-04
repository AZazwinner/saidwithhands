"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  CircleHelp,
  Download,
  Hand,
  Info,
  Plus,
  Eye,
  EyeOff,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import CameraView from "./CameraView";
import Lead from "./Lead";
import HoldRing from "./HoldRing";
import { useRecognizer } from "./useRecognizer";
import type { HandFrame } from "@/lib/handTracker";
import type { Recognizer, RecognizerStatus } from "@/lib/recognizer";
import type { Candidate } from "@/lib/letterModel";
import {
  buildLibrary,
  handshapeExample,
  isSignLibraryJson,
  isValidMeaning,
  mergeSigns,
  motionSequence,
  normalizeMeaning,
  pathLength,
  signThreshold,
  THRESHOLDS,
  trimToMotion,
  signLabel,
  type MotionFrame,
  type SignKind,
  type TaughtSign,
} from "@/lib/signs";
import SignPreview from "./SignPreview";

const READY_MS = 500; // per countdown beat (2 beats)
const RECORD_MS = 1600;
const MIN_FRAMES = 8;
/** wrist path (hand sizes) above which an auto-detected sign counts as a motion sign */
const MOTION_PATH = 1.2;

type Mode = "auto" | SignKind;
type Phase =
  | { kind: "idle" }
  | { kind: "countdown"; i: number; n: number }
  | { kind: "recording"; i: number }
  | { kind: "review"; sign: TaughtSign; warnings: string[]; threshold: number };

type LastSeen = { v: string; kind: "letter" | "sign"; at: number } | null;

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export default function Teacher() {
  const { recognizer, error, signs, setSigns, builtins, allSigns, storageOk } = useRecognizer();
  const [meaning, setMeaning] = useState("");
  /** the sign whose recorded shape/motion is shown in the list */
  const [shown, setShown] = useState<string | null>(null);
  const [count, setCount] = useState(5);
  const [mode, setMode] = useState<Mode>("auto");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [message, setMessage] = useState("");
  const [live, setLive] = useState<{
    live: Candidate[];
    label: string | null;
    progress: number;
    status: RecognizerStatus;
    signBest: { meaning: string; d: number; threshold: number } | null;
  }>({ live: [], label: null, progress: 0, status: "no-hand", signBest: null });
  const [last, setLast] = useState<LastSeen>(null);
  const [rejected, setRejected] = useState(false);
  /** the last completed movement's closest motion sign (kept until the next movement) */
  const [lastMotion, setLastMotion] = useState<{ meaning: string; d: number; threshold: number } | null>(null);
  const [jobView, setJobView] = useState({ meaning: "", count: 5 });
  const [sheetOpen, setSheetOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);

  const recRef = useRef<Recognizer | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const capture = useRef<{ i: number; until: number; frames: MotionFrame[]; letters: (string | null)[] } | null>(
    null,
  );
  const examples = useRef<MotionFrame[][]>([]);
  /** per recorded frame: the letter the full letter recognizer would confirm right then, or null */
  const letterVotes = useRef<(string | null)[]>([]);
  const job = useRef({ meaning: "", count: 5, mode: "auto" as Mode });
  const nextExample = useRef<(i: number) => void>(() => {});
  const finalize = useRef<() => void>(() => {});
  const teaching = phase.kind === "countdown" || phase.kind === "recording";

  useEffect(() => {
    recRef.current = recognizer;
  }, [recognizer]);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  // ---- teaching sequence ----
  useEffect(() => {
    nextExample.current = (i: number) => {
      setPhase({ kind: "countdown", i, n: 2 });
      timers.current.push(setTimeout(() => setPhase({ kind: "countdown", i, n: 1 }), READY_MS));
      timers.current.push(
        setTimeout(() => {
          capture.current = { i, until: performance.now() + RECORD_MS, frames: [], letters: [] };
          setPhase({ kind: "recording", i });
        }, 2 * READY_MS),
      );
    };
    finalize.current = () => {
      const { meaning: m, mode: md } = job.current;
      const recs = examples.current;
      const paths = recs.map(pathLength).sort((a, b) => a - b);
      const median = paths[Math.floor(paths.length / 2)];
      const kind: SignKind = md === "auto" ? (median > MOTION_PATH ? "motion" : "handshape") : md;
      const sign: TaughtSign =
        kind === "motion"
          ? { id: newId(), meaning: m, kind, examples: recs.map((f) => motionSequence(trimToMotion(f))) }
          : {
              id: newId(),
              meaning: m,
              kind,
              examples: recs.map((f) => handshapeExample(f.map((x) => x.shape))),
            };

      const warnings: string[] = [];
      const threshold = signThreshold(sign);
      if (threshold >= THRESHOLDS[kind].max) {
        warnings.push(
          "Your examples varied a lot, so matching will be loose. Consider teaching it again, more consistently.",
        );
      }
      if (md === "auto" && kind === "handshape" && median > MOTION_PATH * 0.6) {
        warnings.push(
          "There was a little movement; saved as a held handshape. Choose 'Motion' if the movement matters.",
        );
      }
      const others = allSigns.filter((s) => normalizeMeaning(s.meaning) !== m);
      if (others.length) {
        const lib = buildLibrary(others);
        const similar = new Set<string>();
        for (const ex of sign.examples) {
          const match =
            kind === "motion" ? lib.matchMotion(ex as number[][]) : lib.matchHandshape(ex as number[]);
          match.candidates.forEach((c) => similar.add(c.v));
        }
        if (similar.size)
          warnings.push(`Looks similar to: ${[...similar].join(", ")}. They may get confused.`);
      }
      // Would holding this shape type a letter? Asked of the full letter pipeline (model + handshape rules +
      // calibration, smoothed, against the hold threshold and margin) on the recorded frames. The bare model
      // has no "not a letter" answer, so on its own it called e.g. a thumbs-up "G".
      if (kind === "handshape") {
        const votes = letterVotes.current;
        const counts = new Map<string, number>();
        for (const v of votes) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
        const [letter, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
        if (votes.length && n / votes.length >= 0.5) {
          warnings.push(
            `Without this sign, holding this handshape types the letter ${letter}. Your sign takes priority when it matches well.`,
          );
        }
      }
      setPhase({ kind: "review", sign, warnings, threshold });
    };
  }, [allSigns]);

  const start = () => {
    const m = normalizeMeaning(meaning);
    if (!isValidMeaning(m)) {
      setMessage("Type what the sign means (2–60 characters, e.g. “my medication”).");
      return;
    }
    setMessage("");
    job.current = { meaning: m, count, mode };
    setJobView({ meaning: m, count });
    examples.current = [];
    letterVotes.current = [];
    clearTimers();
    nextExample.current(0);
  };

  const cancel = () => {
    clearTimers();
    capture.current = null;
    setPhase({ kind: "idle" });
  };

  const save = () => {
    if (phase.kind !== "review") return;
    setSigns(mergeSigns(signs, [phase.sign]));
    setMessage(`Saved “${signLabel(phase.sign)}”. Try it now: it is recognized right away.`);
    setMeaning("");
    setPhase({ kind: "idle" });
  };

  // ---- per-frame ----
  const onFrame = useCallback((frame: HandFrame | null) => {
    const rec = recRef.current;
    if (!rec) return;
    const out = rec.process(frame, performance.now());
    const cap = capture.current;
    if (cap) {
      if (out.motionFrame) {
        cap.frames.push(out.motionFrame);
        const letters = out.live.filter((c) => c.v.length === 1); // taught signs have 2+ characters
        const { threshold, margin } = rec.opts.hold;
        const [a, b] = letters;
        cap.letters.push(a && a.p >= threshold && a.p - (b?.p ?? 0) >= margin ? a.v : null);
      }
      if (performance.now() >= cap.until) {
        capture.current = null;
        if (cap.frames.length < MIN_FRAMES) {
          setMessage("I couldn't see your hand during that one. Let's redo it.");
          nextExample.current(cap.i);
          return;
        }
        examples.current.push(cap.frames);
        letterVotes.current.push(...cap.letters);
        if (cap.i + 1 < job.current.count) nextExample.current(cap.i + 1);
        else finalize.current();
      }
      return;
    }
    setLive({
      live: out.live,
      label: out.hold.label,
      progress: out.hold.progress,
      status: out.status,
      signBest: out.signBest,
    });
    if (out.accepted) setLast({ v: out.accepted.v, kind: out.accepted.kind, at: Date.now() });
    if (out.motionBest) setLastMotion(out.motionBest);
    if (out.motionRejected) {
      setRejected(true);
      timers.current.push(setTimeout(() => setRejected(false), 1200));
    }
  }, []);

  // ---- library management ----
  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ version: 1, signs })], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "signnote-signs.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJson = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (!isSignLibraryJson(data)) throw new Error("not a SignNote signs file");
      setSigns(mergeSigns(signs, data.signs));
      setMessage(`Imported ${data.signs.length} sign(s).`);
    } catch (e) {
      setMessage(`Import failed: ${(e as Error).message}`);
    }
  };
  /** A row in the sign list; built-in signs can be shown but not deleted. */
  const signRow = (s: TaughtSign, deletable: boolean) => (
    <li key={s.id} className="px-4 md:px-6">
      <div className="flex h-14 items-center justify-between gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base">{signLabel(s)}</span>
          <span className="block text-xs text-muted tabular-nums">
            {s.kind === "motion" ? "Motion" : "Held shape"}, {s.examples.length} examples
          </span>
        </span>
        <button
          onClick={() => setShown(shown === s.id ? null : s.id)}
          aria-expanded={shown === s.id}
          aria-controls={`preview-${s.id}`}
          className="btn btn-ghost h-9 px-3 text-sm"
        >
          {shown === s.id ? (
            <EyeOff size={16} strokeWidth={1.5} aria-hidden />
          ) : (
            <Eye size={16} strokeWidth={1.5} aria-hidden />
          )}
          {shown === s.id ? "Hide" : "Show"}
        </button>
        {deletable && (
          <button
            onClick={() => setSigns(signs.filter((x) => x.id !== s.id))}
            disabled={teaching}
            className="btn btn-ghost btn-icon"
            aria-label={`Delete ${signLabel(s)}`}
          >
            <Trash2 size={16} strokeWidth={1.5} aria-hidden />
          </button>
        )}
      </div>
      {shown === s.id && (
        <div id={`preview-${s.id}`} className="pb-4">
          <SignPreview sign={s} />
        </div>
      )}
    </li>
  );

  // ---- sheet ----
  const openSheet = () => {
    setMessage("");
    setSheetOpen(true);
  };
  // Phones: once the sheet (and the room under the content) is rendered, bring the camera to the top.
  useEffect(() => {
    if (sheetOpen && window.matchMedia("(max-width: 767px)").matches)
      cameraRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [sheetOpen]);
  const closeSheet = () => {
    cancel();
    setSheetOpen(false);
    triggerRef.current?.focus();
  };
  const closeSheetRef = useRef(closeSheet);
  useEffect(() => {
    closeSheetRef.current = closeSheet;
  });
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSheetRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  const step = phase.kind === "review" ? 3 : teaching ? 2 : 1;
  const done = phase.kind === "countdown" || phase.kind === "recording" ? phase.i : 0;

  const overlay =
    phase.kind === "countdown" || phase.kind === "recording" ? (
      <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
        <div className="card flex items-center gap-3 px-4 py-2" role="status">
          {phase.kind === "countdown" ? (
            <span className="text-2xl font-medium tabular-nums">{phase.n}</span>
          ) : (
            <span className="flex items-center gap-2 text-base font-medium">
              <span aria-hidden className="h-2 w-2 rounded-full bg-danger" />
              Recording
            </span>
          )}
          <span className="text-sm text-muted tabular-nums">
            Example {phase.i + 1} of {jobView.count}
          </span>
        </div>
      </div>
    ) : null;

  return (
    <div
      className={`grid gap-6 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:items-start md:pb-0 ${sheetOpen ? "pb-[50vh]" : ""}`}
    >
      <div ref={cameraRef} className="flex scroll-mt-24 flex-col gap-3 md:sticky md:top-24">
        <CameraView onFrame={onFrame} autoStart>
          {overlay ?? (
            <HoldRing
              label={live.label}
              progress={live.progress}
              confidence={live.live[0]?.p ?? 0}
              status={live.status}
              rejected={rejected}
            />
          )}
        </CameraView>
        <div className="flex min-h-8 flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
          <span className="label shrink-0">Last recognized</span>
          {last ? (
            <span className="text-lg">
              {signLabel(signs.find((s) => s.meaning === last.v) ?? { meaning: last.v })}{" "}
              <span className="text-xs text-muted">{last.kind}</span>
            </span>
          ) : (
            <span className="text-sm text-muted">Perform a taught sign or hold a letter to try it.</span>
          )}
        </div>
        {live.signBest && live.status !== "no-hand" && !teaching && (
          <SignReadout best={live.signBest} kind="handshape" />
        )}
        {lastMotion && !teaching && <SignReadout best={lastMotion} kind="motion" />}
        {error && (
          <p className="flex items-start gap-2 text-sm text-danger" title={error}>
            <Lead icon={CircleAlert} />
            The letter model didn&apos;t load. Reload the page to try again.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <section aria-labelledby="signs-title" className={`card ${sheetOpen ? "md:hidden" : ""}`}>
          <div className="flex items-center justify-between gap-4 p-4 md:px-6">
            <h2 id="signs-title" className="text-base font-semibold tracking-tight">
              Your signs <span className="font-normal text-muted tabular-nums">{signs.length}</span>
            </h2>
            <button
              ref={triggerRef}
              onClick={openSheet}
              disabled={!recognizer || sheetOpen}
              className="btn btn-primary"
            >
              <Plus size={16} strokeWidth={1.5} aria-hidden />
              Teach a sign
            </button>
          </div>
          {signs.length === 0 ? (
            <p className="flex items-start gap-2 border-t border-border px-4 py-6 text-sm text-muted md:px-6">
              <Lead icon={Hand} />
              No signs of your own yet. Teach one.
            </p>
          ) : (
            <ul className="divide-y divide-border border-t border-border">{signs.map((s) => signRow(s, true))}</ul>
          )}
          {builtins.length > 0 && (
            <>
              <div className="flex flex-col gap-1 border-t border-border px-4 pt-4 pb-2 md:px-6">
                <h3 className="text-sm font-semibold tracking-tight">
                  Built in <span className="font-normal text-muted tabular-nums">{builtins.length}</span>
                </h3>
                <p className="text-xs text-muted">Always available. A sign of yours with the same name replaces one.</p>
              </div>
              <ul className="divide-y divide-border">{builtins.map((s) => signRow(s, false))}</ul>
            </>
          )}
          <div className="flex flex-wrap gap-1 border-t border-border p-3 md:px-4">
            <button onClick={exportJson} disabled={!signs.length} className="btn btn-ghost px-3">
              <Download size={16} strokeWidth={1.5} aria-hidden />
              Export
            </button>
            <label className="btn btn-ghost px-3 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
              <Upload size={16} strokeWidth={1.5} aria-hidden />
              Import
              <input
                type="file"
                accept="application/json"
                className="sr-only"
                onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])}
              />
            </label>
          </div>
        </section>

        {message && !sheetOpen && (
          <p role="status" className="flex items-start gap-2 text-sm text-muted">
            <Lead icon={Info} />
            {message}
          </p>
        )}
        {!storageOk && (
          <p className="flex items-start gap-2 text-sm text-warning">
            <Lead icon={TriangleAlert} />
            Couldn&apos;t save to this browser&apos;s storage (it may be full or blocked). Signs work until you
            reload; use Export to keep them.
          </p>
        )}
        {sheetOpen && (
          <div
            role="dialog"
            aria-labelledby="teach-title"
            className="sheet-in fixed inset-x-0 bottom-0 z-30 flex max-h-[50vh] flex-col rounded-t-card border-t border-border bg-surface shadow-popover md:static md:max-h-none md:rounded-card md:border md:shadow-none"
          >
            <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
              <h2 id="teach-title" className="text-lg font-semibold tracking-tight">
                Teach a sign
              </h2>
              <button onClick={closeSheet} className="btn btn-ghost btn-icon" aria-label="Close">
                <X size={20} strokeWidth={1.5} aria-hidden />
              </button>
            </div>

            <ol className="flex gap-4 border-b border-border px-6 py-3 text-xs" aria-label="Steps">
              {["Name it", "Record", "Done"].map((label, i) => {
                const n = i + 1;
                const state = n < step ? "done" : n === step ? "current" : "todo";
                return (
                  <li
                    key={label}
                    aria-current={state === "current" ? "step" : undefined}
                    className={`flex items-center gap-2 ${state === "todo" ? "text-muted" : "text-text"}`}
                  >
                    <span
                      aria-hidden
                      className={`flex h-4 w-4 items-center justify-center rounded-full text-xs tabular-nums ${
                        state === "done"
                          ? "bg-accent text-accent-fg"
                          : state === "current"
                            ? "border border-accent text-accent"
                            : "border border-border"
                      }`}
                    >
                      {state === "done" ? <Check size={12} strokeWidth={2} /> : n}
                    </span>
                    <span className={state === "current" ? "font-medium" : ""}>{label}</span>
                  </li>
                );
              })}
            </ol>

            <div className="flex-1 overflow-y-auto px-6 py-6">
              {step === 1 && (
                <div className="flex flex-col gap-6">
                  <label className="flex flex-col gap-2">
                    <span className="text-sm font-medium">What does the sign mean?</span>
                    <input
                      autoFocus
                      value={meaning}
                      onChange={(e) => setMeaning(e.target.value)}
                      placeholder="e.g. my medication"
                      className="field h-11 text-base"
                      onKeyDown={(e) => e.key === "Enter" && start()}
                    />
                  </label>
                  <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium" id="type-label">
                      Sign type
                    </span>
                    <div
                      className="grid grid-cols-3 gap-1 rounded-control bg-surface-2 p-1"
                      role="radiogroup"
                      aria-labelledby="type-label"
                    >
                      {(["auto", "handshape", "motion"] as Mode[]).map((m) => (
                        <button
                          key={m}
                          role="radio"
                          aria-checked={mode === m}
                          onClick={() => setMode(m)}
                          className={`h-8 cursor-pointer rounded-control text-sm transition-colors duration-150 ${
                            mode === m ? "border border-border bg-surface font-medium text-text" : "text-muted hover:text-text"
                          }`}
                        >
                          {m === "handshape" ? "Held shape" : m === "motion" ? "Motion" : "Auto"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="flex items-center justify-between gap-4">
                    <span className="text-sm font-medium">Examples</span>
                    <select value={count} onChange={(e) => setCount(Number(e.target.value))} className="field">
                      {[5, 6, 7, 8, 9, 10].map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                  <p className="text-xs text-muted">
                    Each example: a short countdown, then {RECORD_MS / 1000} s to sign. Perform the whole sign
                    the same way each time, starting and ending with your hand still. One hand only. Facial
                    expressions and body position aren&apos;t captured.
                  </p>
                  {message && (
                    <p role="status" className="flex items-start gap-2 text-sm text-warning">
                      <Lead icon={TriangleAlert} />
                      {message}
                    </p>
                  )}
                </div>
              )}

              {step === 2 && (phase.kind === "countdown" || phase.kind === "recording") && (
                <div className="flex flex-col items-center gap-6 py-4 text-center" role="status">
                  <p className="text-sm text-muted">“{jobView.meaning}”</p>
                  {phase.kind === "countdown" ? (
                    <p className="text-2xl font-medium tabular-nums">Get ready… {phase.n}</p>
                  ) : (
                    <p className="flex items-center gap-2 text-2xl font-medium">
                      <span aria-hidden className="h-2 w-2 rounded-full bg-danger" />
                      Sign now
                    </p>
                  )}
                  <p className="text-sm tabular-nums">
                    Recording example {phase.i + 1} of {jobView.count}
                  </p>
                  <div className="flex gap-2" aria-hidden>
                    {Array.from({ length: jobView.count }, (_, i) => (
                      <span
                        key={i}
                        className={`h-2 w-2 rounded-full ${
                          i < done ? "bg-accent" : i === done ? "border border-accent" : "border border-muted/50"
                        }`}
                      />
                    ))}
                  </div>
                  {message && <p className="text-xs text-warning">{message}</p>}
                </div>
              )}

              {step === 3 && phase.kind === "review" && (
                <div className="flex flex-col gap-4">
                  <p className="flex items-center gap-2 text-sm text-accent">
                    <Check size={16} strokeWidth={1.5} aria-hidden />
                    All examples recorded
                  </p>
                  <p className="text-xl leading-tight">“{signLabel(phase.sign)}”</p>
                  <SignPreview sign={phase.sign} />
                  <p className="text-xs text-muted tabular-nums">
                    {phase.sign.examples.length} examples,{" "}
                    {phase.sign.kind === "motion" ? "motion sign" : "held handshape"}, match threshold{" "}
                    {phase.threshold.toFixed(2)}
                  </p>
                  {phase.warnings.map((w) => (
                    <p key={w} className="flex items-start gap-2 text-sm text-warning">
                      <Lead icon={TriangleAlert} />
                      {w}
                    </p>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
              {step === 1 && (
                <>
                  <button onClick={closeSheet} className="btn btn-ghost">
                    Cancel
                  </button>
                  <button onClick={start} disabled={!recognizer} className="btn btn-primary">
                    Start recording
                  </button>
                </>
              )}
              {step === 2 && (
                <button onClick={cancel} className="btn btn-secondary">
                  Stop
                </button>
              )}
              {step === 3 && (
                <>
                  <button onClick={closeSheet} className="btn btn-ghost">
                    Discard
                  </button>
                  <button onClick={() => setPhase({ kind: "idle" })} className="btn btn-secondary">
                    Record again
                  </button>
                  <button
                    onClick={() => {
                      save();
                      setSheetOpen(false);
                      triggerRef.current?.focus();
                    }}
                    className="btn btn-primary"
                  >
                    Save sign
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

/**
 * "How close is my sign" line: makes a miss explainable instead of silent. Handshape: live, for the hand
 * now. Motion: for the last completed movement.
 */
function SignReadout({
  best,
  kind,
}: {
  best: { meaning: string; d: number; threshold: number };
  kind: "handshape" | "motion";
}) {
  const inside = best.d < best.threshold;
  const motion = kind === "motion";
  return (
    <p
      className={`flex items-start gap-2 text-xs ${inside ? "text-muted" : "text-warning"}`}
      aria-live="off"
      title={`Distance between ${motion ? "your last movement" : "your hand now"} and the closest taught ${motion ? "motion sign" : "handshape"}, and the most that still counts as a match`}
    >
      <Lead icon={inside ? Check : CircleHelp} line="h-4" className={inside ? "text-accent" : ""} />
      <span>
        {motion ? "Last movement " : ""}
        {inside ? (motion ? "matched" : "Matches") : motion ? "was closest to" : "Closest sign:"}{" "}
        <span className="font-medium">{best.meaning}</span>
        {inside
          ? motion
            ? "."
            : ". Hold it steady."
          : motion
            ? ", but too different from how you taught it; keep the same path and handshape, starting and ending still."
            : ". Too far from how you taught it; hold the same shape."}{" "}
        <span className="tabular-nums">
          ({best.d.toFixed(2)} of {best.threshold.toFixed(2)} allowed)
        </span>
      </span>
    </p>
  );
}

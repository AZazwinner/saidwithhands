"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import CameraView from "./CameraView";
import HoldRing from "./HoldRing";
import { useRecognizer } from "./useRecognizer";
import type { HandFrame } from "@/lib/handTracker";
import type { Candidate } from "@/lib/letterModel";
import type { Recognizer, RecognizerStatus } from "@/lib/recognizer";
import {
  addReplacing,
  addSpace,
  ambiguousAlternative,
  deleteLast,
  fixLetter,
  rawText,
  removeAt,
  toPositions,
  type Token,
} from "@/lib/transcript";
import BestGuessPanel from "./BestGuessPanel";
import { requestBestGuess } from "@/lib/bestGuessClient";
import type { BestGuessResult } from "@/lib/bestGuess";
import { primeAudio, speak as speakAloud, type VoiceEngine } from "@/lib/voice";
import ReplyCaptions from "./ReplyCaptions";
import Lead from "./Lead";
import PrivacyNote from "./PrivacyNote";
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  Hand,
  Info,
  Volume1,
  Volume2,
} from "lucide-react";
import { DEFAULT_HOLD } from "@/lib/holdConfirm";
import { addSamples, calibratedLetters } from "@/lib/calibration";
import { signLabel } from "@/lib/signs";

type Live = { live: Candidate[]; label: string | null; progress: number; status: RecognizerStatus };
const EMPTY_LIVE: Live = { live: [], label: null, progress: 0, status: "no-hand" };
const REJECT_FLASH_MS = 1200;

export default function Communicator() {
  const {
    recognizer,
    error: modelError,
    settings,
    updateSettings,
    calibration,
    setCalibration,
    signs,
    builtins,
  } = useRecognizer();
  const [fixing, setFixing] = useState<number | null>(null);
  const [learned, setLearned] = useState("");
  const [tokens, setTokens] = useState<Token[]>([]);
  const [live, setLive] = useState<Live>(EMPTY_LIVE);
  const [rejected, setRejected] = useState(false);
  const [guess, setGuess] = useState<{ result: BestGuessResult | null; loading: boolean; tokens: Token[] }>({
    result: null,
    loading: false,
    tokens: [],
  });
  const rejectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const recRef = useRef<Recognizer | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** the phone action bar only shows while the tool is on screen (not over the landing hero or footer) */
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /** a just-corrected letter, re-applied when the recognizer is rebuilt with the new calibration */
  const pendingFix = useRef<string | null>(null);
  useEffect(() => {
    recRef.current = recognizer;
    if (recognizer && pendingFix.current) {
      recognizer.noteCorrection(pendingFix.current, performance.now());
      pendingFix.current = null;
    }
  }, [recognizer]);

  const onFrame = useCallback((frame: HandFrame | null) => {
    const rec = recRef.current;
    if (!rec) return;
    const out = rec.process(frame, performance.now());
    setLive({ live: out.live, label: out.hold.label, progress: out.hold.progress, status: out.status });
    if (out.motionRejected) {
      setRejected(true);
      clearTimeout(rejectTimer.current);
      rejectTimer.current = setTimeout(() => setRejected(false), REJECT_FLASH_MS);
    }
    const acc = out.accepted;
    if (acc)
      setTokens((ts) =>
        addReplacing(
          ts,
          acc.kind === "letter"
            ? { kind: "letter", v: acc.v, candidates: acc.candidates, samples: acc.samples }
            : { kind: "sign", v: acc.v, candidates: acc.candidates },
          acc.retracts,
          acc.action,
        ),
      );
  }, []);

  const text = rawText(tokens);
  const [speaking, setSpeaking] = useState(false);
  const [engine, setEngine] = useState<VoiceEngine | null>(null);
  const speakText = useCallback(async (t: string) => {
    setSpeaking(true);
    try {
      setEngine(await speakAloud(t));
    } finally {
      setSpeaking(false);
    }
  }, []);

  /**
   * Speak: ask for a best guess once per phrase (not per letter), show it with the raw signs, say it. The
   * transcript clears right away, ready for the next message; the guess panel keeps the signs it was made from.
   * Gemini decides from the words whether it's a question.
   */
  const speak = useCallback(async () => {
    const positions = toPositions(tokens);
    if (positions.length === 0) return;
    primeAudio(); // must run inside the tap, before any await (iOS)
    const snapshot = tokens.slice(0, positions.length);
    setTokens((ts) => ts.slice(snapshot.length)); // keep anything signed after Speak was pressed
    setFixing(null);
    setGuess({ result: null, loading: true, tokens: snapshot });
    const result = await requestBestGuess(positions);
    setGuess({ result, loading: false, tokens: snapshot });
    void speakText(result.sentence);
  }, [tokens, speakText]);

  const clearAll = () => {
    setTokens([]);
    setFixing(null);
    setGuess({ result: null, loading: false, tokens: [] });
  };

  // Keyboard shortcuts for laptop demos: Space = word break, Backspace = delete, Enter = speak.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select, button")) return;
      if (e.key === " ") {
        e.preventDefault();
        setTokens(addSpace);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        setTokens(deleteLast);
      } else if (e.key === "Enter") {
        e.preventDefault();
        void speak();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [speak]);

  const top = live.live[0];
  const sure = live.status === "ok" && !!live.label;
  const showGuess = guess.loading || !!guess.result;
  const longestRun = tokens.reduce(
    (acc, t) => (t.kind === "letter" ? { cur: acc.cur + 1, max: Math.max(acc.max, acc.cur + 1) } : { ...acc, cur: 0 }),
    { cur: 0, max: 0 },
  ).max;

  const speakButton = (extra: string) => (
    <button onClick={speak} disabled={!text || guess.loading} className={`btn btn-primary ${extra}`}>
      <Volume2 size={20} strokeWidth={1.5} aria-hidden />
      {guess.loading ? "Getting best guess…" : "Speak"}
    </button>
  );

  return (
    <div
      ref={rootRef}
      className="grid gap-6 pb-24 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:items-start md:pb-0"
    >
      {/* On phones the left column dissolves so the transcript sits right under the camera. */}
      <div className="contents md:sticky md:top-24 md:flex md:flex-col md:gap-3">
        <CameraView onFrame={onFrame} autoStart={inView} className="order-1">
          <HoldRing
            label={live.label}
            progress={live.progress}
            confidence={top?.p ?? 0}
            status={live.status}
            rejected={rejected}
          />
        </CameraView>

        <div className="order-2 -mt-3 flex min-h-8 flex-wrap items-center gap-2 md:mt-0">
          {live.live.length === 0 ? (
            <span className="text-xs text-muted">Nothing recognized yet</span>
          ) : (
            <span className={`flex items-center gap-1 text-xs ${sure ? "text-muted" : "text-warning"}`}>
              {!sure && <CircleHelp size={16} strokeWidth={1.5} aria-hidden />}
              {sure ? "Seeing" : "Not sure. Could be"}
            </span>
          )}
          {live.live.map((c, i) => (
            <span key={c.v} className={`chip ${i === 0 && sure ? "border-accent text-text" : "text-muted"}`}>
              <span className="text-sm">{c.v}</span>
              {Math.round(c.p * 100)}%
            </span>
          ))}
        </div>

        {/* Phones: the short status line stays under the camera; the full note follows the content. */}
        <div className="order-2 md:hidden">
          <PrivacyNote part="short" />
        </div>
        <div className="order-4 hidden md:block">
          <PrivacyNote />
        </div>
        <div className="order-4 md:hidden">
          <PrivacyNote part="detail" />
        </div>
      </div>

      <div className="order-3 flex flex-col gap-4">
        {modelError && (
          <p className="flex items-start gap-2 text-sm text-danger" title={modelError}>
            <Lead icon={CircleAlert} />
            The letter model didn&apos;t load. Reload the page to try again.
          </p>
        )}

        <section aria-label="Transcript" className="card">
          <div className="p-4 md:p-6">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="label">Transcript</h2>
              {tokens.length > 0 && <span className="text-xs text-muted">Tap a letter to fix it</span>}
            </div>
            {tokens.length === 0 ? (
              <p className="mt-3 flex items-start gap-2 text-base text-muted">
                <span className="flex h-6 shrink-0 items-center">
                  <Hand size={20} strokeWidth={1.5} aria-hidden />
                </span>
                Hold a letter until the ring fills, or perform a sign you taught.
              </p>
            ) : (
              <p className="mt-3 text-xl leading-tight break-words md:text-2xl md:leading-tight">
                {tokens.map((t, i) =>
                  t.kind === "space" ? (
                    <span key={i}> </span>
                  ) : t.kind === "sign" ? (
                    <span key={i} className="fade-in mx-1 inline-block rounded-control bg-surface-2 px-2">
                      {t.v}
                    </span>
                  ) : (
                    <LetterToken
                      key={i}
                      token={t}
                      selected={fixing === i}
                      onClick={() => setFixing(fixing === i ? null : i)}
                    />
                  ),
                )}
                <span
                  aria-hidden
                  className="caret ml-1 inline-block h-[0.9em] w-px translate-y-[0.12em] bg-accent"
                />
              </p>
            )}
          </div>

          {longestRun >= 9 && (
            <p className="flex items-start gap-2 border-t border-border px-4 py-3 text-xs text-muted md:px-6">
              <Lead icon={Info} line="h-4" />
              Make your Space sign between words (or press the space bar) so the best guess is more reliable.
            </p>
          )}

          {fixing !== null && tokens[fixing]?.kind === "letter" && (
            <FixPanel
              token={tokens[fixing]}
              onPick={(v) => {
                const tok = tokens[fixing];
                if (tok.kind === "letter" && v !== tok.v && tok.samples?.length) {
                  setCalibration(addSamples(calibration, v, tok.samples));
                  setLearned(
                    `Learned: that handshape is your ${v} (${tok.samples.length} samples added to your calibration).`,
                  );
                } else setLearned("");
                setTokens((ts) => fixLetter(ts, fixing, v));
                if (fixing === tokens.length - 1) {
                  recRef.current?.noteCorrection(v, performance.now());
                  pendingFix.current = v; // the calibration change rebuilds the recognizer
                }
                setFixing(null);
              }}
              onRemove={() => {
                setTokens((ts) => removeAt(ts, fixing));
                setFixing(null);
              }}
              onClose={() => setFixing(null)}
            />
          )}
          {learned && fixing === null && (
            <p role="status" className="flex items-start gap-2 border-t border-border px-4 py-3 text-xs text-muted md:px-6">
              <Check size={16} strokeWidth={1.5} aria-hidden className="shrink-0 text-accent" />
              {learned}
            </p>
          )}

          {showGuess && (
            <div className="border-t border-border p-4 md:p-6">
              <BestGuessPanel
                result={guess.result}
                loading={guess.loading}
                tokens={guess.tokens}
                onSpeak={(t) => {
                  primeAudio();
                  void speakText(t);
                }}
              />
              {engine && guess.result && (
                <p className="mt-3 flex items-center gap-2 text-xs text-muted">
                  {engine === "elevenlabs" ? (
                    <Volume2 size={16} strokeWidth={1.5} aria-hidden />
                  ) : (
                    <Volume1 size={16} strokeWidth={1.5} aria-hidden />
                  )}
                  {engine === "elevenlabs"
                    ? `${speaking ? "Speaking" : "Spoken"} with ElevenLabs.`
                    : engine === "browser"
                      ? `${speaking ? "Speaking" : "Spoken"} with the browser voice. ElevenLabs is unavailable.`
                      : "No voice is available on this device."}
                </p>
              )}
            </div>
          )}

          <div className="hidden gap-2 border-t border-border p-4 md:flex md:p-6">
            {speakButton("btn-lg flex-1")}
            <button onClick={clearAll} className="btn btn-secondary btn-lg">
              Clear
            </button>
          </div>
          <div className="border-t border-border p-4 md:hidden">
            <button onClick={clearAll} className="btn btn-secondary w-full">
              Clear
            </button>
          </div>
        </section>

        <ReplyCaptions paused={speaking} />

        {calibratedLetters(calibration).length === 0 && (
          <p className="flex items-start gap-2 text-sm text-muted">
            <Lead icon={Info} />
            <span>
              Letters work better after a{" "}
              <Link href="/calibrate" className="link">
                40-second calibration
              </Link>
              . When a letter is wrong, tap it and pick the right one: the app learns your handshape, on
              this device.
            </span>
          </p>
        )}

        <p className="text-sm text-muted">
          <span className="tabular-nums">{signs.length}</span> taught sign{signs.length === 1 ? "" : "s"}
          {signs.length ? `: ${signs.map(signLabel).join(", ")}` : ""}
          {builtins.length ? `, plus built in: ${builtins.map(signLabel).join(", ")}` : ""}.{" "}
          <Link href="/teach" className="link">
            Teach a sign
          </Link>
        </p>

        <details className="group card">
          <summary className="flex h-11 cursor-pointer list-none items-center justify-between px-4 text-sm font-medium [&::-webkit-details-marker]:hidden">
            Recognition settings
            <ChevronDown
              size={16}
              strokeWidth={1.5}
              aria-hidden
              className="text-muted transition-transform duration-150 ease-out group-open:rotate-180"
            />
          </summary>
          <div className="flex flex-col gap-4 border-t border-border p-4 text-sm">
            <label className="flex items-start gap-3">
              <span className="flex h-5 shrink-0 items-center">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent"
                  checked={settings.swapHands}
                  onChange={(e) => updateSettings({ swapHands: e.target.checked })}
                />
              </span>
              Swap left/right hand (try this if letters come out mirrored, e.g. lots of wrong guesses)
            </label>
            <label className="flex items-start gap-3">
              <span className="flex h-5 shrink-0 items-center">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent"
                  checked={settings.useRules}
                  onChange={(e) => updateSettings({ useRules: e.target.checked })}
                />
              </span>
              Use hand-geometry checks (look-alike letters, and &quot;not sure&quot; when the shape
              doesn&apos;t fit)
            </label>
            <label className="flex items-start gap-3">
              <span className="flex h-5 shrink-0 items-center">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent"
                  checked={settings.useCalibration}
                  onChange={(e) => updateSettings({ useCalibration: e.target.checked })}
                />
              </span>
              <span>
                Use my letter calibration ({calibratedLetters(calibration).join(", ") || "none recorded"}).{" "}
                <Link href="/calibrate" className="link">
                  Calibrate letters
                </Link>
              </span>
            </label>
            <label className="flex flex-col gap-2">
              Only recognize these letters (empty = all 24 static letters)
              <input
                value={settings.letters}
                onChange={(e) => updateSettings({ letters: e.target.value })}
                placeholder="e.g. ABCDEFLOVWY"
                className="field uppercase"
              />
            </label>
            <label className="flex flex-col gap-2">
              <span>
                Hold time: <span className="tabular-nums">{settings.holdMs}</span> ms
              </span>
              <input
                type="range"
                className="accent-accent"
                min={300}
                max={1200}
                step={50}
                value={settings.holdMs}
                onChange={(e) => updateSettings({ holdMs: Number(e.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-2">
              <span>
                Confidence threshold: <span className="tabular-nums">{Math.round(settings.threshold * 100)}%</span>
              </span>
              <input
                type="range"
                className="accent-accent"
                min={0.3}
                max={0.95}
                step={0.05}
                value={settings.threshold}
                onChange={(e) => updateSettings({ threshold: Number(e.target.value) })}
              />
            </label>
            <p className="text-xs text-muted">
              J and Z need motion and aren&apos;t in the letter model; teach them as motion signs. Keyboard:
              Space = word break, Backspace = delete, Enter = speak.
            </p>
          </div>
        </details>
      </div>

      {/* Phone action bar, within thumb reach. */}
      <div
        className={`fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-border bg-surface px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] transition-opacity duration-150 ease-out md:hidden ${inView ? "opacity-100" : "pointer-events-none opacity-0"}`}
        inert={!inView}
      >
        {speakButton("h-12 flex-1 text-base")}
      </div>
    </div>
  );
}

/** A typed letter; letters from an ambiguous set show their runner-up, e.g. M/N, for context to resolve. */
function LetterToken({ token, selected, onClick }: { token: Token; selected: boolean; onClick: () => void }) {
  if (token.kind !== "letter") return null;
  const alt = ambiguousAlternative(token, DEFAULT_HOLD.ambiguous);
  return (
    <button
      type="button"
      onClick={onClick}
      title={alt && !token.fixed ? `Could be ${token.v} or ${alt}. Tap to fix` : "Tap to fix this letter"}
      className={`fade-in cursor-pointer rounded-control px-px transition-colors duration-150 ${
        selected ? "bg-accent text-accent-fg" : token.fixed ? "text-accent hover:bg-surface-2" : "hover:bg-surface-2"
      } ${alt && !token.fixed ? "underline decoration-warning decoration-dotted decoration-2 underline-offset-8" : ""}`}
    >
      {token.v}
      {alt && !token.fixed && <sub className="text-xs text-warning">/{alt}</sub>}
    </button>
  );
}

const ALPHABET = "ABCDEFGHIKLMNOPQRSTUVWXY".split("");

/** Pick the right letter for a wrongly recognized one. The choice is also learned (personal calibration). */
function FixPanel({
  token,
  onPick,
  onRemove,
  onClose,
}: {
  token: Token;
  onPick: (v: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  if (token.kind !== "letter") return null;
  const likely = token.candidates.map((c) => c.v).filter((v) => v !== token.v);
  return (
    <div className="fade-in flex flex-col gap-4 border-t border-border p-4 md:p-6">
      <p className="text-sm">
        Fix <span className="font-semibold">{token.v}</span>: what did you sign?{" "}
        <span className="text-muted">Your answer also teaches the app your handshape.</span>
      </p>
      {likely.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="label mr-1">Likely</span>
          {likely.map((v) => (
            <button key={v} onClick={() => onPick(v)} className="btn btn-secondary h-11 w-11 px-0 text-lg">
              {v}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-6 gap-2 sm:grid-cols-8">
        {ALPHABET.map((v) => (
          <button
            key={v}
            onClick={() => onPick(v)}
            aria-current={v === token.v ? "true" : undefined}
            className={`h-11 cursor-pointer rounded-control border text-base transition-colors duration-150 ${
              v === token.v
                ? "border-text font-semibold"
                : "border-border hover:bg-surface-2"
            }`}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={onClose} className="btn btn-ghost">
          Cancel
        </button>
        <button onClick={onRemove} className="btn btn-danger">
          Remove letter
        </button>
      </div>
    </div>
  );
}

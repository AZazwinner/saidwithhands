"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  EMPTY_CAPTIONS,
  commitSession,
  mergeCaptions,
  type Captions,
  type SpeechResultLike,
} from "@/lib/captions";
import { CircleAlert, Mic, MicOff, Square } from "lucide-react";
import Lead from "./Lead";

// Minimal typing for the Web Speech API (not in every TS DOM lib; prefixed in Chrome/Safari).
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult:
    ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type RecognitionCtor = new () => Recognition;

function getRecognition(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access is blocked. Allow it in the browser's site settings.",
  "service-not-allowed": "This browser doesn't allow speech recognition here.",
  network: "The browser's speech service can't be reached (offline?).",
  "audio-capture": "No microphone found.",
};

type Props = {
  /** pause listening while the app itself is speaking, so it doesn't caption its own voice */
  paused: boolean;
};

/** "Their reply": live captions of the hearing person's speech, large enough to read across a counter. */
export default function ReplyCaptions({ paused }: Props) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [listening, setListening] = useState(false);
  const [captions, setCaptions] = useState<Captions>(EMPTY_CAPTIONS);
  const [error, setError] = useState("");
  const rec = useRef<Recognition | null>(null);
  const committed = useRef<string[]>([]);
  const session = useRef<SpeechResultLike[]>([]);
  const wanted = useRef(false); // user wants captions on (we restart after Chrome's silence timeouts)
  const pausedRef = useRef(paused);
  const restart = useRef<() => void>(() => {});

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- feature detection after mount
    setSupported(getRecognition() !== null);
  }, []);

  const startSession = useCallback(() => {
    const Ctor = getRecognition();
    if (!Ctor) return;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    session.current = [];
    r.onresult = (e) => {
      session.current = Array.from(e.results, (res) => ({
        isFinal: res.isFinal,
        transcript: res[0]?.transcript ?? "",
      }));
      setCaptions(mergeCaptions(committed.current, session.current));
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      setError(ERRORS[e.error] ?? `Speech recognition error: ${e.error}`);
      wanted.current = false;
      setListening(false);
    };
    r.onend = () => {
      committed.current = commitSession(committed.current, session.current);
      session.current = [];
      setCaptions(mergeCaptions(committed.current, []));
      if (wanted.current && !pausedRef.current) restart.current();
      else if (!wanted.current) setListening(false);
    };
    rec.current = r;
    try {
      r.start();
    } catch {
      /* already started */
    }
  }, []);

  useEffect(() => {
    restart.current = startSession;
  }, [startSession]);

  // Pause while the app speaks; resume afterwards.
  useEffect(() => {
    pausedRef.current = paused;
    if (!wanted.current) return;
    if (paused) rec.current?.stop();
    else startSession();
  }, [paused, startSession]);

  useEffect(
    () => () => {
      wanted.current = false;
      rec.current?.abort();
    },
    [],
  );

  const toggle = () => {
    setError("");
    if (wanted.current) {
      wanted.current = false;
      rec.current?.stop();
      setListening(false);
    } else {
      wanted.current = true;
      setListening(true);
      startSession();
    }
  };

  if (supported === null) return null;
  if (!supported) {
    return (
      <p className="flex items-start gap-2 text-sm text-muted">
        <Lead icon={MicOff} />
        Reply captions aren&apos;t available: this browser has no speech recognition. Use Chrome, Edge or
        Safari.
      </p>
    );
  }

  return (
    <section aria-label="Their reply" className="card">
      <div className="flex items-center justify-between gap-4 p-4 md:px-6">
        <h2 className="label">Their reply</h2>
        <div className="flex items-center gap-1">
          {(captions.lines.length > 0 || captions.interim) && (
            <button
              onClick={() => {
                committed.current = [];
                session.current = [];
                setCaptions(EMPTY_CAPTIONS);
              }}
              className="btn btn-ghost px-3"
            >
              Clear
            </button>
          )}
          <button onClick={toggle} aria-pressed={listening} className="btn btn-secondary">
            {listening ? (
              <Square size={16} strokeWidth={1.5} aria-hidden />
            ) : (
              <Mic size={16} strokeWidth={1.5} aria-hidden className="text-muted" />
            )}
            {listening ? "Stop captions" : "Start captions"}
          </button>
        </div>
      </div>
      {error && (
        <p className="flex items-start gap-2 border-t border-border px-4 py-3 text-sm text-danger md:px-6">
          <Lead icon={CircleAlert} />
          {error}
        </p>
      )}
      {(listening || captions.lines.length > 0) && (
        <div aria-live="polite" className="min-h-24 border-t border-border p-4 text-xl leading-tight md:p-6">
          {captions.lines.map((l, i) => (
            <p key={i} className={i < captions.lines.length - 1 ? "text-muted" : ""}>
              {l}
            </p>
          ))}
          {captions.interim && <p className="text-muted">{captions.interim}</p>}
          {listening && !captions.interim && captions.lines.length === 0 && (
            <p className="flex items-center gap-2 text-base text-muted">
              <Mic size={16} strokeWidth={1.5} aria-hidden />
              {paused ? "Paused while speaking…" : "Listening…"}
            </p>
          )}
        </div>
      )}
      <p className="border-t border-border px-4 py-3 text-xs text-muted md:px-6">
        Captions use your browser&apos;s speech recognition. In Chrome and Edge the other person&apos;s audio
        is sent to the browser maker&apos;s speech service (Google / Microsoft); it isn&apos;t processed on
        this device. Captions can be wrong.
      </p>
    </section>
  );
}

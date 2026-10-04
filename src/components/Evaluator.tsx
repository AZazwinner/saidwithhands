"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import Lead from "./Lead";
import CameraView from "./CameraView";
import HoldRing from "./HoldRing";
import ConfusionHeatmap from "./ConfusionHeatmap";
import { useRecognizer } from "./useRecognizer";
import type { HandFrame } from "@/lib/handTracker";
import type { Recognizer, RecognizerStatus } from "@/lib/recognizer";
import type { Candidate } from "@/lib/letterModel";
import type { Lighting } from "@/lib/letterData";
import { addReplacing, addSpace, deleteLast, rawText, toPositions, type Token } from "@/lib/transcript";
import { requestBestGuess } from "@/lib/bestGuessClient";
import {
  DEFAULT_PHRASES,
  LETTER_LIST,
  confusionMatrix,
  isTrialArray,
  summarize,
  toCsv,
  wordRecall,
  type Trial,
  type TrialKind,
} from "@/lib/evaluation";
import { loadJson, saveJson } from "@/lib/storage";

const STORE = "signnote.eval.v1";
const TRIAL_MS = 8000;

type Tab = TrialKind | "results";
type Run =
  | { kind: "idle" }
  | { kind: "signing"; mode: "letter" | "sign"; i: number; startedAt: number }
  | { kind: "review"; mode: "letter" | "sign"; i: number; recognized: string | null }
  | { kind: "phrase"; i: number }
  | { kind: "phrase-review"; i: number; raw: string; best: string; ok: boolean; loading: boolean };

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export default function Evaluator() {
  // Default: personal calibration OFF (a brand-new user). "Calibrated first" turns on the calibration stored
  // in this browser, which must be the current signer's own. (A built-in team seed, if shipped, stays on.)
  const [calibrated, setCalibrated] = useState(false);
  const { recognizer, signs, error, calibration } = useRecognizer({ useCalibration: calibrated });
  const [trials, setTrials] = useState<Trial[]>([]);
  const [signer, setSigner] = useState("");
  const [unseen, setUnseen] = useState(true);
  const [lighting, setLighting] = useState<Lighting>("normal");
  const [session, setSession] = useState(newId);
  const [tab, setTab] = useState<Tab>("letter");
  const [run, setRun] = useState<Run>({ kind: "idle" });
  const [phrases, setPhrases] = useState(DEFAULT_PHRASES.join("\n"));
  const [tokens, setTokens] = useState<Token[]>([]);
  const [live, setLive] = useState<{
    live: Candidate[];
    label: string | null;
    progress: number;
    status: RecognizerStatus;
  }>({ live: [], label: null, progress: 0, status: "no-hand" });
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState("");

  const recRef = useRef<Recognizer | null>(null);
  const runRef = useRef(run);
  useEffect(() => {
    recRef.current = recognizer;
    runRef.current = run;
  }, [recognizer, run]);
  useEffect(() => {
    const saved = loadJson<unknown>(STORE, []);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate from localStorage after mount
    if (isTrialArray(saved)) setTrials(saved);
  }, []);

  const signList = signs.map((s) => s.meaning);
  const phraseList = phrases
    .split("\n")
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
  const targets = (mode: "letter" | "sign") => (mode === "letter" ? LETTER_LIST : signList);

  const persist = (next: Trial[]) => {
    setTrials(next);
    if (!saveJson(STORE, next))
      setMessage("Couldn't save to this browser's storage. Export the results now.");
  };
  const record = (
    t: Omit<Trial, "id" | "session" | "signer" | "unseen" | "calibrated" | "lighting" | "at">,
  ) =>
    persist([
      ...trials,
      {
        ...t,
        id: newId(),
        session,
        signer: signer.trim() || "anonymous",
        unseen,
        lighting,
        at: new Date().toISOString(),
      },
    ]);

  // ---- per-frame ----
  const onFrame = useCallback((frame: HandFrame | null) => {
    const rec = recRef.current;
    if (!rec) return;
    const out = rec.process(frame, performance.now());
    setLive({ live: out.live, label: out.hold.label, progress: out.hold.progress, status: out.status });
    const r = runRef.current;
    if (r.kind === "signing" && r.startedAt < 0) {
      // Stamp the trial start on its first frame; ignore anything accepted before it.
      rec.rearm(); // a letter already being held when the prompt appears still counts
      const started = { ...r, startedAt: performance.now() };
      runRef.current = started;
      setRun(started);
    } else if (r.kind === "signing") {
      if (out.accepted) setRun({ kind: "review", mode: r.mode, i: r.i, recognized: out.accepted.v });
      else if (performance.now() - r.startedAt > TRIAL_MS)
        setRun({ kind: "review", mode: r.mode, i: r.i, recognized: null });
    } else if (r.kind === "phrase" && out.accepted) {
      const acc = out.accepted;
      setTokens((ts) =>
        addReplacing(ts, { kind: acc.kind, v: acc.v, candidates: acc.candidates }, acc.retracts),
      );
    }
  }, []);

  const startTrial = (mode: "letter" | "sign", i: number) => {
    if (i >= targets(mode).length) {
      setRun({ kind: "idle" });
      setMessage(`Finished all ${mode === "letter" ? "letters" : "signs"}. See Results.`);
      return;
    }
    setRun({ kind: "signing", mode, i, startedAt: -1 }); // stamped on the next frame
  };
  const startPhrase = (i: number) => {
    setTokens([]);
    recRef.current?.rearm();
    if (i >= phraseList.length) {
      setRun({ kind: "idle" });
      setMessage("Finished all phrases. See Results.");
      return;
    }
    setRun({ kind: "phrase", i });
  };
  const finishPhrase = async (i: number) => {
    const positions = toPositions(tokens);
    const raw = rawText(tokens).toLowerCase();
    setRun({ kind: "phrase-review", i, raw, best: "", ok: false, loading: true });
    const res = positions.length ? await requestBestGuess(positions) : null;
    setRun({ kind: "phrase-review", i, raw, best: res?.sentence ?? "", ok: !!res?.ok, loading: false });
  };

  const begin = (t: Tab) => {
    setMessage("");
    setTab(t);
    setSession(newId());
    if (t === "letter" || t === "sign") startTrial(t, 0);
    else if (t === "phrase") startPhrase(0);
  };

  // ---- results ----
  const s = summarize(trials);
  const sNew = summarize(trials.filter((t) => !t.calibrated));
  const sCal = summarize(trials.filter((t) => t.calibrated));
  const download = (content: string, name: string, type: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJson = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (!isTrialArray(data)) throw new Error("not a SignNote evaluation export");
      const ids = new Set(trials.map((t) => t.id));
      persist([...trials, ...data.filter((t) => !ids.has(t.id))]);
      setMessage(`Imported ${data.length} trials.`);
    } catch (e) {
      setMessage(`Import failed: ${(e as Error).message}`);
    }
  };

  const busy = run.kind !== "idle";
  const isPhrase = run.kind === "phrase" || run.kind === "phrase-review";
  const runIndex = run.kind === "idle" ? 0 : run.i;
  const runTotal = isPhrase
    ? phraseList.length
    : run.kind === "signing" || run.kind === "review"
      ? targets(run.mode).length
      : 0;
  const prompt =
    run.kind === "signing" || run.kind === "review"
      ? targets(run.mode)[run.i]
      : run.kind === "phrase" || run.kind === "phrase-review"
        ? phraseList[run.i]
        : null;

  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-start gap-2 text-sm text-muted">
        <Lead icon={Info} />
        <span>
          <span className="font-medium text-text">A small, informal test, not a formal study.</span> One person
          signs a fixed list while a second person confirms each attempt was signed as intended. Calibration is
          off unless you tick &ldquo;Signer calibrated first&rdquo;. Results stay in this browser unless exported.
        </span>
      </p>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 text-sm">
        <label className="flex flex-col gap-1">
          Signer (name or initials)
          <input
            value={signer}
            onChange={(e) => setSigner(e.target.value)}
            disabled={busy}
            className="field"
          />
        </label>
        <label className="flex flex-col gap-1">
          Lighting
          <select
            value={lighting}
            onChange={(e) => setLighting(e.target.value as Lighting)}
            disabled={busy}
            className="field"
          >
            <option value="bright">Bright</option>
            <option value="normal">Normal</option>
            <option value="dim">Dim</option>
            <option value="backlit">Backlit</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="h-4 w-4 accent-accent"
            checked={unseen}
            onChange={(e) => setUnseen(e.target.checked)}
            disabled={busy}
          />
          <span>
            This signer did <strong className="font-semibold">not</strong> record training letters or taught
            signs
          </span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="h-4 w-4 accent-accent"
            checked={calibrated}
            onChange={(e) => setCalibrated(e.target.checked)}
            disabled={busy}
          />
          <span>
            Signer calibrated first (uses the calibration in this browser:{" "}
            <span className="tabular-nums">{Object.keys(calibration.samples).length}</span> letters)
          </span>
        </label>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]" role="tablist">
        {(
          [
            ["letter", `Letters (${LETTER_LIST.length})`],
            ["sign", `Taught signs (${signList.length})`],
            ["phrase", `Phrases (${phraseList.length})`],
            ["results", `Results (${trials.length} trials)`],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            disabled={busy}
            onClick={() => setTab(t)}
            className={`-mb-px min-h-11 shrink-0 cursor-pointer border-b-2 px-3 whitespace-nowrap text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tab === t ? "border-accent font-medium text-text" : "border-transparent text-muted hover:text-text"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {message && (
        <p role="status" className="text-sm text-muted">
          {message}
        </p>
      )}
      {error && <p className="text-sm text-danger">Letter model failed to load: {error}</p>}

      {tab !== "results" && (
        <div className="grid gap-4 md:grid-cols-2 md:items-start">
          <CameraView onFrame={onFrame} autoStart>
            <HoldRing
              label={live.label}
              progress={live.progress}
              confidence={live.live[0]?.p ?? 0}
              status={live.status}
            />
          </CameraView>

          <div className="flex flex-col gap-3">
            {!busy && (
              <div className="card flex flex-col gap-3 p-6">
                {tab === "letter" && <p>The signer signs each of the 24 letters once, in a fixed order.</p>}
                {tab === "sign" &&
                  (signList.length ? (
                    <p>The signer performs each taught sign once: {signList.join(", ")}.</p>
                  ) : (
                    <p className="text-warning">No taught signs on this device yet. Teach some first.</p>
                  ))}
                {tab === "phrase" && (
                  <label className="flex flex-col gap-1 text-sm">
                    Phrases (one per line). The signer fingerspells each one (and/or uses taught signs); we
                    compare the raw recognized text with Gemini&apos;s best guess.
                    <textarea
                      value={phrases}
                      onChange={(e) => setPhrases(e.target.value)}
                      rows={5}
                      className="field uppercase"
                    />
                  </label>
                )}
                <button
                  onClick={() => begin(tab)}
                  disabled={
                    !recognizer ||
                    (tab === "sign" && !signList.length) ||
                    (tab === "phrase" && !phraseList.length)
                  }
                  className="btn btn-primary"
                >
                  Start
                </button>
              </div>
            )}

            {prompt && (
              <div className="card p-6 text-center">
                <p className="text-sm font-semibold text-muted">
                  {isPhrase ? "Spell" : "Sign"} ({runIndex + 1} of {runTotal})
                </p>
                <p className="mt-1 text-2xl font-medium break-words">{prompt}</p>
              </div>
            )}

            {run.kind === "signing" && (
              <p className="text-center text-muted">
                Waiting for a recognition (up to {TRIAL_MS / 1000} s)…
              </p>
            )}

            {run.kind === "review" && (
              <div className="card flex flex-col gap-3 p-6">
                <p className="text-lg">
                  Recognized:{" "}
                  <strong
                    className={
                      run.recognized === targets(run.mode)[run.i] ? "text-accent" : "text-danger"
                    }
                  >
                    {run.recognized ?? "nothing"}
                  </strong>
                </p>
                <p className="text-sm text-muted">Observer: was it signed as intended?</p>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => {
                      record({
                        kind: run.mode,
                        target: targets(run.mode)[run.i],
                        recognized: run.recognized,
                      });
                      startTrial(run.mode, run.i + 1);
                    }}
                    className="btn btn-primary"
                  >
                    Yes, record
                  </button>
                  <button onClick={() => startTrial(run.mode, run.i)} className="btn btn-secondary">
                    Redo
                  </button>
                  <button
                    onClick={() => startTrial(run.mode, run.i + 1)}
                    className="btn btn-secondary text-muted"
                  >
                    Skip
                  </button>
                </div>
              </div>
            )}

            {run.kind === "phrase" && (
              <div className="card flex flex-col gap-3 p-6">
                <p className="min-h-10 text-xl">{rawText(tokens) || "…"}</p>
                <div className="grid grid-cols-3 gap-2">
                  <button onClick={() => setTokens(addSpace)} className="btn btn-secondary">
                    Space
                  </button>
                  <button onClick={() => setTokens(deleteLast)} className="btn btn-secondary">
                    Delete
                  </button>
                  <button onClick={() => void finishPhrase(run.i)} className="btn btn-primary">
                    Done
                  </button>
                </div>
              </div>
            )}

            {run.kind === "phrase-review" && (
              <div className="card flex flex-col gap-3 p-6 text-lg">
                <p>
                  Raw signs: <strong>{run.raw || "(nothing)"}</strong>{" "}
                  <span className="text-sm text-muted">
                    ({Math.round(100 * wordRecall(phraseList[run.i], run.raw))}% of words)
                  </span>
                </p>
                <p>
                  Best guess: <strong>{run.loading ? "asking Gemini…" : run.best || "(nothing)"}</strong>{" "}
                  {!run.loading && (
                    <span className="text-sm text-muted">
                      ({Math.round(100 * wordRecall(phraseList[run.i], run.best))}% of words
                      {run.ok ? "" : ", Gemini unavailable: raw fallback"})
                    </span>
                  )}
                </p>
                <div className="grid grid-cols-3 gap-2 text-base">
                  <button
                    disabled={run.loading}
                    onClick={() => {
                      record({
                        kind: "phrase",
                        target: phraseList[run.i],
                        recognized: null,
                        raw: run.raw,
                        bestGuess: run.best,
                        bestGuessOk: run.ok,
                      });
                      startPhrase(run.i + 1);
                    }}
                    className="btn btn-primary"
                  >
                    Record
                  </button>
                  <button onClick={() => startPhrase(run.i)} className="btn btn-secondary">
                    Redo
                  </button>
                  <button onClick={() => startPhrase(run.i + 1)} className="btn btn-secondary text-muted">
                    Skip
                  </button>
                </div>
              </div>
            )}

            {busy && (
              <button onClick={() => setRun({ kind: "idle" })} className="btn btn-ghost self-center">
                Stop this run
              </button>
            )}
          </div>
        </div>
      )}

      {tab === "results" && (
        <div className="flex flex-col gap-6">
          <p className="text-muted">
            {s.signers.length} signer{s.signers.length === 1 ? "" : "s"} ({s.unseenSigners.length} who
            didn&apos;t record any data), {trials.length} trials. Small numbers: treat as indicative only.
          </p>

          {sNew.letters.n > 0 && sCal.letters.n > 0 && (
            <p className="card p-4 text-base">
              Letters, new user <strong>{pct(sNew.letters.correct, sNew.letters.n)}</strong> → after
              calibrating <strong>{pct(sCal.letters.correct, sCal.letters.n)}</strong>{" "}
              <span className="text-sm opacity-80">
                ({sNew.letters.n} vs {sCal.letters.n} letter trials)
              </span>
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat
              label="Letters correct"
              value={pct(s.letters.correct, s.letters.n)}
              detail={`${s.letters.correct} of ${s.letters.n}, ${s.letters.nothing} not recognized in time`}
            />
            <Stat
              label="Taught signs correct"
              value={pct(s.signs.correct, s.signs.n)}
              detail={`${s.signs.correct} of ${s.signs.n}, ${s.signs.wrong} wrong, ${s.signs.nothing} rejected`}
            />
            <Stat
              label="Phrases: words found"
              value={
                s.phrases.n
                  ? `${Math.round(s.phrases.rawRecall * 100)}% → ${Math.round(s.phrases.bestRecall * 100)}%`
                  : "–"
              }
              detail={`raw signs → best guess, fully right ${s.phrases.rawExact} → ${s.phrases.bestExact} of ${s.phrases.n}, Gemini answered ${s.phrases.geminiAnswered}/${s.phrases.n}`}
            />
          </div>

          <section>
            <h3 className="mb-3 text-base font-semibold tracking-tight">Letter confusion matrix</h3>
            <ConfusionHeatmap data={confusionMatrix(trials)} />
          </section>

          <section>
            <h3 className="mb-3 text-base font-semibold tracking-tight">Per letter</h3>
            <div className="flex flex-wrap gap-1 text-sm">
              {s.letters.perLetter.map((l) => (
                <span key={l.letter} className="chip">
                  {l.letter} {l.correct}/{l.n}
                </span>
              ))}
              {s.letters.perLetter.length === 0 && (
                <span className="text-muted">No letter trials yet.</span>
              )}
            </div>
          </section>

          <section>
            <h3 className="mb-3 text-base font-semibold tracking-tight">Trials</h3>
            <div className="max-h-80 overflow-auto rounded-card border border-border bg-surface">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-surface text-muted">
                  <tr>
                    <th className="px-3 py-2">Signer</th>
                    <th className="px-3 py-2">Kind</th>
                    <th className="px-3 py-2">Target</th>
                    <th className="px-3 py-2">Recognized / raw</th>
                    <th className="px-3 py-2">Best guess</th>
                  </tr>
                </thead>
                <tbody>
                  {trials
                    .slice()
                    .reverse()
                    .map((t) => (
                      <tr key={t.id} className="border-t border-border">
                        <td className="px-3 py-2">
                          {t.signer}
                          {t.unseen ? "" : " (seen)"}
                          {t.calibrated ? " (calibrated)" : ""}
                        </td>
                        <td className="px-3 py-2">{t.kind}</td>
                        <td className="px-3 py-2">{t.target}</td>
                        <td className="px-3 py-2">
                          {t.kind === "phrase" ? t.raw : (t.recognized ?? "∅")}
                        </td>
                        <td className="px-3 py-2">{t.bestGuess ?? ""}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="flex flex-wrap gap-2 text-sm">
            <button
              onClick={() => download(JSON.stringify(trials), "signnote-evaluation.json", "application/json")}
              disabled={!trials.length}
              className="btn btn-secondary"
            >
              Export JSON
            </button>
            <button
              onClick={() => download(toCsv(trials), "signnote-evaluation.csv", "text/csv")}
              disabled={!trials.length}
              className="btn btn-secondary"
            >
              Export CSV
            </button>
            <label className="btn btn-secondary">
              Import JSON (merge another device)
              <input
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])}
              />
            </label>
            {confirmClear ? (
              <>
                <button
                  onClick={() => {
                    persist([]);
                    setConfirmClear(false);
                  }}
                  className="btn btn-secondary border-danger text-danger"
                >
                  Really delete all {trials.length} trials
                </button>
                <button onClick={() => setConfirmClear(false)} className="btn btn-secondary">
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmClear(true)}
                disabled={!trials.length}
                className="btn btn-danger"
              >
                Clear results
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="card p-6">
      <p className="text-sm font-semibold text-muted">{label}</p>
      <p className="mt-1 text-2xl font-medium tabular-nums tracking-tight">{value}</p>
      <p className="mt-1 text-sm text-muted">{detail}</p>
    </div>
  );
}

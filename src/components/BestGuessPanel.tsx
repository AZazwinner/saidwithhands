import { CloudOff, LoaderCircle, Volume2 } from "lucide-react";
import { reasonMessage, type BestGuessResult } from "@/lib/bestGuess";
import type { Token } from "@/lib/transcript";

type Props = {
  result: BestGuessResult | null;
  loading: boolean;
  /** transcript tokens the guess was made from (positions = index + 1) */
  tokens: Token[];
  onSpeak: (text: string) => void;
};

/**
 * "Best guess" sentence with the raw recognized signs always visible underneath. Letters the guess
 * changed are marked (recognized -> chosen); words the guess added that nobody signed are
 * dotted-underlined.
 */
export default function BestGuessPanel({ result, loading, tokens, onSpeak }: Props) {
  if (!result && !loading) return null;
  const chosen = new Map(result?.ok ? result.chosen.map((c) => [c.pos, c.v]) : []);
  const changed = new Set(result?.ok ? result.changed : []);
  const corrected = new Set(result?.ok ? result.corrected : []);
  const dropped = new Set(result?.ok ? result.dropped : []);
  const added = new Set(result?.ok ? result.added.map((w) => w.toLowerCase()) : []);
  const offline = !!result && !result.ok;

  return (
    <section aria-label="Best guess" aria-live="polite">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="label">{offline ? "Recognized signs" : "Best guess"}</h2>
        {result?.ok && (
          <span className="text-xs text-muted tabular-nums">Gemini, {(result.ms / 1000).toFixed(1)} s</span>
        )}
      </div>

      {offline && (
        <p className="mt-2 flex items-center gap-2 text-xs text-warning" title={result?.reason}>
          <CloudOff size={16} strokeWidth={1.5} aria-hidden />
          {result && !result.ok ? reasonMessage(result.reason) : ""} Showing the recognized signs.
        </p>
      )}

      <p className="mt-2 min-h-8 text-xl leading-tight">
        {loading && !result ? (
          <span className="flex items-center gap-2 text-base text-muted">
            <LoaderCircle size={16} strokeWidth={1.5} aria-hidden className="animate-spin" />
            Asking Gemini…
          </span>
        ) : (
          result?.sentence.split(/(\s+)/).map((w, i) => {
            const bare = w.toLowerCase().replace(/[^a-z']/g, "");
            return added.has(bare) ? (
              <span
                key={i}
                title="Added by the best guess: not signed"
                className="underline decoration-accent decoration-dotted decoration-2 underline-offset-4"
              >
                {w}
              </span>
            ) : (
              <span key={i}>{w}</span>
            );
          })
        )}
      </p>

      {!offline && <p className="label mt-4">Recognized signs</p>}
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-sm text-muted">
        {tokens.map((t, i) => {
          const pos = i + 1;
          if (t.kind === "space") return <span key={i} className="w-2" aria-hidden />;
          const was = t.v;
          const now = chosen.get(pos);
          if (dropped.has(pos)) {
            return (
              <span
                key={i}
                title={`Recognized ${was}; best guess treated it as an extra letter`}
                className="line-through"
              >
                {was}
              </span>
            );
          }
          if (corrected.has(pos) && now) {
            return (
              <span
                key={i}
                title={`Recognized ${was}; best guess fixed it to ${now} (not among the recognizer's top 3)`}
                className="text-warning"
              >
                {was}→{now}*
              </span>
            );
          }
          return changed.has(pos) && now ? (
            <span key={i} title={`Recognized ${was}; best guess chose ${now}`} className="text-accent">
              {was}→{now}
            </span>
          ) : (
            <span key={i}>{was}</span>
          );
        })}
      </p>
      {corrected.size > 0 && (
        <p className="mt-2 text-xs text-muted">
          * Fixed by the best guess: the recognizer didn&apos;t offer this letter.
        </p>
      )}
      {added.size > 0 && (
        <p className="mt-2 text-xs text-muted">
          Dotted words were added by the best guess and weren&apos;t signed: {[...added].join(", ")}.
        </p>
      )}

      {result && (
        <div className="mt-4 -ml-3 flex flex-wrap gap-1">
          <button onClick={() => onSpeak(result.sentence)} className="btn btn-ghost px-3">
            <Volume2 size={16} strokeWidth={1.5} aria-hidden />
            Speak again
          </button>
          {result.ok && (
            <button onClick={() => onSpeak(tokensToText(tokens))} className="btn btn-ghost px-3">
              Speak recognized signs instead
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function tokensToText(tokens: Token[]): string {
  return tokens
    .map((t) => (t.kind === "space" ? " " : t.kind === "sign" ? ` ${t.v} ` : t.v))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

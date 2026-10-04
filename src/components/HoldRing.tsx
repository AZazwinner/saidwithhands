import { CircleHelp } from "lucide-react";
import type { RecognizerStatus } from "@/lib/recognizer";

type Props = {
  label: string | null;
  progress: number;
  confidence: number;
  status: RecognizerStatus;
  /** briefly true after a movement that matched no taught sign */
  rejected?: boolean;
};

export const STATUS_TEXT: Record<RecognizerStatus, string> = {
  "no-hand": "No hand",
  "out-of-frame": "Hand partly out of view",
  "too-far": "Move your hand closer",
  moving: "Moving…",
  unsure: "Not sure. Hold still or adjust.",
  ok: "",
};

/** Hold-to-confirm ring with the candidate in the middle, a confidence bar, and an explicit "?" state. */
export default function HoldRing({ label, progress, confidence, status, rejected }: Props) {
  const r = 44;
  const circ = 2 * Math.PI * r;
  const unsure = !label || status === "unsure" || status === "out-of-frame" || status === "too-far";
  const shown = rejected ? "?" : unsure ? "?" : label;
  const lowConfidence = rejected || status === "unsure" || (status === "ok" && confidence < 0.6);
  const caption = rejected
    ? "Movement not recognized"
    : status === "ok"
      ? `${Math.round(confidence * 100)}% sure`
      : STATUS_TEXT[status];
  return (
    <div
      className="card pointer-events-none absolute top-3 right-3 flex w-28 flex-col items-center gap-2 p-3"
      role="status"
      aria-live="polite"
    >
      <svg width="72" height="72" viewBox="0 0 100 100" aria-hidden>
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--border)" strokeWidth="4" />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - (unsure ? 0 : progress))}
          transform="rotate(-90 50 50)"
        />
        <text
          x="50"
          y="50"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={shown && shown.length > 2 ? 17 : 44}
          fontWeight="500"
          fill={shown === "?" ? "var(--text-muted)" : "var(--text)"}
        >
          {shown ?? "?"}
        </text>
      </svg>
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-2" title="Confidence">
        <div
          className={`h-full rounded-full transition-[width] duration-150 ease-out ${lowConfidence ? "bg-warning" : "bg-accent"}`}
          style={{ width: `${Math.round(confidence * 100)}%` }}
        />
      </div>
      <span
        className={`flex items-start justify-center gap-1 text-center text-xs tabular-nums ${lowConfidence ? "text-warning" : "text-muted"}`}
      >
        {lowConfidence && <CircleHelp size={16} strokeWidth={1.5} aria-hidden className="shrink-0" />}
        {caption}
      </span>
    </div>
  );
}

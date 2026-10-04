"use client";

import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HAND_CONNECTIONS } from "@/lib/features";
import { motionFrames, representativeExample, signLabel, trackOf, type TaughtSign } from "@/lib/signs";

/** One playback of a motion sign (its examples are resampled, so the real speed isn't stored). */
const PLAY_MS = 1400;

type Frame = { wrist: { x: number; y: number }; shape: number[] };

const point = (f: Frame, i: number) => ({ x: f.wrist.x + f.shape[3 * i], y: f.wrist.y + f.shape[3 * i + 1] });

function Hand({ f, className, dot = 0 }: { f: Frame; className: string; dot?: number }) {
  return (
    <g className={className}>
      {HAND_CONNECTIONS.map(([a, b]) => {
        const p = point(f, a);
        const q = point(f, b);
        return (
          <line
            key={`${a}-${b}`}
            x1={p.x}
            y1={p.y}
            x2={q.x}
            y2={q.y}
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      {dot > 0 &&
        Array.from({ length: 21 }, (_, i) => {
          const p = point(f, i);
          return <circle key={i} cx={p.x} cy={p.y} r={dot} className="fill-accent" />;
        })}
    </g>
  );
}

/**
 * What a taught sign looks like, drawn from its most typical recorded example: the hand shape, and for a
 * motion sign the wrist's path (start dot, end arrow) with the hand moving along it. Shown as the user sees
 * themselves in the (mirrored) camera view.
 */
export default function SignPreview({ sign }: { sign: TaughtSign }) {
  const frames = useMemo<Frame[]>(() => {
    const ex = representativeExample(sign);
    return sign.kind === "motion"
      ? motionFrames(ex as number[][])
      : [{ wrist: { x: 0, y: 0 }, shape: ex as number[] }];
  }, [sign]);
  const motion = frames.length > 1;
  const last = frames.length - 1;

  const box = useMemo(() => {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const f of frames)
      for (let i = 0; i < 21; i++) {
        const p = point(f, i);
        [x0, y0, x1, y1] = [Math.min(x0, p.x), Math.min(y0, p.y), Math.max(x1, p.x), Math.max(y1, p.y)];
      }
    const pad = 0.25;
    const [w, h] = [x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
    // dot sizes follow the drawing's scale (a single held shape is zoomed in much further than a motion path)
    return { viewBox: `${x0 - pad} ${y0 - pad} ${w} ${h}`, unit: Math.max(w, h) };
  }, [frames]);

  const [at, setAt] = useState(last);
  const raf = useRef(0);
  const play = useCallback(() => {
    cancelAnimationFrame(raf.current);
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / PLAY_MS);
      setAt(Math.round(k * last));
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }, [last]);
  useEffect(() => {
    // Play once when opened, unless the user prefers reduced motion (then the path and final hand are shown).
    if (motion && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) play();
    return () => cancelAnimationFrame(raf.current);
  }, [motion, play]);

  // the point the sign is matched by: the wrist, or the drawing fingertip for J and Z
  const k = trackOf(sign);
  const path = frames
    .map((f) => {
      const p = point(f, k);
      return `${p.x},${p.y}`;
    })
    .join(" ");
  const start = point(frames[0], k);
  const label = signLabel(sign);
  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={box.viewBox}
        role="img"
        aria-label={`${label}: ${motion ? "recorded movement and hand shape" : "recorded hand shape, held still"}`}
        className="h-44 w-full rounded-control bg-surface-2"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <marker
            id={`arrow-${sign.id}`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" className="fill-accent" />
          </marker>
        </defs>
        {motion && (
          <>
            <Hand f={frames[0]} className="text-muted opacity-40" />
            <polyline
              points={path}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="text-accent"
              markerEnd={`url(#arrow-${sign.id})`}
            />
            <circle cx={start.x} cy={start.y} r={0.018 * box.unit} className="fill-accent" />
          </>
        )}
        <Hand f={frames[at]} className="text-text" dot={0.009 * box.unit} />
      </svg>
      <figcaption className="flex items-start justify-between gap-3 text-xs text-muted">
        <span>
          {motion
            ? `${k ? "Fingertip" : "Wrist"} path from the dot to the arrow; the faint hand is where it starts.`
            : "Hold this shape still."}{" "}
          As you see yourself in the camera, from your most typical example.
        </span>
        {motion && (
          <button onClick={play} className="btn btn-ghost h-8 shrink-0 px-2 text-xs">
            <RotateCcw size={14} strokeWidth={1.5} aria-hidden />
            Replay
          </button>
        )}
      </figcaption>
    </figure>
  );
}

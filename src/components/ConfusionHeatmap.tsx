"use client";

import { useState } from "react";
import type { Confusion } from "@/lib/evaluation";

/**
 * Letter confusion matrix as a heatmap: rows = intended letter, columns = what was recognized,
 * cell = share of that letter's attempts. Sequential single-hue ramp mixed from the accent token into
 * the surface, so it follows light and dark mode; stepped (no gradients). Empty cells are unfilled.
 * Each cell has its own hover / focus tooltip.
 */
const STEPS = 8;
const step = (share: number) => Math.round(share * (STEPS - 1));
const fill = (share: number) =>
  `color-mix(in srgb, var(--accent) ${Math.round(12 + (88 * step(share)) / (STEPS - 1))}%, var(--surface))`;
/** Strong steps need the on-accent ink. */
const inkFor = (share: number) => (step(share) >= 4 ? "var(--accent-fg)" : "var(--text)");

export default function ConfusionHeatmap({ data }: { data: Confusion }) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const { rows, cols, counts } = data;
  if (rows.length === 0) return <p className="text-muted">No letter trials yet.</p>;
  const totals = counts.map((r) => r.reduce((a, b) => a + b, 0));

  return (
    <figure className="relative">
      <div className="card overflow-x-auto p-4">
        <table className="border-separate text-xs" style={{ borderSpacing: 2 }}>
          <thead>
            <tr>
              <th className="pr-2 text-left font-normal text-muted" scope="col">
                signed ↓ / seen →
              </th>
              {cols.map((c) => (
                <th key={c} scope="col" className="w-7 font-medium text-text">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r}>
                <th scope="row" className="pr-2 text-right font-medium text-text">
                  {r}
                </th>
                {cols.map((c, j) => {
                  const n = counts[i][j];
                  const share = totals[i] ? n / totals[i] : 0;
                  const label = `Signed ${r}, recognized ${c === "∅" ? "nothing" : c}: ${n} of ${totals[i]} (${Math.round(share * 100)}%)`;
                  return (
                    <td
                      key={c}
                      tabIndex={n ? 0 : -1}
                      aria-label={label}
                      onPointerMove={(e) => n && setTip({ x: e.clientX, y: e.clientY, text: label })}
                      onPointerLeave={() => setTip(null)}
                      onFocus={(e) => {
                        const b = e.currentTarget.getBoundingClientRect();
                        setTip({ x: b.right, y: b.top, text: label });
                      }}
                      onBlur={() => setTip(null)}
                      className={`h-7 w-7 text-center tabular-nums ${
                        n ? "" : "outline outline-1 -outline-offset-1 outline-border"
                      } ${r === c ? "ring-2 ring-inset ring-text/40" : ""}`}
                      style={n ? { background: fill(share), color: inkFor(share) } : undefined}
                    >
                      {n || ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>Share of each letter&apos;s attempts:</span>
        <span>0%</span>
        <span aria-hidden className="flex gap-1">
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <span key={v} className="h-3 w-4" style={{ background: fill(v) }} />
          ))}
        </span>
        <span>100%</span>
        <span>Outlined cells are the correct letter. ∅ means nothing was recognized in time.</span>
      </figcaption>
      {tip && (
        <div
          role="tooltip"
          className="card pointer-events-none fixed z-50 px-2 py-1 text-xs shadow-popover"
          style={{ left: tip.x + 12, top: tip.y + 12 }}
        >
          {tip.text}
        </div>
      )}
    </figure>
  );
}

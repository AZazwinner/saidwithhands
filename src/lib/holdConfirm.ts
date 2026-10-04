/**
 * Turns a noisy per-frame stream of candidates into deliberate accepted tokens.
 * Pure: time is passed in. Design adapted from signscribe's "composer" (MIT, credited in the README).
 *
 *  - A label is accepted when it stays top-1 with p >= threshold AND leads the runner-up by >= margin
 *    for holdMs. Otherwise the state is "not sure" and nothing is typed.
 *  - Brief dips (< graceMs) below threshold or to another label don't reset the hold.
 *  - Fast hand movement resets progress (hand "in transit").
 *  - After accepting, the same label is accepted again only after re-arming: the label changes,
 *    the hand leaves, or the hand moves (ASL double letters slide slightly). Holding still never
 *    repeats a letter unless repeatMs is set (default: never).
 *  - Each accepted token carries the top-3 candidates averaged over the hold window.
 */
import type { Candidate } from "./letterModel";

export type HoldConfig = {
  holdMs: number;
  threshold: number;
  /** minimum lead of top-1 over top-2 */
  margin: number;
  /**
   * Letter sets a front camera can't reliably tell apart (thumb hidden). Within a set, confidence and
   * margin use the set's combined probability, so "M or N" can still be typed; the token keeps both
   * candidates and context (Step 4, Gemini) picks.
   */
  ambiguous: readonly (readonly string[])[];
  graceMs: number;
  repeatMs: number;
};

export const DEFAULT_HOLD: HoldConfig = {
  holdMs: 700,
  threshold: 0.6,
  margin: 0.2,
  ambiguous: [
    ["M", "N"],
    ["A", "S", "T", "E"],
  ],
  graceMs: 150,
  repeatMs: Infinity,
};

export type Accepted = { v: string; t: number; candidates: Candidate[] };

export type HoldUpdate = {
  /** label currently being held (or null) */
  label: string | null;
  /** 0..1 progress of the hold-to-confirm ring */
  progress: number;
  /** set on the frame a token is accepted */
  accepted: Accepted | null;
};

export class HoldToConfirm {
  private label: string | null = null;
  private since = 0;
  private lastGood = 0;
  private armed = true;
  private lastAccepted: string | null = null;
  private acceptedAt = -Infinity;
  private sums = new Map<string, number>();
  private frames = 0;

  constructor(private cfg: HoldConfig = DEFAULT_HOLD) {}

  reset(rearm = true): void {
    this.label = null;
    this.sums.clear();
    this.frames = 0;
    if (rearm) this.armed = true;
  }

  /** Treat `label` as just accepted (e.g. the user corrected the last letter to it): no re-typing it while held. */
  markAccepted(label: string, t: number): void {
    this.lastAccepted = label;
    this.acceptedAt = t;
    this.armed = false;
  }

  update(t: number, cands: Candidate[] | null, moving = false): HoldUpdate {
    const { holdMs, threshold, margin, graceMs, repeatMs, ambiguous } = this.cfg;
    if (!cands || cands.length === 0 || moving) {
      this.reset(true);
      return { label: null, progress: 0, accepted: null };
    }
    const top = cands[0];
    const set = ambiguous.find((g) => g.includes(top.v));
    const inSet = (v: string) => (set ? set.includes(v) : v === top.v);
    const mass = cands.filter((c) => inSet(c.v)).reduce((a, c) => a + c.p, 0);
    const rival = cands.find((c) => !inSet(c.v))?.p ?? 0;
    const good = mass >= threshold && mass - rival >= margin;

    const isCurrent = this.label !== null && top.v === this.label;
    if (good && isCurrent) {
      this.lastGood = t;
    } else if (good) {
      // A different confident label: switch only once the current one has been gone for graceMs,
      // so single-frame flicker doesn't reset the hold.
      if (this.label === null || t - this.lastGood > graceMs) {
        this.label = top.v;
        this.since = t;
        this.lastGood = t;
        this.sums.clear();
        this.frames = 0;
        if (top.v !== this.lastAccepted) this.armed = true;
      }
    } else if (this.label !== null && t - this.lastGood > graceMs) {
      this.reset(false);
      return { label: null, progress: 0, accepted: null };
    }
    if (this.label === null) return { label: null, progress: 0, accepted: null };

    // Accumulate candidate scores over the hold window (frames where this label leads, or grace frames)
    this.frames++;
    for (const c of cands) this.sums.set(c.v, (this.sums.get(c.v) ?? 0) + c.p);

    if (!this.armed) {
      if (t - this.acceptedAt >= repeatMs) {
        this.armed = true;
        this.since = t;
        this.sums.clear();
        this.frames = 0;
      }
      return { label: this.label, progress: 0, accepted: null };
    }

    const progress = Math.min(1, (t - this.since) / holdMs);
    if (progress < 1) return { label: this.label, progress, accepted: null };

    const candidates = [...this.sums.entries()]
      .map(([v, s]) => ({ v, p: s / this.frames }))
      .sort((a, b) => b.p - a.p)
      .slice(0, 3);
    const accepted: Accepted = { v: this.label, t, candidates };
    this.armed = false;
    this.lastAccepted = this.label;
    this.acceptedAt = t;
    this.sums.clear();
    this.frames = 0;
    return { label: this.label, progress: 1, accepted };
  }
}

/** Mean of the last `size` probability vectors. */
export class ProbSmoother {
  private buf: number[][] = [];
  constructor(private size = 6) {}
  reset(): void {
    this.buf = [];
  }
  push(probs: readonly number[]): number[] {
    this.buf.push(probs.slice());
    if (this.buf.length > this.size) this.buf.shift();
    const out = new Array<number>(probs.length).fill(0);
    for (const p of this.buf) for (let i = 0; i < p.length; i++) out[i] += p[i] / this.buf.length;
    return out;
  }
}

/**
 * Cuts the continuous frame stream into candidate motion segments: a segment starts when the wrist
 * speeds up and ends when the hand comes to rest (or leaves the frame). Completed segments are then
 * matched against taught motion signs with DTW. Pure, time passed in.
 *
 * People sign continuously, so a segment can also hold a false start or a transition before the sign, or
 * two signs with no rest between them. The recognizer therefore searches each segment for the sign (any start
 * point), and the segmenter also reports the segment at every marked slow-down ("dip") while the hand is
 * still moving, so a sign that ends there can be accepted without waiting for a rest; see `dropBefore`.
 */
import type { MotionFrame } from "./signs";

export type SegmenterConfig = {
  /** hand-sizes/s to start a segment */
  startSpeed: number;
  /** hand-sizes/s below which the hand counts as resting */
  stopSpeed: number;
  /** rest this long to end a segment */
  stopMs: number;
  minMs: number;
  /** only the most recent this-many ms of a long movement are kept */
  maxMs: number;
  /** frames kept from before the start (the movement begins slightly before speed crosses the threshold) */
  preRoll: number;
  /** a dip: speed falls below this fraction of the peak since the last dip */
  dipFraction: number;
};

export const DEFAULT_SEGMENTER: SegmenterConfig = {
  startSpeed: 1.2,
  stopSpeed: 0.6,
  stopMs: 75,
  minMs: 250,
  maxMs: 3500,
  preRoll: 4,
  dipFraction: 0.65,
};

/** `final`: the hand came to rest or left (`left`); otherwise a slow-down while still moving. */
export type SegmentEvent = { frames: MotionFrame[]; final: boolean; left?: boolean };

export class MotionSegmenter {
  private buf: MotionFrame[] = [];
  private seg: MotionFrame[] | null = null;
  private stillSince: number | null = null;
  /** dip detection: the peak speed since the last dip, whether a new dip may fire, and the speed at the last dip */
  private peak = 0;
  private armed = false;
  private dipSpeed = 0;
  /** how many segments have started (identifies the current/last movement) */
  started = 0;

  constructor(private cfg: SegmenterConfig = DEFAULT_SEGMENTER) {}

  get active(): boolean {
    return this.seg !== null;
  }

  reset(): void {
    this.buf = [];
    this.seg = null;
    this.stillSince = null;
    this.peak = 0;
    this.armed = false;
  }

  /** A sign was found ending at time `t` mid-movement: forget what came before, so the next sign starts there. */
  dropBefore(t: number): void {
    if (this.seg) this.seg = this.seg.filter((f) => f.t >= t);
  }

  /** Feed one frame (null = no hand). Returns a segment to match (at a rest or a dip), or null. */
  push(frame: MotionFrame | null, speed: number): SegmentEvent | null {
    const { startSpeed, stopSpeed, stopMs, maxMs, preRoll, dipFraction } = this.cfg;
    if (!frame) {
      const done = this.seg ? this.finish(this.seg, true) : null;
      this.reset();
      return done && { ...done, left: true };
    }
    if (!this.seg) {
      this.buf.push(frame);
      if (this.buf.length > preRoll) this.buf.shift();
      if (speed > startSpeed) {
        this.started++;
        this.seg = this.buf.slice();
        this.stillSince = null;
        this.peak = speed;
        this.armed = true;
      }
      return null;
    }
    this.seg.push(frame);
    // A long movement keeps only its most recent part (e.g. continuous fingerspelling movement).
    while (this.seg.length > 1 && frame.t - this.seg[0].t > maxMs) this.seg.shift();
    if (speed < stopSpeed) {
      this.stillSince ??= frame.t;
      if (frame.t - this.stillSince >= stopMs) {
        const seg = this.seg.filter((f) => f.t <= this.stillSince!);
        this.reset();
        this.buf = [frame];
        return this.finish(seg, true);
      }
      return null;
    }
    this.stillSince = null;
    if (speed > this.peak) this.peak = speed;
    if (!this.armed && speed >= Math.max(startSpeed, 2 * this.dipSpeed)) this.armed = true;
    if (this.armed && speed < dipFraction * this.peak) {
      this.armed = false;
      this.dipSpeed = speed;
      this.peak = speed;
      return this.finish(this.seg.slice(), false);
    }
    return null;
  }

  private finish(seg: MotionFrame[], final: boolean): SegmentEvent | null {
    if (seg.length < 4) return null;
    const dur = seg[seg.length - 1].t - seg[0].t;
    return dur >= this.cfg.minMs ? { frames: seg, final } : null;
  }
}

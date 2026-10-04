/**
 * User-taught signs: few-shot nearest-neighbor matching with per-sign rejection thresholds, so an
 * unknown movement is rejected ("I don't know") instead of guessed. No training step. Pure, no DOM.
 *
 *  - Handshape signs: each example is the mean canonical landmark vector (features.ts) while held.
 *  - Motion signs: each example is a fixed-length sequence of [wrist trajectory, handshape] frames,
 *    matched with DTW (dtw.ts).
 */
import { dtw, resample } from "./dtw";
import { euclidean, needsFlip, type Hand, type Landmark } from "./features";
import type { Candidate } from "./letterModel";

export type SignKind = "handshape" | "motion";
/** A taught sign either types its meaning, or acts like the Space or Delete key. */
export type SignAction = "space" | "delete";
/**
 * `limit` (optional) fixes the rejection limit instead of deriving it from the examples; used by the starter
 * Delete sign, whose derived limit also took in the letter B.
 */
export type TaughtSign =
  | { id: string; meaning: string; kind: "handshape"; examples: number[][]; action?: SignAction; limit?: number }
  | {
      id: string;
      meaning: string;
      kind: "motion";
      examples: number[][][];
      action?: SignAction;
      limit?: number;
      /** landmark whose path is matched (default: the wrist, or the drawing fingertip for J and Z) */
      track?: number;
    };

/** A sign named "LETTER J" (any single letter) types that letter instead of the words. */
export function signLetter(s: Pick<TaughtSign, "meaning">): string | null {
  return /^LETTER ([A-Z])$/.exec(s.meaning)?.[1] ?? null;
}

/**
 * J and Z are drawn by a fingertip while the wrist barely moves (a little drift, much like lowering the hand):
 * J by the pinky tip (landmark 20), Z by the index tip (8). Measured on the owner's recordings, following the
 * index tip cut simulated hand drops accepted as Z from 21/33 to 6/33.
 */
const LETTER_TRACK: Record<string, number> = { J: 20, Z: 8 };
export function trackOf(s: TaughtSign): number {
  if (s.kind !== "motion") return 0;
  return s.track ?? LETTER_TRACK[signLetter(s) ?? ""] ?? 0;
}

/** A motion sequence following landmark `k` instead of the wrist (its path relative to its start). */
export function trackSequence(seq: readonly number[][], k: number): number[][] {
  if (!k) return seq as number[][];
  const at = (f: readonly number[]) => [f[0] + f[2 + 3 * k] / SHAPE_W, f[1] + f[2 + 3 * k + 1] / SHAPE_W];
  const [x0, y0] = at(seq[0]);
  return seq.map((f) => {
    const [x, y] = at(f);
    return [x - x0, y - y0, ...f.slice(2)];
  });
}

/** Fixed names for key signs (one of each per library; teaching again replaces it). */
export const ACTION_MEANING: Record<SignAction, string> = { space: "[SPACE]", delete: "[DELETE]" };
const ACTION_LABEL: Record<SignAction, string> = { space: "Space key", delete: "Delete key" };
/** What to show for a sign: its meaning, or the key it acts as. */
export const signLabel = (s: Pick<TaughtSign, "meaning" | "action">) => (s.action ? ACTION_LABEL[s.action] : s.meaning);
export type SignLibraryJson = { version: 1; signs: TaughtSign[] };

export const MOTION_LEN = 24;
/** Weight of the handshape part of a motion frame relative to the trajectory (in hand sizes). */
export const SHAPE_W = 0.35;

/** One tracked frame, as needed for motion signs. */
export type MotionFrame = { t: number; shape: number[]; wrist: Landmark; size: number; hand: Hand };

/**
 * Rejection limits (canonical-feature / DTW distance). A taught handshape is the MEAN of ~1.6 s of frames,
 * but it is matched against live frames, which are noisier than any mean. The handshape floor therefore
 * has to sit above single-frame landmark jitter, or a correctly repeated sign is never accepted
 * (found by scripts/sim-teach.mts: 1 of 30 simulated trials accepted at the old 0.18 floor).
 */
export const THRESHOLDS = {
  handshape: { min: 0.28, max: 0.6, factor: 1.6 },
  motion: { min: 0.21, max: 0.6, factor: 1.6 },
} as const;

/** Mean of handshape feature vectors (drops the first 20% of frames, when the hand is still settling). */
export function handshapeExample(shapes: readonly number[][]): number[] {
  if (shapes.length === 0) throw new Error("no frames");
  const use = shapes.slice(Math.floor(shapes.length * 0.2));
  const out = new Array<number>(use[0].length).fill(0);
  for (const s of use) for (let i = 0; i < s.length; i++) out[i] += s[i] / use.length;
  return out;
}

/**
 * Frames apart when measuring movement. Frame-to-frame differences are mostly landmark jitter on a still
 * hand (under a pixel of jitter adds up to ~1 hand size of "path" over 1.6 s); over 3 frames real
 * movement adds up while jitter doesn't.
 */
const STRIDE = 3;

/** Wrist path length in hand sizes (used to auto-detect handshape vs motion when teaching). */
export function pathLength(frames: readonly MotionFrame[]): number {
  let len = 0;
  for (let i = STRIDE; i < frames.length; i += STRIDE) {
    const a = frames[i - STRIDE].wrist;
    const b = frames[i].wrist;
    len += Math.hypot(b.x - a.x, b.y - a.y) / Math.max(frames[i].size, 1e-6);
  }
  return len;
}

/**
 * Frames -> fixed-length motion sequence. Trajectory is relative to the first frame, in hand sizes,
 * x mirrored into canonical space (so left- and right-handed signers match).
 */
export function motionSequence(frames: readonly MotionFrame[], len = MOTION_LEN): number[][] {
  if (frames.length === 0) throw new Error("no frames");
  const first = frames[0];
  const flip = needsFlip(first.hand, false) ? -1 : 1;
  const size = frames.reduce((a, f) => a + f.size, 0) / frames.length || 1;
  const raw = frames.map((f) => [
    (flip * (f.wrist.x - first.wrist.x)) / size,
    (f.wrist.y - first.wrist.y) / size,
    ...f.shape.map((v) => v * SHAPE_W),
  ]);
  return resample(raw, len);
}

/**
 * Trim still frames at the start and end of a recording, keeping the active movement
 * (frames whose speed exceeds `minSpeed` hand-sizes/s) plus a little padding.
 */
export function trimToMotion(frames: readonly MotionFrame[], minSpeed = 0.8, pad = 2): MotionFrame[] {
  if (frames.length < 4) return frames.slice();
  // Speed over STRIDE frames centred on each frame, so landmark jitter doesn't count as movement.
  const h = Math.floor(STRIDE / 2);
  const speed = frames.map((f, i) => {
    const a = frames[Math.max(0, i - h - (STRIDE % 2))];
    const b = frames[Math.min(frames.length - 1, i + h)];
    const dt = (b.t - a.t) / 1000 || 1 / 30;
    return Math.hypot(b.wrist.x - a.wrist.x, b.wrist.y - a.wrist.y) / Math.max(f.size, 1e-6) / dt;
  });
  const first = speed.findIndex((s) => s > minSpeed);
  let last = -1;
  for (let i = speed.length - 1; i >= 0; i--) if (speed[i] > minSpeed) { last = i; break; } // prettier-ignore
  if (first < 0 || last - first < 3) return frames.slice();
  return frames.slice(Math.max(0, first - 1 - pad), Math.min(frames.length, last + 1 + pad));
}

/**
 * Motion signs also carry: `track` (landmark followed), `scaled` (examples following it, path already scaled
 * by scaleTrajectory, for fast matching) and `path` (median path length of the examples, in hand sizes).
 */
type Compiled = { sign: TaughtSign; threshold: number; scaled?: number[][][]; track?: number; path?: number };

export type SignMatch = {
  candidates: Candidate[];
  best: { meaning: string; d: number; threshold: number } | null;
};

export type SignLibrary = {
  signs: TaughtSign[];
  thresholds: Record<string, number>;
  matchHandshape: (shape: readonly number[]) => SignMatch;
  matchMotion: (seq: readonly number[][]) => SignMatch;
  /** median path length (hand sizes, of the tracked point) of each motion sign's examples, by meaning */
  motionPaths: Record<string, number>;
  hasMotion: boolean;
  hasHandshape: boolean;
};

/** Wrist path length (hand sizes) of a motion sequence (its first two columns). */
export function sequencePath(seq: readonly number[][]): number {
  let len = 0;
  for (let i = 1; i < seq.length; i++) len += Math.hypot(seq[i][0] - seq[i - 1][0], seq[i][1] - seq[i - 1][1]);
  return len;
}

/** RMS spread of the wrist path after scaling (hand sizes; about what a typical sign had unscaled). */
const TRAJ_RMS = 0.6;

/**
 * Scale the wrist path (first two columns) to a fixed spread, so a motion sign is matched by the SHAPE
 * of its movement, not its size: the same sign made 20% bigger or smaller than when taught was often
 * rejected (scripts/sim-motion.mts). Applied when matching, so already-taught signs benefit too.
 */
export function scaleTrajectory(seq: readonly number[][]): number[][] {
  const n = seq.length;
  const cx = seq.reduce((a, f) => a + f[0], 0) / n;
  const cy = seq.reduce((a, f) => a + f[1], 0) / n;
  const rms = Math.sqrt(seq.reduce((a, f) => a + (f[0] - cx) ** 2 + (f[1] - cy) ** 2, 0) / n);
  if (rms < 1e-6) return seq.map((f) => f.slice());
  const k = TRAJ_RMS / rms;
  return seq.map((f) => [f[0] * k, f[1] * k, ...f.slice(2)]);
}

/** Most a held shape is turned to line up with a taught example (radians), per axis. */
export const MAX_TILT = (25 * Math.PI) / 180;

/** Rotate canonical landmarks about the wrist in the plane of coordinates (u, v) of each landmark. */
function rotatePlane(q: number[], u: 0 | 1 | 2, v: 0 | 1 | 2, ex: readonly number[]): number[] {
  // Angle that best lines q up with ex in this plane (closed form), limited to MAX_TILT.
  let dot = 0;
  let cross = 0;
  for (let i = 0; i < q.length; i += 3) {
    dot += q[i + u] * ex[i + u] + q[i + v] * ex[i + v];
    cross += q[i + u] * ex[i + v] - q[i + v] * ex[i + u];
  }
  const th = Math.max(-MAX_TILT, Math.min(MAX_TILT, Math.atan2(cross, dot)));
  const c = Math.cos(th);
  const s = Math.sin(th);
  const out = q.slice();
  for (let i = 0; i < q.length; i += 3) {
    out[i + u] = q[i + u] * c - q[i + v] * s;
    out[i + v] = q[i + u] * s + q[i + v] * c;
  }
  return out;
}

/**
 * Handshape distance after tilting `q` by up to MAX_TILT to match `ex`: in the image plane (x, y) and
 * toward/away from the camera (x, z). Holding the same shape a few degrees differently than when taught
 * moved every landmark and was rejected (scripts/sim-teach.mts: ~2/3 accepted at 10 degrees of variation).
 * Larger turns still count, so e.g. thumbs-up and thumbs-down stay different signs.
 */
export function handshapeDistance(q: readonly number[], ex: readonly number[]): number {
  const aligned = (v: number[]) => euclidean(rotatePlane(rotatePlane(v, 0, 1, ex), 0, 2, ex), ex);
  // Also try the mirror image (x -> -x): what a hand gets when the tracker labels it as the other hand,
  // which happens for long stretches on a hand seen edge-on. One signing hand, so a sign and its mirror
  // image can't be different signs.
  return Math.min(aligned(q.slice()), aligned(q.map((v, i) => (i % 3 === 0 ? -v : v))));
}

const distance = (kind: SignKind, a: unknown, b: unknown) =>
  kind === "handshape"
    ? handshapeDistance(a as number[], b as number[])
    : dtw(scaleTrajectory(a as number[][]), scaleTrajectory(b as number[][]));

/** The most typical example (smallest total distance to the others), e.g. to show the user. */
export function representativeExample(sign: TaughtSign): number[] | number[][] {
  const ex = sign.examples as unknown[];
  let best = 0;
  let bestSum = Infinity;
  for (let i = 0; i < ex.length; i++) {
    let sum = 0;
    for (let j = 0; j < ex.length; j++) if (j !== i) sum += distance(sign.kind, ex[i], ex[j]);
    if (sum < bestSum) [best, bestSum] = [i, sum];
  }
  return ex[best] as number[] | number[][];
}

/**
 * A stored motion example as drawable frames: wrist offset from the start and the canonical hand shape, both
 * in hand sizes (the hand's farthest landmark is 1 from the wrist), in the mirrored "selfie" view.
 */
export function motionFrames(seq: readonly number[][]): { wrist: { x: number; y: number }; shape: number[] }[] {
  return seq.map((f) => ({ wrist: { x: f[0], y: f[1] }, shape: f.slice(2).map((v) => v / SHAPE_W) }));
}

/**
 * Per-sign rejection threshold from its own examples: factor × the largest leave-one-out
 * nearest-neighbor distance, clamped to [min, max]. Consistent examples -> tight threshold.
 */
export function signThreshold(sign: TaughtSign): number {
  if (sign.limit !== undefined) return sign.limit;
  const cfg = THRESHOLDS[sign.kind];
  const ex: unknown[] =
    sign.kind === "motion" ? sign.examples.map((e) => trackSequence(e, trackOf(sign))) : sign.examples;
  if (ex.length < 2) return cfg.min;
  const nns: number[] = [];
  for (let i = 0; i < ex.length; i++) {
    let nn = Infinity;
    for (let j = 0; j < ex.length; j++) if (j !== i) nn = Math.min(nn, distance(sign.kind, ex[i], ex[j]));
    nns.push(nn);
  }
  nns.sort((a, b) => a - b);
  // Motion: the 80th percentile, so one sloppy recording out of 10 can't loosen the limit for everything (the
  // owner's Z: typical 0.24-0.35, one at 0.59, which set a 0.95 limit that hand drops fell inside). With 5
  // examples this is still the worst one. Handshape: the worst (a deliberately different pose, like the Space
  // photo, must widen the limit).
  const ref = sign.kind === "motion" ? nns[Math.min(nns.length - 1, Math.floor(0.8 * nns.length))] : nns[nns.length - 1];
  return Math.min(cfg.max, Math.max(cfg.min, ref * cfg.factor));
}

/**
 * Confidence of a handshape match from d / threshold (< 1 inside the rejection limit). Anything inside
 * the limit scores at least 0.6, which is what hold-to-confirm needs, and the score still falls toward
 * the boundary. (A linear 1 - d/threshold only reached 0.6 in the inner 40% of the limit.)
 */
export function handshapeScore(ratio: number): number {
  return Math.max(0, 1 - 0.4 * ratio * ratio);
}

function match(compiled: Compiled[], query: unknown, kind: SignKind): SignMatch {
  const scored: { meaning: string; d: number; threshold: number }[] = [];
  // motion: the query following each tracked point (wrist or fingertip), unscaled for the length check
  const tracked = new Map<number, { scaled: number[][]; path: number }>();
  for (const { sign, threshold, scaled, track, path } of compiled) {
    if (sign.kind !== kind) continue;
    let d = Infinity;
    if (kind === "motion") {
      let q = tracked.get(track!);
      if (!q) {
        const seq = trackSequence(query as number[][], track!);
        q = { scaled: scaleTrajectory(seq), path: sequencePath(seq) };
        tracked.set(track!, q);
      }
      // Paths are compared by shape, not size, so the length must be plausible: 0.5-2x the sign's usual one
      // (otherwise e.g. the tail of a long movement could pass for a whole small sign).
      if (q.path >= 0.5 * path! && q.path <= 2 * path!) for (const ex of scaled!) d = Math.min(d, dtw(q.scaled, ex));
    } else for (const ex of sign.examples as number[][]) d = Math.min(d, handshapeDistance(query as number[], ex));
    scored.push({ meaning: sign.meaning, d, threshold });
  }
  scored.sort((a, b) => a.d / a.threshold - b.d / b.threshold);
  const candidates = scored
    .filter((s) => s.d < s.threshold)
    .slice(0, 3)
    .map((s) => ({ v: s.meaning, p: handshapeScore(s.d / s.threshold) }));
  return { candidates, best: scored[0] ?? null };
}

export function buildLibrary(signs: readonly TaughtSign[]): SignLibrary {
  const motionPaths: Record<string, number> = {};
  const compiled: Compiled[] = signs.map((sign) => {
    if (sign.kind !== "motion") return { sign, threshold: signThreshold(sign) };
    const track = trackOf(sign);
    const ex = sign.examples.map((e) => trackSequence(e, track));
    const ps = ex.map(sequencePath).sort((a, b) => a - b);
    const path = ps[Math.floor(ps.length / 2)];
    motionPaths[sign.meaning] = path;
    return { sign, threshold: signThreshold(sign), scaled: ex.map(scaleTrajectory), track, path };
  });
  return {
    signs: signs.slice(),
    thresholds: Object.fromEntries(compiled.map((c) => [c.sign.id, c.threshold])),
    matchHandshape: (shape) => match(compiled, shape, "handshape"),
    matchMotion: (seq) => match(compiled, seq, "motion"),
    motionPaths,
    hasMotion: signs.some((s) => s.kind === "motion"),
    hasHandshape: signs.some((s) => s.kind === "handshape"),
  };
}

/** Normalizes a typed meaning: trimmed, collapsed spaces, upper case. Single letters are reserved. */
export function normalizeMeaning(s: string): string {
  return s.trim().replace(/\s+/g, " ").toUpperCase();
}

export function isValidMeaning(s: string): boolean {
  const m = normalizeMeaning(s);
  return m.length >= 2 && m.length <= 60;
}

export function isSignLibraryJson(x: unknown): x is SignLibraryJson {
  if (!x || typeof x !== "object" || (x as SignLibraryJson).version !== 1) return false;
  const signs = (x as SignLibraryJson).signs;
  const isVec = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((n) => Number.isFinite(n));
  return (
    Array.isArray(signs) &&
    signs.every(
      (s) =>
        s &&
        typeof s.id === "string" &&
        typeof s.meaning === "string" &&
        Array.isArray(s.examples) &&
        s.examples.length > 0 &&
        (s.action === undefined || s.action === "space" || s.action === "delete") &&
        (s.limit === undefined || (Number.isFinite(s.limit) && s.limit > 0 && s.limit <= 2)) &&
        (!("track" in s) || s.track === undefined || (Number.isInteger(s.track) && s.track >= 0 && s.track < 21)) &&
        (s.kind === "handshape"
          ? s.examples.every(isVec)
          : s.kind === "motion" && s.examples.every((seq) => Array.isArray(seq) && seq.every(isVec))),
    )
  );
}

/** Merge imported signs into a library; signs with the same meaning are replaced. */
export function mergeSigns(existing: readonly TaughtSign[], incoming: readonly TaughtSign[]): TaughtSign[] {
  const byMeaning = new Map(existing.map((s) => [normalizeMeaning(s.meaning), s]));
  for (const s of incoming)
    byMeaning.set(normalizeMeaning(s.meaning), { ...s, meaning: normalizeMeaning(s.meaning) });
  return [...byMeaning.values()];
}

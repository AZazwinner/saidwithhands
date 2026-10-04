/**
 * Per-frame recognition pipeline. Pure, with no DOM/MediaPipe imports, so it's testable with
 * synthetic frames.
 *
 * Letters:  landmarks -> canonical features -> letter MLP
 *           -> geometry rules re-rank look-alike groups -> geometry plausibility ("I don't know" mass)
 *           -> team seed k-NN (recorded letters, if shipped) -> personal calibration k-NN -> smoothing
 * Handshape signs: canonical features -> nearest taught example with per-sign rejection threshold
 * Both feed hold-to-confirm (threshold + margin over runner-up, motion gate, no repeat while held).
 * Motion signs: wrist speed segments the stream; each completed movement is DTW-matched against taught
 *   motion signs and accepted immediately, or rejected if it matches nothing.
 */
import { euclidean, handSize, handSpeed, normalizeLandmarks, palmCenter, type Hand, type Landmark } from "./features";
import { extractGeometry, geometryVector, rollFromImage } from "./handGeometry";
import { applyPlausibility, refineWithRules } from "./letterRules";
import { refineWithCalibration, type Knn } from "./calibration";
import { DEFAULT_HOLD, HoldToConfirm, ProbSmoother, type HoldConfig, type HoldUpdate } from "./holdConfirm";
import { topK, type Candidate, type Classifier } from "./letterModel";
import {
  motionSequence,
  pathLength,
  trimToMotion,
  type MotionFrame,
  signLetter,
  type SignAction,
  type SignLibrary,
} from "./signs";
import { DEFAULT_SEGMENTER, MotionSegmenter, type SegmentEvent } from "./motionSegmenter";

export type FrameInput = {
  t: number;
  landmarks: Landmark[];
  hand: Hand;
  /** metric world landmarks; enables geometry rules + calibration */
  world?: Landmark[];
  aspect?: number;
} | null;

export type RecognizerOptions = {
  /** swap the handedness reported by the tracker (debug escape hatch) */
  swapHands: boolean;
  /** hand-sizes per second above which the hand counts as "in transit" */
  movingSpeed: number;
  /** restrict letters to this subset (null = all); disabled letters become "unknown" mass */
  enabledLetters: ReadonlySet<string> | null;
  /** re-rank look-alike letters and apply geometry plausibility */
  useRules: boolean;
  /** team seed k-NN from recorded letter datasets (null = none) */
  seed: Knn | null;
  /** personal calibration k-NN (null = none) */
  calibration: Knn | null;
  /** taught signs (null = none) */
  signs: SignLibrary | null;
  /** minimum wrist path (hand sizes) for a movement to be matched as a motion sign */
  minMotionPath: number;
  /** a motion match must lead the runner-up by this much */
  motionMargin: number;
  /** a motion sign starting within this many ms after a typed letter may replace it... */
  retractMs: number;
  /** ...if the movement started from (nearly) the same handshape (canonical feature distance) */
  retractShape: number;
  smoothFrames: number;
  hold: HoldConfig;
};

export const DEFAULT_RECOGNIZER: RecognizerOptions = {
  swapHands: false,
  movingSpeed: 1.5,
  enabledLetters: null,
  useRules: true,
  seed: null,
  calibration: null,
  signs: null,
  minMotionPath: 0.8,
  motionMargin: 0.15,
  retractMs: 1200,
  retractShape: 0.35,
  smoothFrames: 6,
  hold: DEFAULT_HOLD,
};

export type RecognizerStatus = "no-hand" | "out-of-frame" | "too-far" | "moving" | "unsure" | "ok";

export type AcceptedToken = {
  kind: "letter" | "sign";
  v: string;
  candidates: Candidate[];
  /**
   * Set on a motion sign that started from the handshape of a letter typed just before it: that letter
   * was really the sign's starting position and should be replaced by the sign.
   */
  retracts?: string;
  /** letters: geometry vectors from the frames just before acceptance (for learn-from-correction) */
  samples?: number[][];
  /** a sign taught as the Space or Delete key */
  action?: SignAction;
};

export type RecognizerOutput = {
  status: RecognizerStatus;
  /** smoothed top-3 for the current frame (letters and handshape signs; empty when no hand) */
  live: Candidate[];
  hold: HoldUpdate;
  moving: boolean;
  /** a token accepted this frame (held letter / handshape sign, or a completed motion sign) */
  accepted: AcceptedToken | null;
  /** a completed movement that matched no taught motion sign */
  motionRejected: boolean;
  /** for a completed movement: the closest taught motion sign, its distance and limit (null otherwise) */
  motionBest: { meaning: string; d: number; threshold: number } | null;
  /** canonical 63-dim landmark features (null when no hand) */
  features: number[] | null;
  /** invariant geometry vector for calibration (null without world landmarks) */
  geoVec: number[] | null;
  /** this frame in the form used for teaching motion signs */
  motionFrame: MotionFrame | null;
  /** the closest taught handshape sign and how far it is from the live (smoothed) shape; null if none */
  signBest: { meaning: string; d: number; threshold: number } | null;
};

const EDGE = 0.01;
/** frames of geometry kept per accepted letter for learn-from-correction */
const SAMPLE_FRAMES = 12;
const MIN_HAND_SIZE = 0.07;
/** weight of the previous smoothed shape when matching handshape signs (about the last 5 frames) */
const SHAPE_EMA = 0.7;
/**
 * The tracker's left/right label must disagree for this many frames in a row (~330 ms) before we believe
 * it. It flickers on a hand seen edge-on (flat hand held horizontally or vertically), and one wrong frame
 * mirrors the whole shape.
 */
const HAND_SWITCH_FRAMES = 10;
/** start points tried when searching a movement for a sign, every this many frames */
const SPOT_STEP = 2;
/** least wrist movement (hand sizes) for a stretch to be matched at all */
const SPOT_MIN_PATH = 0.4;
/** movement speed is the palm's displacement over at most this long (at least one frame back) */
export const PALM_WINDOW_MS = 75;

export class Recognizer {
  private smoother: ProbSmoother;
  private hold: HoldToConfirm;
  private segmenter = new MotionSegmenter();
  private signScores = new Map<string, number>();
  /** live shape smoothed like the taught examples (which are means), so single-frame jitter doesn't reject a good sign */
  private shapeEma: number[] | null = null;
  private prev: { t: number; landmarks: Landmark[] } | null = null;
  private speed = 0;
  /**
   * Palm positions of the last few frames. Movements are cut out by palm speed over PALM_WINDOW_MS rather than
   * frame to frame: landmark jitter of under a pixel made a resting fist read ~0.6 hand sizes/s, so a
   * movement often never "ended" and was dropped (scripts/sim-motion.mts).
   */
  private palmTrail: { t: number; x: number; y: number }[] = [];
  /** the hand's label while it stays in view, and how many frames in a row the tracker has said otherwise */
  private stickyHand: { hand: Hand; against: number } | null = null;
  /**
   * After a motion sign, don't type the resting handshape as a letter until a NEW movement starts (or the hand
   * leaves). A sign can be accepted at a slow-down while the hand is still moving, so "the hand moved" alone
   * isn't enough: the rest of that same movement mustn't lift it.
   */
  private suppressHold = false;
  private suppressSegment = -1;
  /** the last typed letter, in case a motion sign turns out to have started from its handshape */
  private lastLetter: { t: number; v: string; features: number[] } | null = null;
  /** recent geometry vectors, so a letter the user later corrects can be learned from */
  private recentGeo: number[][] = [];
  private signMeanings: Set<string>;
  private signActions: Map<string, SignAction>;
  /** signs named "LETTER J" etc.: meaning -> the letter they type */
  private signLetters: Map<string, string>;
  readonly opts: RecognizerOptions;

  constructor(
    private letters: Classifier,
    opts: Partial<RecognizerOptions> = {},
  ) {
    this.opts = { ...DEFAULT_RECOGNIZER, ...opts };
    this.smoother = new ProbSmoother(this.opts.smoothFrames);
    this.hold = new HoldToConfirm(this.opts.hold);
    this.signMeanings = new Set(this.opts.signs?.signs.map((s) => s.meaning) ?? []);
    this.signActions = new Map(
      (this.opts.signs?.signs ?? []).flatMap((s) => (s.action ? [[s.meaning, s.action] as const] : [])),
    );
    this.signLetters = new Map(
      (this.opts.signs?.signs ?? []).flatMap((s) => {
        const l = signLetter(s);
        return l ? [[s.meaning, l] as const] : [];
      }),
    );
  }

  /**
   * Start fresh for a new prompt (e.g. an evaluation trial): a letter or sign already being held may be
   * accepted again, and nothing typed earlier can be replaced.
   */
  rearm(): void {
    this.hold.reset(true);
    this.suppressHold = false;
    this.lastLetter = null;
    this.smoother.reset();
    this.signScores.clear();
    this.shapeEma = null;
  }

  /** The user corrected the last letter to `v`: don't type `v` again while the same handshape is held. */
  noteCorrection(v: string, now: number): void {
    this.hold.markAccepted(v, now);
  }

  process(frame: FrameInput, now = frame?.t ?? 0): RecognizerOutput {
    const empty = {
      live: [] as Candidate[],
      moving: false,
      accepted: null as AcceptedToken | null,
      motionRejected: false,
      motionBest: null,
      features: null,
      geoVec: null,
      motionFrame: null,
      signBest: null,
    };
    if (!frame) {
      this.prev = null;
      this.speed = 0;
      this.palmTrail = [];
      this.stickyHand = null;
      this.suppressHold = false;
      this.smoother.reset();
      this.signScores.clear();
      this.shapeEma = null;
      const motion = this.finishMotion(this.segmenter.push(null, 0));
      this.lastLetter = null;
      this.recentGeo = [];
      return { ...empty, ...motion, status: "no-hand", hold: this.hold.update(now, null) };
    }

    const sticky = this.updateHand(frame.hand);
    const hand: Hand = this.opts.swapHands ? (sticky === "Left" ? "Right" : "Left") : sticky;
    const features = normalizeLandmarks(frame.landmarks, hand);
    const aspect = frame.aspect ?? 4 / 3;
    const size = handSize(frame.landmarks);

    if (this.prev) {
      const s = handSpeed(this.prev.landmarks, this.prev.t, frame.landmarks, frame.t);
      this.speed = 0.5 * this.speed + 0.5 * s;
    }
    this.prev = { t: frame.t, landmarks: frame.landmarks };
    const moving = this.speed > this.opts.movingSpeed;
    if (moving && this.segmenter.started !== this.suppressSegment) this.suppressHold = false;

    const w = frame.landmarks[0];
    const motionFrame: MotionFrame = {
      t: frame.t,
      shape: features,
      wrist: { x: w.x * aspect, y: w.y, z: w.z },
      size,
      hand,
    };
    const palm = palmCenter(frame.landmarks);
    this.palmTrail.push({ t: frame.t, ...palm });
    while (this.palmTrail.length > 2 && frame.t - this.palmTrail[0].t > PALM_WINDOW_MS) this.palmTrail.shift();
    const p0 = this.palmTrail[0];
    const dt = (frame.t - p0.t) / 1000;
    const palmSpeed = dt > 0 ? Math.hypot(palm.x - p0.x, palm.y - p0.y) / Math.max(size, 1e-6) / dt : 0;
    const motion = this.opts.signs?.hasMotion
      ? this.finishMotion(this.segmenter.push(motionFrame, palmSpeed))
      : { accepted: null, motionRejected: false, motionBest: null };
    if (motion.accepted) {
      this.suppressHold = true;
      this.suppressSegment = this.segmenter.started;
    }

    // ---- letters ----
    const labels = this.letters.labels;
    let probs = this.letters.predict(features);
    let geoVec: number[] | null = null;
    if (frame.world) {
      const geo = extractGeometry(frame.world, rollFromImage(frame.landmarks, aspect));
      geoVec = geometryVector(geo);
      if (moving) this.recentGeo = [];
      else {
        this.recentGeo.push(geoVec);
        if (this.recentGeo.length > SAMPLE_FRAMES) this.recentGeo.shift();
      }
      if (this.opts.useRules) {
        probs = refineWithRules(labels, probs, geo);
        probs = applyPlausibility(labels, probs, geo);
      }
      if (this.opts.seed)
        probs = refineWithCalibration(labels, probs, geoVec, this.opts.seed, { maxWeight: 0.6 });
      if (this.opts.calibration) probs = refineWithCalibration(labels, probs, geoVec, this.opts.calibration);
    }
    const enabled = this.opts.enabledLetters;
    if (enabled) probs = probs.map((p, i) => (enabled.has(labels[i]) ? p : 0));
    let live = topK(labels, this.smoother.push(probs), 3);

    // ---- handshape signs (smoothed per sign with an EMA) ----
    let signBest: RecognizerOutput["signBest"] = null;
    if (this.opts.signs?.hasHandshape) {
      const prev = this.shapeEma;
      this.shapeEma = prev ? prev.map((v, i) => SHAPE_EMA * v + (1 - SHAPE_EMA) * features[i]) : features;
      const m = this.opts.signs.matchHandshape(this.shapeEma);
      signBest = m.best;
      const cur = new Map(m.candidates.map((c) => [c.v, c.p]));
      for (const k of new Set([...this.signScores.keys(), ...cur.keys()])) {
        const v = 0.6 * (this.signScores.get(k) ?? 0) + 0.4 * (cur.get(k) ?? 0);
        if (v < 0.01) this.signScores.delete(k);
        else this.signScores.set(k, v);
      }
      const signCands = [...this.signScores.entries()].map(([v, p]) => ({ v, p }));
      const bestSign = Math.max(0, ...signCands.map((c) => c.p));
      // A taught sign the user made on purpose outranks a look-alike letter (e.g. a vertical flat hand taught
      // as Delete vs the letter B): a matching sign scales letters by 1 - bestSign, so even a letter the model
      // is sure of can't keep the sign from clearing the hold margin.
      live = [...live.map((c) => ({ v: c.v, p: c.p * (1 - bestSign) })), ...signCands]
        .sort((a, b) => b.p - a.p)
        .slice(0, 3);
    }

    // ---- quality gates -> status ----
    const outOfFrame = frame.landmarks.some(
      (p) => p.x < EDGE || p.x > 1 - EDGE || p.y < EDGE || p.y > 1 - EDGE,
    );
    const tooFar = size < MIN_HAND_SIZE;
    const blocked = outOfFrame || tooFar || this.suppressHold;
    const hold = this.hold.update(frame.t, blocked ? null : live, moving);

    let accepted: AcceptedToken | null = motion.accepted;
    if (!accepted && hold.accepted) {
      const v = hold.accepted.v;
      const letter = this.signLetters.get(v);
      accepted = letter
        ? { kind: "letter", v: letter, candidates: [{ v: letter, p: hold.accepted.candidates[0]?.p ?? 1 }] }
        : {
            kind: this.signMeanings.has(v) ? "sign" : "letter",
            action: this.signActions.get(v),
            v,
            candidates: hold.accepted.candidates,
          };
      this.lastLetter = accepted.kind === "letter" ? { t: frame.t, v, features } : null;
      if (accepted.kind === "letter" && this.recentGeo.length) accepted.samples = this.recentGeo.slice();
    }

    const status: RecognizerStatus = outOfFrame
      ? "out-of-frame"
      : tooFar
        ? "too-far"
        : moving || this.segmenter.active
          ? "moving"
          : hold.label || this.suppressHold
            ? "ok"
            : "unsure";

    return {
      status,
      live,
      hold,
      moving,
      accepted,
      motionRejected: motion.motionRejected,
      motionBest: motion.motionBest,
      features,
      geoVec,
      motionFrame,
      signBest,
    };
  }

  /** The tracker's label, held steady while the hand stays in view (see HAND_SWITCH_FRAMES). */
  private updateHand(label: Hand): Hand {
    const s = this.stickyHand;
    if (!s) {
      this.stickyHand = { hand: label, against: 0 };
      return label;
    }
    if (label === s.hand) s.against = 0;
    else if (++s.against >= HAND_SWITCH_FRAMES) this.stickyHand = { hand: label, against: 0 };
    return this.stickyHand!.hand;
  }

  /**
   * Match a segment from the segmenter. The sign may start anywhere in it (after a false start or a
   * transition), so every start point is tried (`spotMotion`). At a mid-movement slow-down only a match is acted
   * on: the segment is cut there and the next sign starts fresh. At a rest, no match means "rejected".
   */
  private finishMotion(ev: SegmentEvent | null): {
    accepted: AcceptedToken | null;
    motionRejected: boolean;
    motionBest: RecognizerOutput["motionBest"];
  } {
    const none = { accepted: null, motionRejected: false, motionBest: null };
    const lib = this.opts.signs;
    // A hand leaving the view (usually being lowered) never makes a motion sign; signs end with the hand in view.
    if (!ev || !lib?.hasMotion || ev.left) return none;
    const found = this.spotMotion(ev.frames, lib);
    if (found?.accepted) {
      const { candidates, start, best } = found;
      const v = candidates[0].v;
      const letter = this.signLetters.get(v);
      const accepted: AcceptedToken = letter
        ? { kind: "letter", v: letter, candidates: [{ v: letter, p: candidates[0].p }] }
        : { kind: "sign", v, candidates, action: this.signActions.get(v) };
      const last = this.lastLetter;
      if (
        last &&
        start.t - last.t <= this.opts.retractMs &&
        euclidean(last.features, start.shape) < this.opts.retractShape
      ) {
        accepted.retracts = last.v;
      }
      this.lastLetter = null;
      if (!ev.final) this.segmenter.dropBefore(ev.frames[ev.frames.length - 1].t);
      return { accepted, motionRejected: false, motionBest: best };
    }
    if (!ev.final) return none;
    // A rest after a real movement that matched nothing: say so (small fidgets are ignored).
    if (pathLength(ev.frames) < this.opts.minMotionPath) return none;
    return { accepted: null, motionRejected: true, motionBest: found?.best ?? null };
  }

  /**
   * Best match for the movement ENDING at the last frame, over start points every SPOT_STEP frames. A start
   * point counts only if the rest of the movement lasts 250 ms and the wrist moved at least SPOT_MIN_PATH (J
   * and Z are drawn by a fingertip while the wrist moves little); the library also requires the tracked path to
   * be 0.5-2x the sign's usual length, so the tail of a movement can't pass for a whole sign. Returns the
   * closest one, `accepted` if it clears the margin over the runner-up.
   */
  private spotMotion(
    frames: MotionFrame[],
    lib: SignLibrary,
  ): { accepted: boolean; candidates: Candidate[]; start: MotionFrame; best: RecognizerOutput["motionBest"] } | null {
    let found: { ratio: number; accepted: boolean; candidates: Candidate[]; start: MotionFrame; best: NonNullable<RecognizerOutput["motionBest"]> } | null = null;
    const end = frames[frames.length - 1].t;
    for (let s = 0; s + 4 <= frames.length; s += SPOT_STEP) {
      const sub = frames.slice(s);
      if (end - sub[0].t < DEFAULT_SEGMENTER.minMs) break;
      if (pathLength(sub) < SPOT_MIN_PATH) break; // later starts are only shorter
      const { candidates, best } = lib.matchMotion(motionSequence(trimToMotion(sub)));
      if (!best || !Number.isFinite(best.d)) continue;
      const ratio = best.d / best.threshold;
      if (found && ratio >= found.ratio) continue;
      const [a, b] = candidates;
      found = {
        ratio,
        accepted: !!a && a.p - (b?.p ?? 0) >= this.opts.motionMargin,
        candidates,
        start: sub[0],
        best,
      };
    }
    return found && { accepted: found.accepted, candidates: found.candidates, start: found.start, best: found.best };
  }
}

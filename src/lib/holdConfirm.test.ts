import { describe, expect, it } from "vitest";
import { DEFAULT_HOLD, HoldToConfirm, ProbSmoother, type HoldUpdate } from "./holdConfirm";
import type { Candidate } from "./letterModel";

const FRAME = 33;
/** Tests are written for a 600 ms hold, independent of the app default. */
const H = { ...DEFAULT_HOLD, holdMs: 600 };
const c = (v: string, p: number, rest: Candidate[] = []): Candidate[] => [{ v, p }, ...rest];

/** Feed `cands` every frame for `ms`; returns all updates. */
function feed(h: HoldToConfirm, t0: number, ms: number, cands: Candidate[] | null, moving = false) {
  const out: (HoldUpdate & { t: number })[] = [];
  for (let t = t0; t < t0 + ms; t += FRAME) out.push({ ...h.update(t, cands, moving), t });
  return out;
}
const accepted = (u: HoldUpdate[]) => u.filter((x) => x.accepted).map((x) => x.accepted!.v);

describe("HoldToConfirm", () => {
  it("accepts a letter held above threshold for ~holdMs, once", () => {
    const h = new HoldToConfirm(H);
    const u = feed(h, 0, 1000, c("A", 0.9));
    expect(accepted(u)).toEqual(["A"]);
    const at = u.find((x) => x.accepted)!.t;
    expect(at).toBeGreaterThanOrEqual(H.holdMs);
    expect(at).toBeLessThan(H.holdMs + 100);
  });

  it("reports rising progress before accepting", () => {
    const h = new HoldToConfirm(H);
    const u = feed(h, 0, 400, c("A", 0.9));
    expect(u.at(-1)!.progress).toBeGreaterThan(0.5);
    expect(u.at(-1)!.progress).toBeLessThan(1);
    expect(accepted(u)).toEqual([]);
  });

  it("does not accept below the confidence threshold", () => {
    const h = new HoldToConfirm(H);
    expect(accepted(feed(h, 0, 2000, c("A", 0.4)))).toEqual([]);
  });

  it("tolerates a single flicker frame without resetting", () => {
    const h = new HoldToConfirm(H);
    const a = feed(h, 0, 300, c("A", 0.9));
    h.update(300 + FRAME, c("S", 0.9));
    const b = feed(h, 300 + 2 * FRAME, 500, c("A", 0.9));
    const all = [...a, ...b];
    expect(accepted(all)).toEqual(["A"]);
    expect(all.find((x) => x.accepted)!.t).toBeLessThan(H.holdMs + 150);
  });

  it("resets when the hand moves fast", () => {
    const h = new HoldToConfirm(H);
    feed(h, 0, 500, c("A", 0.9));
    const u = h.update(500, c("A", 0.9), true);
    expect(u.progress).toBe(0);
    expect(accepted(feed(h, 533, 300, c("A", 0.9)))).toEqual([]);
  });

  it("needs re-arming before repeating the same letter, but accepts a new letter", () => {
    const h = new HoldToConfirm(H);
    const u1 = feed(h, 0, 1200, c("L", 0.9));
    expect(accepted(u1)).toEqual(["L"]);
    const u2 = feed(h, 1200, 800, c("O", 0.9));
    expect(accepted(u2)).toEqual(["O"]);
  });

  it("allows a double letter after the hand moves (ASL slide) or leaves", () => {
    const h = new HoldToConfirm(H);
    expect(accepted(feed(h, 0, 700, c("L", 0.9)))).toEqual(["L"]);
    h.update(700, c("L", 0.9), true); // slide
    expect(accepted(feed(h, 733, 700, c("L", 0.9)))).toEqual(["L"]);
    h.update(1500, null); // hand gone
    expect(accepted(feed(h, 1533, 700, c("L", 0.9)))).toEqual(["L"]);
  });

  it("never repeats a letter just because it is held (no runaway triggers)", () => {
    const h = new HoldToConfirm(H);
    expect(accepted(feed(h, 0, 5000, c("E", 0.9)))).toEqual(["E"]);
  });

  it("can repeat after a long hold when repeatMs is configured", () => {
    const h = new HoldToConfirm({ ...H, repeatMs: 1600 });
    expect(accepted(feed(h, 0, 3000, c("E", 0.9)))).toEqual(["E", "E"]);
  });

  it("is 'not sure' when the top two candidates are close, even if both are high", () => {
    const h = new HoldToConfirm(H);
    const u = feed(h, 0, 1500, c("U", 0.62, [{ v: "V", p: 0.5 }]));
    expect(accepted(u)).toEqual([]);
    expect(u.at(-1)!.label).toBeNull();
  });

  it("accepts an ambiguous pair (M vs N) as the leader, keeping both candidates", () => {
    const h = new HoldToConfirm(H);
    const u = feed(
      h,
      0,
      1000,
      c("M", 0.45, [
        { v: "N", p: 0.4 },
        { v: "B", p: 0.05 },
      ]),
    );
    const acc = u.find((x) => x.accepted)!.accepted!;
    expect(acc.v).toBe("M");
    expect(acc.candidates.map((x) => x.v)).toEqual(["M", "N", "B"]);
  });

  it("still refuses when the ambiguous set itself is weak", () => {
    const h = new HoldToConfirm(H);
    expect(
      accepted(
        feed(
          h,
          0,
          1500,
          c("M", 0.3, [
            { v: "N", p: 0.2 },
            { v: "B", p: 0.3 },
          ]),
        ),
      ),
    ).toEqual([]);
  });

  it("returns top-3 candidates averaged over the hold window", () => {
    const h = new HoldToConfirm(H);
    const u = feed(
      h,
      0,
      800,
      c("M", 0.7, [
        { v: "N", p: 0.2 },
        { v: "S", p: 0.05 },
        { v: "T", p: 0.01 },
      ]),
    );
    const acc = u.find((x) => x.accepted)!.accepted!;
    expect(acc.candidates.map((x) => x.v)).toEqual(["M", "N", "S"]);
    expect(acc.candidates[0].p).toBeCloseTo(0.7, 6);
  });
});

describe("markAccepted (after a user correction)", () => {
  it("does not type the corrected letter again while it is held, but does after the hand leaves", () => {
    const h = new HoldToConfirm(H);
    expect(accepted(feed(h, 0, 800, c("N", 0.9)))).toEqual(["N"]);
    h.markAccepted("M", 800); // user fixed N -> M; recognition now (correctly) sees M
    expect(accepted(feed(h, 833, 1500, c("M", 0.9)))).toEqual([]);
    h.update(2400, null);
    expect(accepted(feed(h, 2433, 800, c("M", 0.9)))).toEqual(["M"]);
  });
});

describe("ProbSmoother", () => {
  it("averages the last N frames", () => {
    const s = new ProbSmoother(2);
    s.push([1, 0]);
    expect(s.push([0, 1])).toEqual([0.5, 0.5]);
    expect(s.push([0, 1])).toEqual([0, 1]);
  });
});

/**
 * Rotation-, scale- and handedness-invariant hand-shape features (joint angles, thumb placement,
 * finger spread, in-plane orientation).
 *
 * TypeScript port of signscribe's `features.py` (https://github.com/fokeesy/signscribe, MIT).
 * Input: MediaPipe *world* landmarks (metric 3D) plus image landmarks for the in-plane roll.
 * Used to separate letters the landmark MLP confuses (G/H, A/T/S/E/M/N) and for personal
 * calibration. Pure, no DOM.
 */
import type { Landmark } from "./features";

const EPS = 1e-9;
const DEADZONE = 7; // degrees of joint bend treated as measurement noise

type V3 = [number, number, number];
const v = (p: Landmark): V3 => [p.x, p.y, p.z];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3) => Math.sqrt(dot(a, a));
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const unit = (a: V3): V3 => scale(a, 1 / (norm(a) + EPS));
const angle = (a: V3, b: V3) => {
  const c = dot(a, b) / (norm(a) * norm(b) + EPS);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};

const WRIST = 0;
const THUMB = [1, 2, 3, 4] as const; // CMC, MCP, IP, TIP
const CHAINS: Record<"i" | "m" | "r" | "p", readonly [number, number, number, number]> = {
  i: [5, 6, 7, 8],
  m: [9, 10, 11, 12],
  r: [13, 14, 15, 16],
  p: [17, 18, 19, 20],
};
const FINGERS = ["i", "m", "r", "p"] as const;

export type GeoFeatures = Record<string, number>;

/** In-plane rotation of the hand (radians): 0 = fingers up, +pi/2 = pointing right on screen. */
export function rollFromImage(image: readonly Landmark[], aspect = 4 / 3): number {
  const dx = (image[9].x - image[WRIST].x) * aspect;
  const dy = image[9].y - image[WRIST].y;
  return Math.atan2(dx, -dy);
}

export function extractGeometry(world: readonly Landmark[], roll: number): GeoFeatures {
  const raw = world.map(v);
  const knuckleScale =
    (norm(sub(raw[5], raw[0])) +
      norm(sub(raw[9], raw[0])) +
      norm(sub(raw[13], raw[0])) +
      norm(sub(raw[17], raw[0]))) /
      4 +
    EPS;
  const p = raw.map((q) => scale(sub(q, raw[WRIST]), 1 / knuckleScale));

  const f: GeoFeatures = {};
  const tips: Record<string, V3> = {};
  const dirs: Record<string, V3> = {};

  for (const s of FINGERS) {
    const [mcp, pip, dip, tip] = CHAINS[s];
    const v0 = sub(p[mcp], p[WRIST]);
    const v1 = sub(p[pip], p[mcp]);
    const v2 = sub(p[dip], p[pip]);
    const v3 = sub(p[tip], p[dip]);
    f[`mcp_${s}`] = angle(v0, v1);
    f[`pip_${s}`] = angle(v1, v2);
    f[`dip_${s}`] = angle(v2, v3);
    const curl =
      Math.max(f[`mcp_${s}`] - DEADZONE, 0) +
      Math.max(f[`pip_${s}`] - DEADZONE, 0) +
      Math.max(f[`dip_${s}`] - DEADZONE, 0);
    f[`curl_${s}`] = curl;
    f[`ext_${s}`] = Math.max(0, Math.min(1, 1 - curl / 235));
    tips[s] = p[tip];
    dirs[s] = unit(sub(p[tip], p[mcp]));
  }

  const [cmc, tmcp, tip, ttip] = THUMB;
  const t1 = sub(p[tmcp], p[cmc]);
  const t2 = sub(p[tip], p[tmcp]);
  const t3 = sub(p[ttip], p[tip]);
  f.th_mcp = angle(t1, t2);
  f.th_ip = angle(t2, t3);
  f.th_ext = Math.max(0, Math.min(1, 1 - (f.th_mcp + f.th_ip) / 110));
  f.th_reach = norm(sub(p[ttip], p[cmc])) / (norm(t1) + norm(t2) + norm(t3) + EPS);
  const th = p[ttip];
  const thDir = unit(sub(p[ttip], p[tmcp]));

  for (const s of FINGERS) {
    const [mcp, pip, dip] = CHAINS[s];
    f[`d_t${s}`] = norm(sub(th, tips[s]));
    f[`t_mcp_${s}`] = norm(sub(th, p[mcp]));
    f[`t_pip_${s}`] = norm(sub(th, p[pip]));
    f[`t_dip_${s}`] = norm(sub(th, p[dip]));
  }

  f.d_im = norm(sub(tips.i, tips.m));
  f.d_mr = norm(sub(tips.m, tips.r));
  f.d_rp = norm(sub(tips.r, tips.p));
  f.d_ir = norm(sub(tips.i, tips.r));
  f.d_mp = norm(sub(tips.m, tips.p));
  f.spread_im = angle(dirs.i, dirs.m);
  f.spread_mr = angle(dirs.m, dirs.r);
  f.spread_rp = angle(dirs.r, dirs.p);
  f.ang_ti = angle(thDir, dirs.i);

  const palm = [0, 5, 9, 13, 17].map((i) => p[i]);
  const centre: V3 = scale(
    palm.reduce<V3>((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], [0, 0, 0]),
    1 / palm.length,
  );
  for (const s of FINGERS) f[`tip_pc_${s}`] = norm(sub(tips[s], centre));
  f.t_pc = norm(sub(th, centre));

  const upAx = unit(sub(p[9], p[WRIST]));
  const lat = sub(p[17], p[5]); // index knuckle -> pinky knuckle
  const latLen2 = dot(lat, lat) + EPS;
  // Where the thumb tip sits across the knuckle line: 0 = index side, 1 = pinky side.
  f.t_along = dot(sub(th, p[5]), lat) / latLen2;
  // Height of the thumb tip along the palm axis (1 = knuckle level).
  f.t_height = dot(th, upAx);
  const across = unit(scale(lat, -1));
  const xIdx = dot(sub(tips.i, p[17]), across);
  const xMid = dot(sub(tips.m, p[17]), across);
  f.cross_im = xMid - xIdx; // > 0 when index and middle cross (R)

  f.up = Math.cos(roll);
  f.side = Math.abs(Math.sin(roll));
  return f;
}

/** Ordered keys for the calibration vector (same set as signscribe's VECTOR_KEYS). */
export const VECTOR_KEYS: readonly string[] = [
  ...FINGERS.map((s) => `ext_${s}`),
  ...["mcp", "pip", "dip"].flatMap((j) => FINGERS.map((s) => `${j}_${s}`)),
  "th_ext", "th_mcp", "th_ip", "th_reach",
  "d_ti", "d_tm", "d_tr", "d_tp", "d_im", "d_mr", "d_rp", "d_ir", "d_mp",
  ...FINGERS.map((s) => `t_pip_${s}`),
  ...FINGERS.map((s) => `t_mcp_${s}`),
  ...FINGERS.map((s) => `t_dip_${s}`),
  ...FINGERS.map((s) => `tip_pc_${s}`),
  "t_pc", "ang_ti", "spread_im", "spread_mr", "spread_rp",
  "t_along", "t_height", "cross_im", "up", "side",
]; // prettier-ignore

/** Feature dict -> numeric vector with angles scaled to ~0..1 (as in signscribe's to_vector). */
export function geometryVector(f: GeoFeatures): number[] {
  return VECTOR_KEYS.map((k) => {
    const isAngle =
      /^(mcp|pip|dip)_/.test(k) ||
      k === "th_mcp" ||
      k === "th_ip" ||
      k.startsWith("spread_") ||
      k.startsWith("ang_");
    return isAngle ? f[k] / 90 : f[k];
  });
}

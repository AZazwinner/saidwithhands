/** Transcript of accepted tokens. Pure, immutable helpers. */
import type { Candidate } from "./letterModel";
import type { SignAction } from "./signs";

export type Token =
  | { kind: "letter"; v: string; candidates: Candidate[]; samples?: number[][]; fixed?: boolean }
  | { kind: "sign"; v: string; candidates: Candidate[] }
  | { kind: "space" };

export function addToken(ts: readonly Token[], tok: Token): Token[] {
  if (tok.kind === "space") return addSpace(ts);
  return [...ts, tok];
}

/** Adds a word break. No leading or repeated spaces. */
export function addSpace(ts: readonly Token[]): Token[] {
  if (ts.length === 0 || ts[ts.length - 1].kind === "space") return [...ts];
  return [...ts, { kind: "space" }];
}

export function deleteLast(ts: readonly Token[]): Token[] {
  return ts.slice(0, -1);
}

/**
 * Add a token; if `retracts` names the letter that was typed last (the sign's starting handshape,
 * typed by mistake), that letter is removed first. A sign taught as a key (`action`) presses that key
 * instead of being typed.
 */
export function addReplacing(ts: readonly Token[], tok: Token, retracts?: string, action?: SignAction): Token[] {
  const last = ts[ts.length - 1];
  const base = retracts && last?.kind === "letter" && last.v === retracts ? ts.slice(0, -1) : ts;
  if (action === "space") return addSpace(base);
  if (action === "delete") return deleteLast(base);
  return addToken(base, tok);
}

/** Top-1 text: letters form words, signs are whole words/phrases. */
export function rawText(ts: readonly Token[]): string {
  let out = "";
  let prev: Token["kind"] | null = null;
  for (const t of ts) {
    if (t.kind === "space") out += " ";
    else if (t.kind === "sign") {
      if (out && !out.endsWith(" ")) out += " ";
      out += t.v.toUpperCase();
    } else {
      if (prev === "sign") out += " ";
      out += t.v.toUpperCase();
    }
    prev = t.kind;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Non-space tokens in order: what gets sent to Gemini (with spaces as word separators). */
export type Position = { pos: number; kind: "letter" | "sign" | "space"; candidates: Candidate[] };

export function toPositions(ts: readonly Token[]): Position[] {
  const trimmed = [...ts];
  while (trimmed.length && trimmed[trimmed.length - 1].kind === "space") trimmed.pop();
  return trimmed.map((t, i) => ({
    pos: i + 1,
    kind: t.kind,
    candidates:
      t.kind === "space" ? [{ v: " ", p: 1 }] : t.candidates.map((c) => ({ v: c.v, p: round(c.p) })),
  }));
}

const round = (p: number) => Math.round(p * 100) / 100;

/**
 * For a letter accepted from an ambiguous set (e.g. M vs N), the close runner-up in the same set,
 * so the UI can show "M/N" and Gemini can choose. Null when the letter was clear.
 */
export function ambiguousAlternative(
  t: Token,
  sets: readonly (readonly string[])[],
  ratio = 0.5,
): string | null {
  if (t.kind !== "letter") return null;
  const set = sets.find((s) => s.includes(t.v));
  const alt = t.candidates.find((c) => c.v !== t.v && set?.includes(c.v));
  const top = t.candidates.find((c) => c.v === t.v)?.p ?? 0;
  return alt && alt.p >= ratio * top ? alt.v : null;
}

/**
 * The user corrected letter `i` to `v`: the chosen letter becomes certain (p = 1) so the best guess keeps
 * it, and the token is marked as fixed. Non-letters are left alone.
 */
export function fixLetter(ts: readonly Token[], i: number, v: string): Token[] {
  const t = ts[i];
  if (!t || t.kind !== "letter") return [...ts];
  const others = t.candidates.filter((c) => c.v !== v).slice(0, 2);
  return ts.map((x, k) => (k === i ? { ...t, v, candidates: [{ v, p: 1 }, ...others], fixed: true } : x));
}

export function removeAt(ts: readonly Token[], i: number): Token[] {
  return ts.filter((_, k) => k !== i);
}

/**
 * "Best guess" sentence from the recognized sequence (Step 4). Pure: prompt, schema, validation and
 * fallback live here; the API route only supplies the Gemini call, so all of this is unit-tested.
 *
 * Honesty rules enforced in code, not just in the prompt:
 *  - letters come from that position's candidates, except a small budget of visible fixes (replace /
 *    drop / add one letter, at most 1 per 4 letters); signs can never be changed,
 *  - "changed" is recomputed by us (chosen != recognizer's top-1), never trusted from the model,
 *  - words in the sentence not backed by the signs are reported as `added` and shown in the UI;
 *    too many added content words -> the guess is rejected and the raw signs are used,
 *  - any failure or timeout -> fallback to the raw top-1 text.
 */
import type { Candidate } from "./letterModel";
import type { Position } from "./transcript";

export type BestGuessRequest = { positions: Position[]; question?: boolean };

export type BestGuess = {
  sentence: string;
  /** chosen value per non-space position */
  chosen: { pos: number; v: string }[];
  /** positions where a different one of the recognizer's candidates was chosen */
  changed: number[];
  /** letter positions fixed beyond the candidates (replaced, dropped or with a letter added) */
  corrected: number[];
  /** letter positions dropped as extra/duplicate (subset of corrected) */
  dropped: number[];
  /** sentence words not supported by the chosen signs (shown as "added" in the UI) */
  added: string[];
};

export type BestGuessResult =
  | ({ ok: true; source: "gemini"; ms: number } & BestGuess)
  | { ok: false; source: "raw"; reason: string; sentence: string };

export const LIMITS = { positions: 120, candidates: 3, valueLength: 60 } as const;
export const TIMEOUT_MS = 5000;
/** Letter fixes beyond the candidates: at most 1 per 4 letters (minimum 1). */
export const FIX_BUDGET = 0.25;
/** Reject the guess if it adds more than this many content words that no sign supports. */
export const MAX_ADDED_CONTENT_WORDS = 2;

/** Grammatical glue the model may add without it counting as invented content. */
const FUNCTION_WORDS = new Set(
  (
    "a an the is are am was were be been being to of for in on at by with and or but so if " +
    "i me my mine you your it its this that these those he she they them his her their we us our " +
    "do does did have has had can could would will should may might must not no yes " +
    "what where when how who why which here there please thank thanks hi hello"
  ).split(" "),
);

export const SYSTEM_INSTRUCTION = `You help a Deaf or hard-of-hearing person talk to a hearing person, for example at a pharmacy counter or a doctor's front desk.
They use a webcam sign recognizer (NOT a translator). It recognizes ASL fingerspelled letters and a few whole signs the user taught it, and it is often unsure.

You receive the recognized sequence as numbered positions. Each position has up to 3 candidates with the recognizer's confidence p (0..1):
- kind "letter": one fingerspelled letter. Consecutive letters spell a word.
- kind "space": a word break.
- kind "sign": a whole word or phrase the user taught.
The signer often forgets to mark word breaks, so a long run of letters with no "space" may hold SEVERAL words run together. The letters are in the order they were signed.
"typed" is the same sequence as one line: each position's top candidate, taught signs in [brackets], word breaks as spaces. Read it first to find the words (e.g. "ANDEATICECREAM" is "AND EAT ICE CREAM"); use "positions" for the other candidates.

Work in this order (the output fields follow it):
1. "words": the signed letters and signs split into words, in order, putting back the missing word breaks. Every word must be spelled by the positions in order: each letter position gives one letter, normally one of its candidates (prefer the confident one; switch to a lower candidate when it clearly makes a better word). Each sign is one word or phrase, exactly as given. Do not reorder or skip letters, and do not put words in "words" that weren't signed. A letter sequence that isn't a word may be a name: keep it as spelled.
2. "sentence": write the natural English sentence from those words, in order. Only here may you add small grammatical words, and do add them wherever English needs them (articles, "to", "is", ...): signs and fingerspelling usually leave them out, e.g. [TO GO TO] [WASHROOM] -> "to go to the washroom".

Example. Positions 1-20 are the letters I W A N T T O G O T O T H E T O I L S T with no spaces, and the last candidates are S or E:
  words = ["I","WANT","TO","GO","TO","THE","TOILET"]  (the S at position 19 becomes E: one fix)
  sentence = "I want to go to the toilet."
Example 2. The letters I N E E D M Y M E D I C A T I O N, no spaces and no fixes needed:
  words = ["I","NEED","MY","MEDICATION"]   sentence = "I need my medication."
Start from the letters exactly as signed (their top candidates) and look for the split into real words that needs the FEWEST changes. Never swap in different words just because they sound likely ("INEED" is "I need", not "interested").
Wrong: rewording the letters ("Is it wanted to go...") or adding words to "words" that weren't signed.

Fixes: only if no candidate can make a real word, you may FIX a misrecognized letter inside a word: replace it with another letter, drop an extra/duplicated letter, or add one missing letter. At most one fix per 4 letters. Never change signs.
Write ONE short, natural English sentence that the person most likely means, using the chosen words in order.

Strict rules:
- Never add facts, names, numbers, symptoms, medicines, times or requests that are not in the signs. You may only add small grammatical words (a, the, is, I, my, to, ...).
- If the input is a single word or name, the sentence may be just that word.
- Decide yourself whether it is a question. If the signs ask something (a question word such as WHERE, WHAT, WHEN, WHO, WHY, HOW, WHICH, HOW MUCH, or a request like CAN I / DO YOU / IS IT), write it as a question ending in "?"; otherwise write a statement. Facial expressions, which mark yes/no questions in ASL, aren't captured, so don't turn a plain statement into a question. If "question" is true, always phrase it as a question.
- Output only JSON matching the schema.`;

export const RESPONSE_SCHEMA = {
  type: "object",
  // Order matters: the model commits to the words first and only then writes the sentence, so the
  // sentence can't drift away from the letters. Which letter went where is worked out by alignWords(),
  // not asked of the model (it loses count of positions on long runs).
  propertyOrdering: ["words", "sentence"],
  properties: {
    words: {
      type: "array",
      description: "The chosen letters/signs split into words, in order, e.g. [\"I\",\"WANT\",\"TO\",\"GO\"].",
      items: { type: "string" },
    },
    sentence: { type: "string", description: "One short natural English sentence made from those words." },
  },
  required: ["words", "sentence"],
} as const;

/**
 * The recognizer's top choices as one line, taught signs in [brackets], word breaks as spaces, e.g.
 * "I [WANT] [TO GO TO] [WASHROOM] ANDEATICECREAM". The model splits run-together letters far better from a
 * string than from one JSON object per letter (it produced "AND MEDICATE" for ANDEATICECREAM).
 */
export function typedLine(positions: readonly Position[]): string {
  let out = "";
  let prev: Position["kind"] | null = null;
  for (const p of positions) {
    const v = p.candidates[0]?.v ?? "";
    if (p.kind === "space") out += " ";
    else if (p.kind === "sign") out += `${out && !out.endsWith(" ") ? " " : ""}[${v}]`;
    else out += (prev === "sign" ? " " : "") + v;
    prev = p.kind;
  }
  return out.replace(/\s+/g, " ").trim().toUpperCase();
}

export function buildPrompt(req: BestGuessRequest): string {
  return JSON.stringify({
    ...(req.question ? { question: true } : {}),
    typed: typedLine(req.positions),
    positions: req.positions,
  });
}

/** Validate and sanitize client input. Returns an error string, or null if fine. */
export function validateRequest(x: unknown): string | null {
  if (!x || typeof x !== "object") return "body must be an object";
  const { positions, question } = x as BestGuessRequest;
  if (question !== undefined && typeof question !== "boolean") return "question must be boolean";
  if (!Array.isArray(positions) || positions.length === 0) return "positions must be a non-empty array";
  if (positions.length > LIMITS.positions) return `at most ${LIMITS.positions} positions`;
  for (const p of positions) {
    if (!p || typeof p.pos !== "number" || !["letter", "sign", "space"].includes(p.kind))
      return "bad position";
    if (!Array.isArray(p.candidates) || p.candidates.length === 0 || p.candidates.length > LIMITS.candidates)
      return "each position needs 1-3 candidates";
    for (const c of p.candidates) {
      if (typeof c?.v !== "string" || c.v.length > LIMITS.valueLength || typeof c.p !== "number")
        return "bad candidate";
    }
  }
  return null;
}

/** The recognizer's top-1 text, used when Gemini is unavailable. */
export function rawSentence(positions: readonly Position[]): string {
  let out = "";
  let prevKind: Position["kind"] | null = null;
  for (const p of positions) {
    const v = p.candidates[0]?.v ?? "";
    if (p.kind === "space") out += " ";
    else if (p.kind === "sign") out += (out && !out.endsWith(" ") ? " " : "") + v;
    else out += (prevKind === "sign" ? " " : "") + v;
    prevKind = p.kind;
  }
  return out.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The words formed by chosen letters/signs (lower case), for the "added words" check. */
export function chosenWords(positions: readonly Position[], chosen: ReadonlyMap<number, string>): string[] {
  const words: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) words.push(cur);
    cur = "";
  };
  for (const p of positions) {
    if (p.kind === "space") flush();
    else if (p.kind === "sign") {
      flush();
      words.push(...(chosen.get(p.pos) ?? "").toLowerCase().split(/\s+/).filter(Boolean));
    } else cur += (chosen.get(p.pos) ?? "").toLowerCase();
  }
  flush();
  return words;
}

const tokenize = (s: string) => s.toLowerCase().match(/[a-z']+/g) ?? [];

/** Levenshtein distance (small words only, so the O(n·m) table is fine). */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/**
 * Sentence words that no chosen sign/word supports and that aren't grammatical glue. A word one letter
 * away from a spelled word of 4+ letters counts as spelled (e.g. a missed letter: PHARMCY -> pharmacy).
 */
export function addedWords(sentence: string, supported: readonly string[]): string[] {
  const ok = new Set(supported.flatMap((w) => [w, w.replace(/'s$/, ""), `${w}s`]));
  const near = (w: string) => supported.some((s) => s.length >= 4 && editDistance(w, s) <= 1);
  return [
    ...new Set(
      tokenize(sentence).filter((w) => !ok.has(w) && !FUNCTION_WORDS.has(w.replace(/'.*$/, "")) && !near(w)),
    ),
  ];
}

const normWord = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Alignment costs: a letter fix outweighs any number of "chose a lower candidate" tie-breaks. */
const EDIT = 1000;
const NON_TOP = 1;

export type Alignment = Pick<BestGuess, "chosen" | "changed" | "corrected" | "dropped"> & { edits: number };

/**
 * Spell the model's `words` with the recognized positions, in order, with the fewest letter fixes: each
 * letter position gives one of its candidates (free), another letter (1 fix), nothing (1 fix, dropped)
 * or two letters (1 fix if either is a candidate). Signs must appear exactly as recognized; word breaks
 * are free (the signer often skips Space). Returns null if the words can't be spelled at all.
 * The per-position choices are derived here rather than trusted from the model, which loses count on
 * long runs of letters.
 */
export function alignWords(positions: readonly Position[], words: readonly string[]): Alignment | null {
  const T = words.map(normWord).filter(Boolean).join(" ");
  if (!T) return null;
  const n = positions.length;
  const m = T.length;
  const f = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(Infinity));
  const back: ({ i: number; j: number; v: string | null } | null)[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(null),
  );
  f[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const c = f[i][j];
      if (c === Infinity) continue;
      const relax = (ni: number, nj: number, add: number, v: string | null) => {
        if (c + add < f[ni][nj]) {
          f[ni][nj] = c + add;
          back[ni][nj] = { i, j, v };
        }
      };
      if (j < m && T[j] === " ") relax(i, j + 1, 0, null); // a word break nobody signed
      if (i === n) continue;
      const p = positions[i];
      const cands = p.candidates.map((x) => normWord(x.v));
      if (p.kind === "space") {
        relax(i + 1, j, 0, " ");
      } else if (p.kind === "sign") {
        cands.forEach((s, k) => {
          if (s && T.startsWith(s, j)) relax(i + 1, j + s.length, k ? NON_TOP : 0, p.candidates[k].v);
        });
      } else {
        relax(i + 1, j, EDIT, "");
        if (j < m && T[j] !== " ") {
          const k = cands.indexOf(T[j]);
          relax(i + 1, j + 1, k < 0 ? EDIT : k ? NON_TOP : 0, k < 0 ? T[j] : p.candidates[k].v);
        }
        if (j + 1 < m && T[j] !== " " && T[j + 1] !== " ") {
          const two = T.slice(j, j + 2);
          relax(i + 1, j + 2, cands.includes(two[0]) || cands.includes(two[1]) ? EDIT : 2 * EDIT, two);
        }
      }
    }
  }
  if (f[n][m] === Infinity) return null;

  const steps: { pos: Position; v: string }[] = [];
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const b = back[i][j]!;
    if (b.i !== i && b.v !== null) steps.push({ pos: positions[b.i], v: b.v });
    i = b.i;
    j = b.j;
  }
  steps.reverse();
  const out: Alignment = { chosen: [], changed: [], corrected: [], dropped: [], edits: Math.floor(f[n][m] / EDIT) };
  for (const { pos: p, v } of steps) {
    if (p.kind === "space") continue;
    out.chosen.push({ pos: p.pos, v });
    const k = p.candidates.findIndex((x) => normWord(x.v) === normWord(v));
    if (k > 0) out.changed.push(p.pos);
    else if (k < 0) {
      out.corrected.push(p.pos);
      if (v === "") out.dropped.push(p.pos);
    }
  }
  return out;
}

/** Validate the model's JSON against the request. Returns a BestGuess or an error string. */
export function validateResponse(raw: unknown, req: BestGuessRequest): BestGuess | string {
  if (!raw || typeof raw !== "object") return "response is not an object";
  const r = raw as { sentence?: unknown; chosen?: unknown; words?: unknown };
  if (typeof r.sentence !== "string" || !r.sentence.trim()) return "empty sentence";
  if (r.sentence.length > 400) return "sentence too long";
  const letterCount = req.positions.filter((p) => p.kind === "letter").length;
  const budget = Math.max(1, Math.ceil(letterCount * FIX_BUDGET));
  const sentence = r.sentence.trim();
  const modelWords = Array.isArray(r.words) ? r.words.filter((w): w is string => typeof w === "string") : [];

  // Preferred path: the model's words, lined up against the signs by us.
  if (modelWords.some((w) => normWord(w))) {
    const a = alignWords(req.positions, modelWords);
    if (!a) return "words don't spell the signed letters (a sign is missing or changed)";
    if (a.edits > budget) return `words don't spell the signed letters (${a.edits} fixes > ${budget})`;
    const supported = modelWords.flatMap((w) => normWord(w).toLowerCase().split(" ")).filter(Boolean);
    const added = addedWords(sentence, supported);
    if (added.length > MAX_ADDED_CONTENT_WORDS) return `adds unsupported words: ${added.join(", ")}`;
    return { sentence, chosen: a.chosen, changed: a.changed, corrected: a.corrected, dropped: a.dropped, added };
  }

  // No words: per-position choices from the model.
  if (!Array.isArray(r.chosen)) return "chosen missing";

  const needed = req.positions.filter((p) => p.kind !== "space");
  const byPos = new Map<number, string>();
  for (const c of r.chosen as { pos?: unknown; v?: unknown }[]) {
    if (typeof c?.pos !== "number" || typeof c?.v !== "string") return "bad chosen entry";
    byPos.set(c.pos, c.v);
  }
  const chosen: { pos: number; v: string }[] = [];
  const changed: number[] = [];
  const corrected: number[] = [];
  const dropped: number[] = [];
  let edits = 0;
  for (const p of needed) {
    // A position the model skipped keeps what the recognizer saw (no change), instead of discarding the
    // whole guess; the sentence checks below still have to pass.
    const v = byPos.get(p.pos) ?? p.candidates[0].v;
    const cands = p.candidates.map((c: Candidate) => c.v.toUpperCase());
    const V = v.trim().toUpperCase();
    if (cands.includes(V)) {
      chosen.push({ pos: p.pos, v: p.candidates[cands.indexOf(V)].v });
      if (V !== cands[0]) changed.push(p.pos);
      continue;
    }
    if (p.kind !== "letter") return `position ${p.pos}: signs can't be changed ("${v}")`;
    if (V === "") {
      edits += 1;
      dropped.push(p.pos);
    } else if (/^[A-Z]$/.test(V)) {
      edits += 1;
    } else if (/^[A-Z]{2}$/.test(V)) {
      edits += cands.includes(V[0]) || cands.includes(V[1]) ? 1 : 2;
    } else return `position ${p.pos}: "${v}" is not a valid letter fix`;
    corrected.push(p.pos);
    chosen.push({ pos: p.pos, v: V });
  }
  if (edits > budget) return `too many letter fixes (${edits} > ${budget})`;

  const chosenMap = new Map(chosen.map((c) => [c.pos, c.v]));
  const supported = chosenWords(req.positions, chosenMap);
  const added = addedWords(sentence, supported);
  if (added.length > MAX_ADDED_CONTENT_WORDS) return `adds unsupported words: ${added.join(", ")}`;
  return { sentence, chosen, changed, corrected, dropped, added };
}

export type Generate = (args: {
  system: string;
  prompt: string;
  schema: unknown;
  signal: AbortSignal;
}) => Promise<string>;

/** Our own rejection / timeout messages. Anything else is a provider error and is not shown to users. */
const OWN_REASON =
  /^(too many letter fixes|adds unsupported|words don't spell|no choice|position \d|response is not|empty sentence|sentence too long|chosen missing|bad chosen|model returned|timed out|Gemini is not configured)/;

/** What the API route may send to the browser: our messages as-is, provider errors reduced to a category. */
export function publicReason(reason: string): string {
  if (/429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(reason)) return "rate limit";
  return OWN_REASON.test(reason) ? reason : "Gemini unavailable";
}

/** One plain sentence for the UI. The raw signs are always shown next to it. */
export function reasonMessage(reason: string): string {
  if (reason === "rate limit") return "Gemini's request limit was reached. Try again in a minute.";
  if (reason === "offline") return "You're offline, so there's no best guess.";
  if (/^timed out/.test(reason)) return "Gemini took too long.";
  if (/not configured/.test(reason)) return "Gemini isn't set up on this server.";
  if (reason === "Gemini unavailable" || /^server error/.test(reason)) return "Gemini couldn't be reached.";
  return "Gemini's guess didn't match the signs, so it was discarded.";
}

/** A rejected guess (not a provider error or timeout) is tried once more if there's time left. */
const MAX_ATTEMPTS = 2;

/** Run the model with a hard timeout; always returns something speakable. */
export async function bestGuess(
  req: BestGuessRequest,
  generate: Generate,
  timeoutMs = TIMEOUT_MS,
): Promise<BestGuessResult> {
  const fallback = (reason: string): BestGuessResult => ({
    ok: false,
    source: "raw",
    reason,
    sentence: rawSentence(req.positions),
  });
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const canRetry = (attempt: number) => attempt + 1 < MAX_ATTEMPTS && Date.now() - t0 < timeoutMs * 0.5;
  try {
    for (let attempt = 0; ; attempt++) {
      const text = await Promise.race([
        generate({
          system: SYSTEM_INSTRUCTION,
          prompt: buildPrompt(req),
          schema: RESPONSE_SCHEMA,
          signal: ctrl.signal,
        }),
        new Promise<never>((_, reject) =>
          ctrl.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }),
        ),
      ]);
      let rejection: string | null = null;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        rejection = "model returned invalid JSON";
      }
      if (rejection === null) {
        const v = validateResponse(json, req);
        if (typeof v !== "string") return { ok: true, source: "gemini", ms: Date.now() - t0, ...v };
        rejection = v;
      }
      if (!canRetry(attempt)) return fallback(rejection);
    }
  } catch (e) {
    return fallback(
      ctrl.signal.aborted ? `timed out after ${timeoutMs / 1000} s` : String((e as Error)?.message ?? e),
    );
  } finally {
    clearTimeout(timer);
  }
}

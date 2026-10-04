import { describe, expect, it } from "vitest";
import {
  addedWords,
  alignWords,
  buildPrompt,
  typedLine,
  bestGuess,
  publicReason,
  reasonMessage,
  rawSentence,
  validateRequest,
  validateResponse,
  type BestGuessRequest,
  type Generate,
} from "./bestGuess";
import type { Position } from "./transcript";

const L = (pos: number, ...c: [string, number][]): Position => ({
  pos,
  kind: "letter",
  candidates: c.map(([v, p]) => ({ v, p })),
});
const SP = (pos: number): Position => ({ pos, kind: "space", candidates: [{ v: " ", p: 1 }] });
const SG = (pos: number, v: string): Position => ({ pos, kind: "sign", candidates: [{ v, p: 0.9 }] });

// "N A M E" where the first letter was recognized as N but M was a candidate... spelled "NAME"
// and the sign MY MEDICATION. Example from the brief: M/N ambiguity.
const req: BestGuessRequest = {
  positions: [L(1, ["N", 0.55], ["M", 0.4]), L(2, ["Y", 0.9]), SP(3), SG(4, "MEDICATION")],
};

describe("validateResponse", () => {
  it("accepts choices from the candidates and recomputes 'changed' itself", () => {
    const r = validateResponse(
      {
        sentence: "My medication.",
        chosen: [
          { pos: 1, v: "M" },
          { pos: 2, v: "Y" },
          { pos: 4, v: "MEDICATION" },
        ],
        changed: [],
      },
      req,
    );
    expect(r).toMatchObject({ sentence: "My medication.", changed: [1], added: [] });
  });

  const water: BestGuessRequest = {
    positions: [
      L(1, ["W", 0.9]),
      L(2, ["A", 0.8], ["S", 0.1]),
      L(3, ["T", 0.7], ["G", 0.2]),
      L(4, ["E", 0.8]),
      L(5, ["U", 0.6], ["V", 0.3], ["K", 0.1]),
    ],
  };
  const pick = (...vs: string[]) => vs.map((v, i) => ({ pos: i + 1, v }));

  it("allows one visible fix beyond the candidates (WATEU -> WATER), reported as corrected", () => {
    const r = validateResponse(
      { sentence: "Water.", chosen: pick("W", "A", "T", "E", "R"), changed: [] },
      water,
    );
    expect(r).toMatchObject({ sentence: "Water.", corrected: [5], dropped: [], changed: [] });
  });

  it("counts drops and two-letter inserts as fixes", () => {
    const r = validateResponse(
      { sentence: "Wate.", chosen: pick("W", "A", "T", "E", ""), changed: [] },
      water,
    );
    expect(r).toMatchObject({ corrected: [5], dropped: [5] });
  });

  it("rejects more fixes than the budget (1 per 4 letters)", () => {
    const r = validateResponse(
      { sentence: "Wider.", chosen: pick("W", "I", "D", "E", "R"), changed: [] },
      water,
    );
    expect(r).toMatch(/too many letter fixes/);
  });

  it("never lets the model change a taught sign", () => {
    const r = validateResponse(
      {
        sentence: "My pills.",
        chosen: [
          { pos: 1, v: "M" },
          { pos: 2, v: "Y" },
          { pos: 4, v: "PILLS" },
        ],
        changed: [],
      },
      req,
    );
    expect(r).toMatch(/signs can't be changed/);
  });

  it("keeps the recognized value for a position the model skipped, and rejects malformed output", () => {
    const r = validateResponse({ sentence: "My medication.", chosen: [{ pos: 1, v: "M" }, { pos: 4, v: "MEDICATION" }] }, req);
    expect(r).toMatchObject({ chosen: [{ pos: 1, v: "M" }, { pos: 2, v: "Y" }, { pos: 4, v: "MEDICATION" }] });
    expect(validateResponse({ sentence: "", chosen: [], changed: [] }, req)).toMatch(/empty/);
    expect(validateResponse(null, req)).toMatch(/not an object/);
  });

  it("reports added words, and rejects a sentence that invents content", () => {
    const chosen = [
      { pos: 1, v: "M" },
      { pos: 2, v: "Y" },
      { pos: 4, v: "MEDICATION" },
    ];
    const ok = validateResponse({ sentence: "I need my medication.", chosen, changed: [1] }, req);
    expect(ok).toMatchObject({ added: ["need"] });
    const bad = validateResponse(
      { sentence: "I need my blood pressure medication refilled today.", chosen, changed: [1] },
      req,
    );
    expect(bad).toMatch(/unsupported words/);
  });
});

describe("run-together letters (no word breaks)", () => {
  const spell = (text: string): BestGuessRequest => ({
    positions: [...text].map((c, i) => L(i + 1, [c, 0.8], [c === "T" ? "S" : "T", 0.2])),
  });
  const pick = (text: string) => [...text].map((c, i) => ({ pos: i + 1, v: c }));

  it("the screenshot: partly spaced, one wrong letter, model's own letter list out of step", () => {
    // I WANT TOGOTOTHEWASHUOOM (spaces after I and WANT only); U should have been R.
    const positions: Position[] = [];
    for (const ch of "I WANT TOGOTOTHEWASHUOOM") {
      const pos = positions.length + 1;
      positions.push(ch === " " ? SP(pos) : L(pos, [ch, 0.8], [ch === "T" ? "S" : "T", 0.2]));
    }
    const r = validateResponse(
      {
        words: ["I", "WANT", "TO", "GO", "TO", "THE", "WASHROOM"],
        sentence: "I want to go to the washroom.",
        chosen: pick("IWANTTOGOTOTHEWASHUOOM"), // ignored: the words decide
      },
      { positions },
    );
    expect(r).toMatchObject({ sentence: "I want to go to the washroom.", added: [] });
    const u = positions.find((p) => p.candidates[0].v === "U")!.pos;
    expect(typeof r !== "string" && r.corrected).toEqual([u]);
    expect(typeof r !== "string" && r.chosen.find((c) => c.pos === u)?.v).toBe("R");
  });

  it("alignWords: free word breaks, lower candidates, drops and added letters", () => {
    const ps = [L(1, ["W", 0.9]), L(2, ["A", 0.9]), L(3, ["S", 0.6], ["T", 0.4]), L(4, ["E", 0.9]), L(5, ["R", 0.9])];
    expect(alignWords(ps, ["WATER"])).toMatchObject({ edits: 0, changed: [3], corrected: [] });
    expect(alignWords(ps, ["WA", "TER"])).toMatchObject({ edits: 0 });
    expect(alignWords(ps, ["WATR"])).toMatchObject({ edits: 1, dropped: [4] });
    expect(alignWords(ps, ["WATERS"])).toMatchObject({ edits: 1, corrected: [5] });
    expect(alignWords(ps, ["WATER", "NOW"])!.edits).toBeGreaterThanOrEqual(3); // each position adds at most one
    expect(alignWords(ps, ["WATER", "PLEASE"])).toBeNull();
  });

  it("alignWords: signs must appear exactly as recognized", () => {
    expect(alignWords(req.positions, ["MY", "MEDICATION"])).toMatchObject({ edits: 0, changed: [1] });
    expect(alignWords(req.positions, ["MY", "PILLS"])).toBeNull();
    expect(alignWords(req.positions, ["MY"])).toBeNull();
    const r = validateResponse({ words: ["MY", "PILLS"], sentence: "My pills." }, req);
    expect(r).toMatch(/words don't spell/);
  });

  it("accepts a sentence whose words tile the unspaced letters", () => {
    const r = validateResponse(
      {
        words: ["I", "NEED", "MY", "MEDICATION"],
        sentence: "I need my medication.",
        chosen: pick("INEEDMYMEDICATION"),
      },
      spell("INEEDMYMEDICATION"),
    );
    expect(r).toMatchObject({ sentence: "I need my medication.", added: [], corrected: [] });
  });

  it("rejects a long unspaced run when the model's words don't spell it", () => {
    const r = validateResponse(
      { words: ["IS", "IT", "TO", "GO"], sentence: "Is it to go to the toilet?", chosen: pick("IWANTTOGOTOTHETOILET") },
      spell("IWANTTOGOTOTHETOILET"),
    );
    expect(r).toMatch(/words don't spell/);
  });

  it("still rejects invented words when the split doesn't tile the letters", () => {
    const r = validateResponse(
      {
        words: ["I", "NEED", "MY", "MEDICATION"],
        sentence: "I need my blood pressure medication refilled.",
        chosen: pick("INEEDMYMEDICATION"),
      },
      spell("INEEDMYMEDICATION"),
    );
    expect(typeof r).toBe("string");
    expect(r).toMatch(/adds unsupported words/);
  });
});

describe("addedWords", () => {
  it("ignores grammatical glue and plural/possessive forms of supported words", () => {
    expect(addedWords("Is this my medications?", ["my", "medication"])).toEqual([]);
    expect(addedWords("Where is the bathroom?", ["where"])).toEqual(["bathroom"]);
  });
  it("treats a word one letter away from a spelled 4+ letter word as spelled", () => {
    expect(addedWords("Pharmacy", ["pharmcy"])).toEqual([]);
    expect(addedWords("Cat", ["bat"])).toEqual(["cat"]); // too short to count
  });
});

describe("typedLine", () => {
  it("gives the model the top choices as one line, signs in brackets", () => {
    const ps = [L(1, ["I", 0.8]), SP(2), SG(3, "WANT"), SG(4, "TO GO TO"), ...[..."ANDEAT"].map((c, i) => L(5 + i, [c, 0.8]))];
    expect(typedLine(ps)).toBe("I [WANT] [TO GO TO] ANDEAT");
    expect(JSON.parse(buildPrompt({ positions: ps })).typed).toBe("I [WANT] [TO GO TO] ANDEAT");
  });
});

describe("rawSentence", () => {
  it("joins top-1 letters into words and keeps signs as words", () => {
    expect(rawSentence(req.positions)).toBe("ny medication");
    expect(rawSentence([SG(1, "THANK YOU"), L(2, ["H", 1]), L(3, ["I", 1])])).toBe("thank you hi");
  });
});

describe("validateRequest", () => {
  it("accepts a well-formed request and rejects bad input", () => {
    expect(validateRequest(req)).toBeNull();
    expect(validateRequest({ positions: [] })).toMatch(/non-empty/);
    expect(validateRequest({ positions: [{ pos: 1, kind: "letter", candidates: [] }] })).toMatch(/1-3/);
    expect(validateRequest({ positions: req.positions, question: "yes" })).toMatch(/boolean/);
    const long = { positions: [L(1, ["x".repeat(61), 1])] };
    expect(validateRequest(long)).toMatch(/bad candidate/);
  });
});

describe("bestGuess (with a fake model)", () => {
  const good: Generate = async () =>
    JSON.stringify({
      sentence: "My medication.",
      chosen: [
        { pos: 1, v: "M" },
        { pos: 2, v: "Y" },
        { pos: 4, v: "MEDICATION" },
      ],
      changed: [1],
    });

  it("returns the validated guess", async () => {
    const r = await bestGuess(req, good);
    expect(r).toMatchObject({ ok: true, source: "gemini", sentence: "My medication.", changed: [1] });
  });

  it("falls back to the raw signs on invalid JSON", async () => {
    const r = await bestGuess(req, async () => "not json");
    expect(r).toMatchObject({ ok: false, source: "raw", sentence: "ny medication" });
  });

  it("falls back on a model error", async () => {
    const r = await bestGuess(req, async () => {
      throw new Error("503");
    });
    expect(r).toMatchObject({ ok: false, reason: "503" });
  });

  it("retries once when the first guess is rejected", async () => {
    let calls = 0;
    const flaky: Generate = async (a) => (++calls === 1 ? "not json" : good(a));
    const r = await bestGuess(req, flaky);
    expect(calls).toBe(2);
    expect(r).toMatchObject({ ok: true, sentence: "My medication." });
  });

  it("does not retry a provider error", async () => {
    let calls = 0;
    const r = await bestGuess(req, async () => {
      calls++;
      throw new Error("429");
    });
    expect(calls).toBe(1);
    expect(r).toMatchObject({ ok: false, reason: "429" });
  });

  it("falls back after the timeout even if the model never answers", async () => {
    const hang: Generate = () => new Promise(() => {});
    const t0 = Date.now();
    const r = await bestGuess(req, hang, 50);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r).toMatchObject({ ok: false, source: "raw" });
    expect(!r.ok && r.reason).toMatch(/timed out/);
  });
});

describe("failure reasons shown to the user", () => {
  it("passes our own rejection messages through and hides provider errors", () => {
    expect(publicReason("too many letter fixes (16 > 5)")).toBe("too many letter fixes (16 > 5)");
    expect(publicReason("timed out after 5 s")).toBe("timed out after 5 s");
    expect(publicReason('{"error":{"code":500,"message":"internal"}}')).toBe("Gemini unavailable");
    expect(publicReason("fetch failed")).toBe("Gemini unavailable");
  });

  it("names the free-tier rate limit (HTTP 429) instead of a generic error", () => {
    expect(publicReason('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}')).toBe("rate limit");
    expect(reasonMessage("rate limit")).toMatch(/limit/);
  });

  it("gives every reason a plain sentence", () => {
    for (const r of ["rate limit", "offline", "timed out after 5 s", "Gemini unavailable", "too many letter fixes (9 > 5)"])
      expect(reasonMessage(r).length).toBeGreaterThan(10);
  });
});

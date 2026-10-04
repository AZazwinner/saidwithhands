import { describe, expect, it } from "vitest";
import {
  fixLetter,
  removeAt,
  addReplacing,
  addSpace,
  addToken,
  ambiguousAlternative,
  deleteLast,
  rawText,
  toPositions,
  type Token,
} from "./transcript";

const L = (v: string, p = 0.9): Token => ({ kind: "letter", v, candidates: [{ v, p }] });
const S = (v: string): Token => ({ kind: "sign", v, candidates: [{ v, p: 0.9 }] });

describe("transcript", () => {
  it("builds words from letters and spaces", () => {
    let ts: Token[] = [];
    for (const t of [L("H"), L("I")]) ts = addToken(ts, t);
    ts = addSpace(ts);
    ts = addToken(ts, L("A"));
    expect(rawText(ts)).toBe("HI A");
  });

  it("ignores leading and repeated spaces", () => {
    expect(addSpace([])).toEqual([]);
    expect(addSpace(addSpace([L("A")]))).toHaveLength(2);
  });

  it("puts signs in as separate words", () => {
    expect(rawText([L("M"), L("Y"), S("my medication"), L("O")])).toBe("MY MY MEDICATION O");
  });

  it("deletes the last token", () => {
    expect(rawText(deleteLast([L("A"), L("B")]))).toBe("A");
    expect(deleteLast([])).toEqual([]);
  });

  it("exports numbered positions with rounded candidates, trailing spaces trimmed", () => {
    const ts: Token[] = [
      {
        kind: "letter",
        v: "M",
        candidates: [
          { v: "M", p: 0.6123 },
          { v: "N", p: 0.3877 },
        ],
      },
      { kind: "space" },
      S("MY MEDICATION"),
      { kind: "space" },
    ];
    expect(toPositions(ts)).toEqual([
      {
        pos: 1,
        kind: "letter",
        candidates: [
          { v: "M", p: 0.61 },
          { v: "N", p: 0.39 },
        ],
      },
      { pos: 2, kind: "space", candidates: [{ v: " ", p: 1 }] },
      { pos: 3, kind: "sign", candidates: [{ v: "MY MEDICATION", p: 0.9 }] },
    ]);
  });
});

describe("ambiguousAlternative", () => {
  const sets = [["M", "N"]];
  const tok = (cands: [string, number][]): Token => ({
    kind: "letter",
    v: cands[0][0],
    candidates: cands.map(([v, p]) => ({ v, p })),
  });
  it("returns the close runner-up from the same set", () => {
    expect(
      ambiguousAlternative(
        tok([
          ["M", 0.5],
          ["N", 0.4],
        ]),
        sets,
      ),
    ).toBe("N");
  });
  it("is null when the runner-up is far behind or outside the set", () => {
    expect(
      ambiguousAlternative(
        tok([
          ["M", 0.8],
          ["N", 0.1],
        ]),
        sets,
      ),
    ).toBeNull();
    expect(
      ambiguousAlternative(
        tok([
          ["M", 0.5],
          ["B", 0.45],
        ]),
        sets,
      ),
    ).toBeNull();
  });
});

describe("addReplacing", () => {
  it("removes the retracted letter only if it was the last token", () => {
    expect(rawText(addReplacing([L("H"), L("S")], S("thank you"), "S"))).toBe("H THANK YOU");
    expect(rawText(addReplacing([L("S"), { kind: "space" }], S("thank you"), "S"))).toBe("S THANK YOU");
    expect(rawText(addReplacing([L("A")], S("thank you"), "S"))).toBe("A THANK YOU");
  });

  it("presses the key for a sign taught as Space or Delete instead of typing it", () => {
    expect(addReplacing([L("H"), L("I")], S("[SPACE]"), undefined, "space")).toEqual([L("H"), L("I"), { kind: "space" }]);
    expect(rawText(addReplacing([L("H"), L("I")], S("[DELETE]"), undefined, "delete"))).toBe("H");
    // a letter typed from the key sign's starting handshape is retracted first, then the key is pressed
    expect(rawText(addReplacing([L("H"), L("I"), L("S")], S("[DELETE]"), "S", "delete"))).toBe("H");
  });
});

describe("fixLetter / removeAt", () => {
  it("makes the corrected letter certain and keeps alternatives", () => {
    const ts: Token[] = [
      {
        kind: "letter",
        v: "N",
        candidates: [
          { v: "N", p: 0.6 },
          { v: "M", p: 0.3 },
        ],
      },
    ];
    const out = fixLetter(ts, 0, "M");
    expect(out[0]).toMatchObject({
      v: "M",
      fixed: true,
      candidates: [
        { v: "M", p: 1 },
        { v: "N", p: 0.6 },
      ],
    });
    expect(rawText(removeAt(out, 0))).toBe("");
  });
});

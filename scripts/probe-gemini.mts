// Success-rate probe for the best-guess prompt: runs the real bestGuess() against Gemini on several
// inputs N times each and prints how often the guess is accepted (and why not). Needs GEMINI_* in
// .env.local:  npx tsx --env-file=.env.local scripts/probe-gemini.mts [runs]
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { bestGuess, type Generate } from "../src/lib/bestGuess";
import type { Position } from "../src/lib/transcript";

const RUNS = Number(process.argv[2] ?? 5);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// The free tier allows 15 requests/minute per model: stay under it (one call every ~4.5 s).
const GAP_MS = 4500;
let lastCall = 0;

const generate: Generate = async ({ system, prompt, schema, signal }) => {
  const wait = lastCall + GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const res = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL!,
    contents: prompt,
    config: {
      systemInstruction: system,
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: (process.env.PROBE_THINKING as ThinkingLevel | undefined) ?? ThinkingLevel.MINIMAL },
      abortSignal: signal,
    },
  });
  return res.text ?? "";
};

/** "I WANT TO GO" -> positions; `noSpaces` drops the word breaks like a signer who never pressed Space. */
function seq(text: string, noSpaces: boolean): Position[] {
  const out: Position[] = [];
  // {WORDS} = a taught sign; everything else is letters (and spaces).
  for (const part of text.toUpperCase().split(/(\{[^}]+\})/).filter(Boolean)) {
    if (part.startsWith("{")) {
      out.push({ pos: out.length + 1, kind: "sign", candidates: [{ v: part.slice(1, -1), p: 0.9 }] });
      continue;
    }
    out.push(...letters(part, noSpaces, out.length));
  }
  return out;
}

function letters(text: string, noSpaces: boolean, offset: number): Position[] {
  const out: Position[] = [];
  const at = () => offset + out.length + 1;
  for (const ch of text) {
    if (ch === " ") {
      if (!noSpaces) out.push({ pos: at(), kind: "space", candidates: [{ v: " ", p: 1 }] });
      continue;
    }
    // the runner-up is a plausible look-alike, never the right letter on purpose
    out.push({
      pos: at(),
      kind: "letter",
      candidates: [
        { v: ch, p: 0.8 },
        { v: ch === "T" ? "S" : "T", p: 0.2 },
      ],
    });
  }
  return out;
}

// [label, letters as signed, no word breaks?, words the sentence must contain]
const CASES: [string, string, boolean, string[]][] = [
  ["demo: pharmacy pickup", "{HELLO}{I'M DEAF}{PICK UP}{MY PRESCRIPTION}", false, ["hello", "deaf", "pick up", "prescription"]],
  ["demo: name with J and Z", "{MY NAME}JAZ", false, ["name", "jaz"]],
  ["demo: refill typo", "{I NEED}A REFIL{PLEASE}", false, ["need", "refill", "please"]],
  ["demo: refill typo, no space", "{I NEED}AREFIL{PLEASE}", false, ["need", "refill", "please"]],
  ["demo: question", "{WHERE}{WASHROOM}", false, ["where", "washroom"]],
  ["signs + run-together letters (ice cream)", "I {WANT}{TO GO TO}{WASHROOM}ANDEATICECREAM", false, ["want", "washroom", "eat", "ice cream"]],
  ["partial spaces: the screenshot (WASHUOOM)", "I WANT TOGOTOTHEWASHUOOM", false, ["want", "go", "the", "washroom"]],
  ["no spaces: the screenshot (TOILST)", "I WANT TO GO TO THE TOILST", true, ["want", "go", "the", "toilet"]],
  ["no spaces: medication", "I NEED MY MEDICATION", true, ["need", "medication"]],
  ["spaces: medication", "I NEED MY MEDICATION", false, ["need", "medication"]],
  ["spaces: single word", "PHARMCY", false, ["pharmacy"]],
  ["no spaces: short", "MY NAME IS VICTOR", true, ["name", "victor"]],
];

for (const [name, text, noSpaces, expect] of CASES) {
  let ok = 0;
  const reasons: string[] = [];
  let sample = "";
  for (let i = 0; i < RUNS; i++) {
    const r = await bestGuess({ positions: seq(text, noSpaces), question: false }, generate, 20000);
    if (!r.ok) reasons.push(r.reason);
    else if (!expect.every((w) => r.sentence.toLowerCase().includes(w))) reasons.push(`accepted but wrong: "${r.sentence}"`);
    else {
      ok++;
      sample = r.sentence;
    }
  }
  console.log(`${ok}/${RUNS}  ${name}${sample ? `  -> ${sample}` : ""}`);
  for (const r of new Set(reasons)) console.log(`        x ${r.replace(/\s+/g, " ").slice(0, 110)}`);
}

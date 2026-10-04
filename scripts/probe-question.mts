// Run: npx tsx --env-file=.env.local scripts/probe-question.mts
// Does Gemini infer questions on its own (no question flag)? Paced under the free-tier limit.
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { bestGuess, type Generate } from "../src/lib/bestGuess";
import type { Position } from "../src/lib/transcript";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
let last = 0;
const generate: Generate = async ({ system, prompt, schema, signal }) => {
  const wait = last + 4500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const res = await ai.models.generateContent({ model: process.env.GEMINI_MODEL!, contents: prompt, config: { systemInstruction: system, responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0.2, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, abortSignal: signal } });
  return res.text ?? "";
};
function seq(text: string): Position[] {
  const out: Position[] = [];
  for (const part of text.split(/(\{[^}]+\})/).filter(Boolean)) {
    if (part.startsWith("{")) { out.push({ pos: out.length + 1, kind: "sign", candidates: [{ v: part.slice(1, -1), p: 0.9 }] }); continue; }
    for (const ch of part) out.push(ch === " " ? { pos: out.length + 1, kind: "space", candidates: [{ v: " ", p: 1 }] } : { pos: out.length + 1, kind: "letter", candidates: [{ v: ch, p: 0.8 }, { v: ch === "T" ? "S" : "T", p: 0.2 }] });
  }
  return out;
}
const CASES: [string, boolean][] = [
  ["{WHERE}{WASHROOM}", true],
  ["HOW MUCH", true],
  ["WHAT TIME {PICK UP}", true],
  ["CAN I PAY CARD", true],
  ["{HELLO}{I'M DEAF}{PICK UP}{MY PRESCRIPTION}", false],
  ["{WANT}A REFIL{PLEASE}", false],
  ["MY NAME JAZ", false],
];
for (const [text, isQ] of CASES) {
  const got: string[] = [];
  let right = 0;
  for (let i = 0; i < 3; i++) {
    const r = await bestGuess({ positions: seq(text) }, generate, 20000);
    got.push(r.sentence);
    if (r.ok && r.sentence.trim().endsWith("?") === isQ) right++;
  }
  console.log(`${right}/3  ${isQ ? "question " : "statement"}  ${text}  -> ${[...new Set(got)].join(" | ")}`);
}

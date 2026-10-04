import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import {
  bestGuess,
  MAX_BODY_BYTES,
  publicReason,
  sanitizeRequest,
  validateRequest,
  type BestGuessRequest,
  type Generate,
} from "@/lib/bestGuess";

/**
 * POST /api/best-guess  { positions, question? } -> BestGuessResult
 * Only text (recognized letters/signs) is sent to Gemini. Always responds 200 with either a validated
 * Gemini guess or the raw-signs fallback, so the client can always speak something.
 */
export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return Response.json({ error: "request too large" }, { status: 413 });
  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "request too large" }, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const invalid = validateRequest(body);
  if (invalid) return Response.json({ error: invalid }, { status: 400 });
  const req = sanitizeRequest(body as BestGuessRequest);

  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL;
  if (!apiKey || !model) {
    const r = await bestGuess(req, async () => {
      throw new Error("Gemini is not configured on the server");
    });
    return Response.json(r);
  }

  const ai = new GoogleGenAI({ apiKey });
  const generate: Generate = async ({ system, prompt, schema, signal }) => {
    const res = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseJsonSchema: schema,
        temperature: 0.2,
        // LOW, not MINIMAL: with MINIMAL the small model often rewrote run-together letters instead of
        // splitting them (same ~1.5 s latency; see scripts/probe-gemini.mts).
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        // The 5 s limit is enforced by bestGuess() via this signal. (Gemini rejects server deadlines
        // under 10 s, so httpOptions.timeout can't be used for it.)
        abortSignal: signal,
      },
    });
    return res.text ?? "";
  };

  const result = await bestGuess(req, generate);
  if (!result.ok) {
    // Keep provider error details in the server log; the browser only gets a category.
    console.warn("[best-guess] fallback:", result.reason.slice(0, 300));
    return Response.json({ ...result, reason: publicReason(result.reason) });
  }
  return Response.json(result);
}

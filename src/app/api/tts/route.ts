/**
 * POST /api/tts  { text } -> audio/mpeg (ElevenLabs), or a JSON error so the client falls back to the
 * browser's speechSynthesis. Only the sentence text is sent to ElevenLabs.
 */
const MAX_CHARS = 400;
const TIMEOUT_MS = 6000;
/** 400 characters is at most a few KB even fully escaped; anything bigger isn't a real request. */
const MAX_BODY_BYTES = 16 * 1024;
/** Lowest-latency TTS model per elevenlabs.io/docs/models (checked 2026-10-03). Override with ELEVENLABS_MODEL. */
const DEFAULT_MODEL = "eleven_flash_v2_5";

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES)
    return Response.json({ error: "request too large" }, { status: 413 });
  let text: unknown;
  try {
    ({ text } = (await request.json()) as { text?: unknown });
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof text !== "string" || !text.trim() || text.length > MAX_CHARS) {
    return Response.json({ error: `text must be 1-${MAX_CHARS} characters` }, { status: 400 });
  }

  const key = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voice) return Response.json({ error: "ElevenLabs is not configured" }, { status: 503 });

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: text.trim(), model_id: process.env.ELEVENLABS_MODEL || DEFAULT_MODEL }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok || !res.body) {
      console.warn("[tts] ElevenLabs error", res.status, (await res.text().catch(() => "")).slice(0, 300));
      return Response.json({ error: "ElevenLabs unavailable" }, { status: 502 });
    }
    return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  } catch (e) {
    console.warn("[tts] request failed", String((e as Error)?.message ?? e));
    return Response.json({ error: "ElevenLabs unavailable" }, { status: 502 });
  }
}

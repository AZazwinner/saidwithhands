"use client";

export type VoiceEngine = "elevenlabs" | "browser" | "none";

let current: HTMLAudioElement | null = null;
let shared: HTMLAudioElement | null = null;

/** 0.05 s of silence (WAV), used to unlock audio playback inside the user's tap on iOS Safari. */
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

/**
 * Call synchronously inside the Speak tap/click. iOS only lets an element play audio later (after our
 * Gemini/ElevenLabs requests) if it was first started during a user gesture; same for speechSynthesis.
 */
export function primeAudio(): void {
  try {
    shared ??= new Audio();
    shared.src = SILENCE;
    void shared.play().catch(() => {});
    if (typeof speechSynthesis !== "undefined") speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  } catch {
    /* best effort */
  }
}

/** Stop anything currently being spoken. */
export function stopSpeaking(): void {
  current?.pause();
  current = null;
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}

/** Speak with the browser's built-in voice. Resolves when done (or immediately if unavailable). */
export function speakWithBrowser(text: string): Promise<VoiceEngine> {
  return new Promise((resolve) => {
    if (!text || typeof speechSynthesis === "undefined") return resolve("none");
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.onend = () => resolve("browser");
    u.onerror = () => resolve("browser");
    speechSynthesis.speak(u);
  });
}

/**
 * Speak `text`: ElevenLabs via /api/tts first, the browser voice if that fails or audio can't play.
 * Resolves with the engine used, once speech has finished.
 */
export async function speak(text: string, timeoutMs = 7000): Promise<VoiceEngine> {
  stopSpeaking();
  if (!text.trim()) return "none";
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !res.headers.get("content-type")?.startsWith("audio/"))
      throw new Error(`tts ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const audio = shared ?? new Audio();
    audio.src = url;
    current = audio;
    await audio.play(); // throws if autoplay is blocked
    await new Promise<void>((resolve) => {
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      audio.onpause = () => resolve();
    });
    URL.revokeObjectURL(url);
    return "elevenlabs";
  } catch (e) {
    console.warn("[voice] ElevenLabs unavailable, using browser voice:", (e as Error)?.message ?? e);
    return speakWithBrowser(text);
  }
}

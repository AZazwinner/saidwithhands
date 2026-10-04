"use client";

import { rawSentence, TIMEOUT_MS, type BestGuessResult } from "./bestGuess";
import type { Position } from "./transcript";

/**
 * Ask the server for a best guess. Never throws: on network errors or a client-side timeout
 * (server timeout + 1 s) it falls back to the raw recognized text.
 */
/** Whether it's a question is decided by the model from the signs (facial expressions aren't captured). */
export async function requestBestGuess(positions: Position[]): Promise<BestGuessResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS + 1000);
  try {
    const res = await fetch("/api/best-guess", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positions }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`server error ${res.status}`);
    return (await res.json()) as BestGuessResult;
  } catch (e) {
    return {
      ok: false,
      source: "raw",
      reason: ctrl.signal.aborted ? "timed out" : navigator.onLine ? String((e as Error).message) : "offline",
      sentence: rawSentence(positions),
    };
  } finally {
    clearTimeout(timer);
  }
}

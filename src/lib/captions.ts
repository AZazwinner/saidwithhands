/**
 * Reply captions bookkeeping (pure). The Web Speech API reports a cumulative result list per
 * recognition session; Chrome ends sessions after silence and we restart them, so finished lines from
 * earlier sessions are kept separately.
 */
export type SpeechResultLike = { isFinal: boolean; transcript: string };

export type Captions = { lines: string[]; interim: string };

export const EMPTY_CAPTIONS: Captions = { lines: [], interim: "" };
export const MAX_LINES = 6;

/** Split a session's cumulative results into final lines and the current interim text. */
export function sessionText(results: readonly SpeechResultLike[]): { finals: string[]; interim: string } {
  const finals: string[] = [];
  let interim = "";
  for (const r of results) {
    const t = r.transcript.trim();
    if (!t) continue;
    if (r.isFinal) finals.push(t);
    else interim += (interim ? " " : "") + t;
  }
  return { finals, interim };
}

/** Captions to show: lines committed from earlier sessions + this session's finals, newest last. */
export function mergeCaptions(committed: readonly string[], results: readonly SpeechResultLike[]): Captions {
  const { finals, interim } = sessionText(results);
  return { lines: [...committed, ...finals].slice(-MAX_LINES), interim };
}

/** When a session ends, its final lines become committed. */
export function commitSession(committed: readonly string[], results: readonly SpeechResultLike[]): string[] {
  return [...committed, ...sessionText(results).finals].slice(-MAX_LINES);
}

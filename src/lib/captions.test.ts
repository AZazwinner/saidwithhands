import { describe, expect, it } from "vitest";
import { MAX_LINES, commitSession, mergeCaptions, sessionText } from "./captions";

const F = (transcript: string) => ({ isFinal: true, transcript });
const I = (transcript: string) => ({ isFinal: false, transcript });

describe("captions", () => {
  it("separates final lines from interim text", () => {
    expect(sessionText([F("Hello there."), I("what can"), I("I get you")])).toEqual({
      finals: ["Hello there."],
      interim: "what can I get you",
    });
  });

  it("keeps lines from earlier sessions when the recognizer restarts", () => {
    const committed = commitSession([], [F("Hi."), I("ignored when the session ends")]);
    expect(committed).toEqual(["Hi."]);
    expect(mergeCaptions(committed, [I("Your name")])).toEqual({ lines: ["Hi."], interim: "Your name" });
  });

  it("caps the number of lines shown", () => {
    const many = Array.from({ length: MAX_LINES + 3 }, (_, i) => F(`line ${i}`));
    const c = mergeCaptions([], many);
    expect(c.lines).toHaveLength(MAX_LINES);
    expect(c.lines.at(-1)).toBe(`line ${MAX_LINES + 2}`);
  });

  it("ignores empty results", () => {
    expect(sessionText([F("  "), I("")])).toEqual({ finals: [], interim: "" });
  });
});

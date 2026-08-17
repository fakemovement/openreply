import { describe, expect, it } from "vitest";
import { matchKeywords } from "../lib/utils/keyword-matcher";

// Mirrors the live FRAMES campaign: keywords ["FRAMES"], wholeWordMatch on.
// matchKeywords returns { matched, matchedKeyword }, so read .matched — a bare
// Boolean() on the result is always true and silently passes everything.
const fire = (text: string) => matchKeywords(text, ["FRAMES"], true).matched;

describe("FRAMES keyword guard", () => {
  it("fires on the real thing, however people type it", () => {
    expect(fire("FRAMES")).toBe(true);
    expect(fire("frames")).toBe(true);
    expect(fire("Frames please!")).toBe(true);
    expect(fire("send me frames 🙏")).toBe(true);
    expect(fire("FRAMES!!!")).toBe(true);
  });

  it("does NOT fire on words that merely contain it", () => {
    expect(fire("timeframes")).toBe(false);
    expect(fire("what are the timeframes here")).toBe(false);
    expect(fire("mainframes")).toBe(false);
    expect(fire("wireframes")).toBe(false);
    expect(fire("keyframes")).toBe(false);
  });

  it("would fire on all of those if whole-word matching were off", () => {
    expect(matchKeywords("timeframes", ["FRAMES"], false).matched).toBe(true);
  });
});

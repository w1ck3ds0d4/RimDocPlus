import { describe, expect, it } from "vitest";
import { howItEnded } from "./runOutcome";
import type { GameExit } from "./shell";

const ended = (over: Partial<GameExit>): GameExit => ({
  code: 0,
  durationMs: 60_000,
  lines: 100,
  peakMemoryMb: 1024,
  wentQuiet: false,
  ...over,
});

describe("howItEnded", () => {
  it("names a killed process, which is what a code of -1 on Windows means", () => {
    // Verified against a real run: killing RimWorld with Stop-Process -Force gives -1, and
    // the app used to report that as a bare "exited with code -1".
    expect(howItEnded(ended({ code: -1 }))).toBe(
      "It was killed rather than closing on its own. RimWorld ended with code -1 (0xFFFFFFFF) after 1 minute.",
    );
  });

  it("names an access violation", () => {
    expect(howItEnded(ended({ code: -1073741819, durationMs: 300_000 }))).toContain("access violation");
    expect(howItEnded(ended({ code: -1073741819 }))).toContain("0xC0000005");
  });

  it("prints an unrecognised code in both forms without guessing at it", () => {
    const said = howItEnded(ended({ code: -1073740791 }));
    expect(said).toBe("RimWorld exited with code -1073740791 (0xC0000409) after 1 minute.");
  });

  it("does not print hex for an ordinary positive code", () => {
    expect(howItEnded(ended({ code: 3 }))).toBe("RimWorld exited with code 3 after 1 minute.");
  });

  it("describes a clean exit reached only because the log went quiet", () => {
    // The only way this function is called with a zero code: the run ended fine but stopped
    // writing long before it did, which is its own thing worth saying.
    expect(howItEnded(ended({ code: 0, wentQuiet: true, durationMs: 1_260_000 }))).toBe(
      "RimWorld stopped writing to its log well before it closed, after 21 minutes.",
    );
  });
});

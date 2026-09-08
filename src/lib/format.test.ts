import { describe, expect, it } from "vitest";
import { formatBytes, formatMs, percent } from "./format";

describe("formatBytes", () => {
  it("uses the largest unit that leaves a number worth reading", () => {
    expect(formatBytes(1024 ** 3 * 15.5)).toBe("15.5 GB");
    expect(formatBytes(1024 ** 2 * 40)).toBe("40 MB");
    expect(formatBytes(4096)).toBe("4 KB");
  });

  it("never reports a file that exists as nothing", () => {
    // The floor these functions were gathered to enforce: one copy of this stopped at
    // megabytes and rounded small files to "0 KB", which reads as absent rather than small.
    expect(formatBytes(1)).toBe("1 KB");
    expect(formatBytes(0)).toBe("1 KB");
  });
});

describe("formatMs", () => {
  it("switches to seconds at a second, with one decimal and no more", () => {
    // A second decimal would be false precision about a number the OS rounded first.
    expect(formatMs(999)).toBe("999 ms");
    expect(formatMs(1000)).toBe("1.0 s");
    expect(formatMs(13_240)).toBe("13.2 s");
  });
});

describe("percent", () => {
  it("returns zero rather than NaN before a total is known", () => {
    // A progress bar renders before its total arrives. Unguarded, 0/0 lands in a CSS width
    // and the bar disappears instead of sitting at zero.
    expect(percent(0, 0)).toBe(0);
    expect(percent(5, Number.NaN)).toBe(0);
    expect(percent(5, -1)).toBe(0);
  });

  it("rounds to a whole percentage", () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(225, 225)).toBe(100);
  });
});

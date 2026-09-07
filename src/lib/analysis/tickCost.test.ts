import { describe, expect, it } from "vitest";
import { isTicking, parseTickReport, tickCostRows, tickCoverage, type TickReport } from "./tickCost";

function report(over: Partial<TickReport> = {}): TickReport {
  return {
    schema: 1,
    gameVersion: "1.6.4871 rev591",
    uptimeSeconds: 120,
    patchedMethods: 846,
    ticksPlayed: 5000,
    mods: [],
    ...over,
  };
}

describe("parseTickReport", () => {
  it("reads a report the probe wrote", () => {
    const parsed = parseTickReport(JSON.stringify(report()));
    expect(parsed?.patchedMethods).toBe(846);
  });

  it("returns null rather than throwing on anything else", () => {
    // The file is written by another process every five seconds, so the ordinary failures
    // are that it does not exist yet or was read halfway through being replaced. Neither is
    // worth an error on screen.
    expect(parseTickReport(null)).toBeNull();
    expect(parseTickReport("")).toBeNull();
    expect(parseTickReport("{ half a docum")).toBeNull();
    expect(parseTickReport("[]")).toBeNull();
    expect(parseTickReport(JSON.stringify({ schema: 99, mods: [] }))).toBeNull();
  });
});

describe("tickCostRows", () => {
  const measured = report({
    mods: [
      { assembly: "Cheap", packageId: "c.one", mod: "Cheap Mod", calls: 100000, ms: 50 },
      { assembly: "Heavy", packageId: "h.one", mod: "Heavy Mod", calls: 1000, ms: 150 },
      { assembly: "Idle", packageId: "i.one", mod: "Idle Mod", calls: 0, ms: 0 },
    ],
  });

  it("ranks by what a mod actually costs you", () => {
    const rows = tickCostRows(measured);
    expect(rows.map((r) => r.mod)).toEqual(["Heavy Mod", "Cheap Mod"]);
    expect(rows[0].share).toBeCloseTo(0.75);
  });

  it("also says what each call costs, which is a different question", () => {
    // Cheap Mod costs more calls and less time each; Heavy Mod the reverse. A ranking by
    // total alone would not separate "called constantly" from "slow every time".
    const rows = tickCostRows(measured);
    expect(rows[0].perThousand).toBeCloseTo(150);
    expect(rows[1].perThousand).toBeCloseTo(0.5);
  });

  it("drops what was never called", () => {
    expect(tickCostRows(measured).some((r) => r.mod === "Idle Mod")).toBe(false);
  });

  it("does not divide by zero before anything has ticked", () => {
    const rows = tickCostRows(report({ mods: [] }));
    expect(rows).toEqual([]);
  });
});

describe("isTicking", () => {
  it("is the one thing that cannot be known from outside the process", () => {
    // A game hung an hour into a colony looks exactly like one sitting at the main menu,
    // from out here. A tick count that climbed is the difference.
    expect(isTicking(report({ ticksPlayed: 100 }), report({ ticksPlayed: 220 }))).toBe(true);
    expect(isTicking(report({ ticksPlayed: 100 }), report({ ticksPlayed: 100 }))).toBe(false);
    expect(isTicking(null, report())).toBe(false);
  });
});

describe("tickCoverage", () => {
  it("says the numbers are empty because nothing has ticked, not because nothing costs anything", () => {
    expect(tickCoverage(report({ ticksPlayed: 0 }))).toContain("load a colony");
  });

  it("names what it cannot see", () => {
    const said = tickCoverage(report());
    expect(said).toContain("drawing");
    expect(said).toContain("own threads");
  });
});

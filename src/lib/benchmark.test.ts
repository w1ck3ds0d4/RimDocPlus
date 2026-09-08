import { describe, expect, it } from "vitest";
import { compareRuns, formatMeasure, measureRun, type RunMeasurement } from "./benchmark";
import type { GameExit } from "./shell";
import type { SessionAnalysis } from "./analysis/logParser";

function run(over: Partial<RunMeasurement> = {}): RunMeasurement {
  return {
    modpack: "Test",
    at: "2026-01-01T00:00:00.000Z",
    mods: 200,
    durationMs: 600_000,
    peakMemoryMb: 4096,
    logLines: 2000,
    faults: 10,
    phases: [],
    loadMs: 30_000,
    ...over,
  };
}

describe("measureRun", () => {
  it("adds the startup phases up into the load time", () => {
    const exit: GameExit = {
      code: 0,
      durationMs: 900_000,
      lines: 2162,
      peakMemoryMb: 3140,
      wentQuiet: false,
    };
    const analysis = {
      environment: {},
      events: [{}, {}, {}],
      timings: [
        { label: "Prepatcher", ms: 4000 },
        { label: "Defs", ms: 9000 },
      ],
      totalLines: 2162,
    } as unknown as SessionAnalysis;

    const measured = measureRun("Modded Game Setup", 225, exit, analysis);

    expect(measured.loadMs).toBe(13_000);
    expect(measured.faults).toBe(3);
    expect(measured.peakMemoryMb).toBe(3140);
  });
});

describe("compareRuns", () => {
  it("reads positive as b being worse, whichever direction the number runs", () => {
    // The one thing a comparison has to get right. Both rows go up, and up is worse for
    // both: more milliseconds and more faults.
    const rows = compareRuns(run({ loadMs: 20_000, faults: 5 }), run({ loadMs: 30_000, faults: 8 }));
    const load = rows.find((r) => r.label === "Load time");
    expect(load?.deltaPct).toBe(50);
    expect(rows.find((r) => r.label === "Faults")?.deltaPct).toBe(60);
  });

  it("drops a measure neither run carries", () => {
    // A run that crashed has no load time, and pairing it against a healthy one would put a
    // number on screen that looks like a comparison and is not.
    const rows = compareRuns(run({ loadMs: 0, faults: 0 }), run({ loadMs: 0, faults: 0 }));
    expect(rows.map((r) => r.label)).not.toContain("Load time");
    expect(rows.map((r) => r.label)).not.toContain("Faults");
    expect(rows.map((r) => r.label)).toContain("Peak memory");
  });

  it("keeps a measure only one run carries, and calls it a whole change", () => {
    // Nothing to nothing is no change; nothing to something has no percentage, and 100 is
    // the honest reading of "this appeared".
    const rows = compareRuns(run({ loadMs: 0 }), run({ loadMs: 30_000 }));
    expect(rows.find((r) => r.label === "Load time")?.deltaPct).toBe(100);
  });

  it("says nothing changed when nothing did", () => {
    for (const row of compareRuns(run(), run())) expect(row.deltaPct).toBe(0);
  });
});

describe("formatMeasure", () => {
  it("turns memory into gigabytes once there are enough of them", () => {
    expect(formatMeasure(512, "mb")).toBe("512 MB");
    expect(formatMeasure(1024, "mb")).toBe("1.0 GB");
    expect(formatMeasure(3140, "mb")).toBe("3.1 GB");
  });

  it("leaves a count alone", () => {
    expect(formatMeasure(26, "count")).toBe("26");
  });
});

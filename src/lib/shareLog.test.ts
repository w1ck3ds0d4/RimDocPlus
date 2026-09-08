import { describe, expect, it } from "vitest";
import { buildReport } from "./shareLog";
import type { Finding, ModEntry, ScanResult } from "./types";
import type { SessionAnalysis } from "./analysis/logParser";

const ANALYSIS: SessionAnalysis = {
  environment: { unityVersion: "2022.3.35f1" },
  events: [],
  timings: [],
  totalLines: 100,
};

function mod(packageId: string): ModEntry {
  return {
    packageId,
    name: packageId,
    folder: `C:/mods/${packageId}`,
    source: "steam",
    supportedVersions: ["1.6"],
    dependencies: [],
    incompatibleWith: [],
    loadAfter: [],
    loadBefore: [],
    hasAssemblies: false,
    hasPatches: false,
    sizeBytes: 0,
    active: true,
    loadIndex: 0,
  };
}

const SCAN: ScanResult = {
  scannedAt: "2026-01-01T00:00:00.000Z",
  gameVersion: "1.6.4871 rev591",
  gameCycle: "1.6",
  paths: {},
  mods: [mod("a.one")],
  activeOrder: ["a.one"],
};

function finding(over: Partial<Finding>): Finding {
  return {
    id: over.title ?? "f",
    rule: "log:exception",
    severity: "error",
    title: "A fault",
    detail: "",
    packageIds: [],
    ...over,
  };
}

const report = (findings: Finding[], statics: Finding[] = []) =>
  buildReport(ANALYSIS, findings, SCAN, "Player.log", statics);

describe("buildReport", () => {
  it("puts the worst first, because a pasted report is read from the top", () => {
    const text = report([
      finding({ severity: "info", title: "An observation" }),
      finding({ severity: "critical", title: "A crash" }),
      finding({ severity: "warning", title: "A warning" }),
    ]);
    const order = text
      .split("\n")
      .filter((l) => l.startsWith("["))
      .map((l) => l.slice(1, l.indexOf("]")));
    expect(order).toEqual(["critical", "warning", "info"]);
  });

  it("counts the severities in the header, which the screen already showed", () => {
    const text = report([
      finding({ severity: "critical", title: "A crash" }),
      finding({ severity: "error", title: "One" }),
      finding({ severity: "error", title: "Two" }),
    ]);
    expect(text).toContain("Faults (3): 1 critical, 2 error");
  });

  it("marks what is not work waiting, on the line itself", () => {
    // A report is pasted and quoted in pieces, so a line that travels alone has to carry
    // its own meaning. A section heading further up does not survive the quoting.
    const text = report([
      finding({ title: "Already gone", stale: "the scan proves it" }),
      finding({ title: "Never a defect", observation: true }),
      finding({ title: "Real work" }),
    ]);
    expect(text).toContain("Already gone [already fixed]");
    expect(text).toContain("Never a defect [not a fault]");
    expect(text).toContain("[error] Real work\n");
  });

  it("leads a trace with the frames that name a mod", () => {
    // The first two frames of a RimWorld trace are engine internals that belong to any of
    // 253 mods equally. The Harmony annotations are the whole reason a trace is pasted.
    const text = report([
      finding({
        title: "A fault",
        frames: [
          "at Verse.Find.get_FactionManager () [0x00005] in <x>:0",
          "at RimWorld.Faction.get_OfPlayerSilentFail () [0x00020] in <x>:0",
          "  - PREFIX Orion.Hospitality: Boolean Hospitality.Patches.Pawn_NeedsTracker_Patch:Prefix()",
          "at SomeMod.Thing.Tick () [0x00000] in <y>:0",
        ],
      }),
    ]);
    expect(text).toContain("- PREFIX Orion.Hospitality");
    expect(text).toContain("at SomeMod.Thing.Tick");
    expect(text).not.toContain("get_FactionManager");
  });

  it("carries the scan findings a helper asks for first, and no others", () => {
    const text = report(
      [finding({ title: "From the log" })],
      [
        finding({ rule: "version-mismatch", title: "Six mods are not built for 1.6" }),
        finding({ rule: "patch-override", title: "A overrides B" }),
      ],
    );
    // "Which of these is not updated yet" is the first question. A load order collision is
    // about a list the reader is already looking at.
    expect(text).toContain("Six mods are not built for 1.6");
    expect(text).not.toContain("A overrides B");
  });
});

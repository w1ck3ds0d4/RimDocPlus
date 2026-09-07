import { describe, expect, it } from "vitest";
import { compare } from "./installDiff";
import type { ModEntry, ScanResult } from "./types";

function mod(packageId: string, over: Partial<ModEntry> = {}): ModEntry {
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
    loadIndex: null,
    ...over,
  };
}

function scanOf(mods: ModEntry[], scannedAt = "2026-02-01T00:00:00.000Z"): ScanResult {
  return {
    scannedAt,
    gameVersion: "1.6.4871 rev590",
    gameCycle: "1.6",
    paths: { saveData: "C:/save" },
    mods,
    activeOrder: mods.map((m) => m.packageId),
  };
}

function snapshotOf(mods: ModEntry[], scannedAt = "2026-01-01T00:00:00.000Z") {
  return {
    scannedAt,
    mods: Object.fromEntries(mods.map((m) => [m.packageId, { name: m.name, updatedAt: m.updatedAt }])),
  };
}

describe("compare", () => {
  it("reports the first scan as a baseline rather than as 253 additions", () => {
    const diff = compare(null, scanOf([mod("a.one"), mod("b.two")]));
    expect(diff.baseline).toBe(true);
    expect(diff.added).toHaveLength(0);
  });

  it("separates what appeared, what went and what Steam replaced underneath you", () => {
    const before = snapshotOf([
      mod("kept.same", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      mod("changed.mod", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      mod("gone.mod"),
    ]);
    const now = scanOf([
      mod("kept.same", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      mod("changed.mod", { updatedAt: "2026-02-01T09:30:00.000Z" }),
      mod("new.mod"),
    ]);

    const diff = compare(before, now);

    expect(diff.added.map((m) => m.packageId)).toEqual(["new.mod"]);
    expect(diff.updated.map((m) => m.packageId)).toEqual(["changed.mod"]);
    expect(diff.removed.map((m) => m.packageId)).toEqual(["gone.mod"]);
    expect(diff.since).toBe("2026-01-01T00:00:00.000Z");
  });

  /**
   * A mod with no folder mtime on either side is unchanged as far as anything here can
   * tell. Calling that an update would put a row in the feed every single scan.
   */
  it("does not call a mod updated when neither scan knew its date", () => {
    const diff = compare(snapshotOf([mod("no.date")]), scanOf([mod("no.date")]));
    expect(diff.updated).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
  });

  it("treats a mod that only just gained a date as unchanged", () => {
    const diff = compare(
      snapshotOf([mod("late.date")]),
      scanOf([mod("late.date", { updatedAt: "2026-02-01T00:00:00.000Z" })]),
    );
    expect(diff.updated).toHaveLength(0);
  });

  it("carries the scan it describes, so a reload is not a fresh comparison", () => {
    const diff = compare(snapshotOf([]), scanOf([mod("a.one")], "2026-03-03T12:00:00.000Z"));
    expect(diff.scannedAt).toBe("2026-03-03T12:00:00.000Z");
  });
});

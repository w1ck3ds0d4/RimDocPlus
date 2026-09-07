import { describe, expect, it } from "vitest";
import { compareSave, isRisky, type SaveMeta } from "./saves";
import type { ModEntry, ScanResult } from "./types";

function mod(packageId: string, name = packageId): ModEntry {
  return {
    packageId,
    name,
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
  };
}

function scanOf(ids: string[], gameVersion = "1.6.4871 rev590"): ScanResult {
  return {
    scannedAt: "2026-01-01T00:00:00.000Z",
    gameVersion,
    gameCycle: "1.6",
    paths: { saveData: "C:/save" },
    mods: ids.map((id) => mod(id)),
    activeOrder: ids,
  };
}

function save(modIds: string[], modNames?: string[], gameVersion = "1.6.4871 rev590"): SaveMeta {
  return {
    path: "C:/save/Saves/Colony.rws",
    name: "Colony",
    gameVersion,
    modIds,
    modNames: modNames ?? modIds,
  };
}

describe("comparing a save against the load order", () => {
  it("finds nothing to say when the lists match", () => {
    const result = compareSave(save(["a", "b"]), scanOf(["a", "b"]), ["a", "b"]);
    expect(result.missing).toHaveLength(0);
    expect(result.added).toHaveLength(0);
    expect(result.reordered).toBe(0);
    expect(isRisky(result)).toBe(false);
  });

  /** The save still references this mod's content everywhere, so RimWorld drops what it
   *  cannot resolve. This is the case worth interrupting someone about. */
  it("reports a mod the save expects and the list does not have", () => {
    const result = compareSave(save(["a", "b"]), scanOf(["a", "b"]), ["a"]);
    expect(result.missing.map((m) => m.packageId)).toEqual(["b"]);
    expect(isRisky(result)).toBe(true);
  });

  it("says whether a missing mod is merely disabled or gone from disk entirely", () => {
    const result = compareSave(save(["a", "b", "c"]), scanOf(["a", "b"]), ["a"]);
    expect(result.missing).toEqual([
      { packageId: "b", name: "b", installed: true },
      { packageId: "c", name: "c", installed: false },
    ]);
  });

  /** A mod uninstalled since the save is unnameable from the install, so the save's own
   *  record of what it was called is the only thing left to report. */
  it("names a mod from the save when nothing on disk can", () => {
    const meta = save(["a", "gone.mod"], ["A", "The Mod You Removed"]);
    const result = compareSave(meta, scanOf(["a"]), ["a"]);
    expect(result.missing[0].name).toBe("The Mod You Removed");
  });

  it("reports mods added since, without treating them as a problem", () => {
    const result = compareSave(save(["a"]), scanOf(["a", "b"]), ["a", "b"]);
    expect(result.added.map((m) => m.packageId)).toEqual(["b"]);
    expect(isRisky(result)).toBe(false);
  });

  it("counts shared mods that sit in a different order", () => {
    const result = compareSave(save(["a", "b", "c"]), scanOf(["a", "b", "c"]), ["c", "b", "a"]);
    expect(result.reordered).toBe(2);
  });

  /** Only mods on both sides have an order to differ in. */
  it("ignores order for a mod that is missing from one side", () => {
    const result = compareSave(save(["a", "b", "c"]), scanOf(["a", "c"]), ["a", "c"]);
    expect(result.reordered).toBe(0);
  });
});

describe("game version", () => {
  it("ignores the build number, which changes on every patch", () => {
    const result = compareSave(save(["a"], ["a"], "1.6.4871 rev591"), scanOf(["a"], "1.6.4871 rev590"), [
      "a",
    ]);
    expect(result.gameVersionChanged).toBe(false);
  });

  it("reports a save written on a different cycle", () => {
    const result = compareSave(save(["a"], ["a"], "1.5.4243 rev myth"), scanOf(["a"]), ["a"]);
    expect(result.gameVersionChanged).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { ruleBundledAssemblies, ruleWorkshopUpdates } from "./packaging";
import type { ModEntry, WorkshopCache, WorkshopDetails } from "../types";

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
    loadIndex: 0,
    ...over,
  };
}

describe("bundled assemblies", () => {
  it("says nothing when every assembly belongs to one mod", () => {
    const mods = [
      mod("a.one", { assemblies: ["a.dll", "shared-by-nobody.dll"] }),
      mod("b.two", { assemblies: ["b.dll"] }),
    ];
    expect(ruleBundledAssemblies(mods)).toHaveLength(0);
  });

  it("names every mod shipping the same library", () => {
    const mods = [
      mod("a.one", { name: "One", assemblies: ["0harmony.dll"] }),
      mod("b.two", { name: "Two", assemblies: ["0harmony.dll"] }),
      mod("c.three", { name: "Three", assemblies: ["c.dll"] }),
    ];
    const [finding] = ruleBundledAssemblies(mods);
    expect(finding.title).toContain("0harmony.dll");
    expect(finding.detail).toContain("One");
    expect(finding.detail).toContain("Two");
    expect(finding.detail).not.toContain("Three");
    expect(finding.packageIds).toEqual(["a.one", "b.two"]);
  });

  /** Harmony shipping 0Harmony.dll is Harmony, not a mod bundling someone else's library. */
  it("names the library's rightful owner when one is installed", () => {
    const mods = [
      mod("brrainz.harmony", { name: "Harmony", assemblies: ["0harmony.dll"] }),
      mod("a.one", { assemblies: ["0harmony.dll"] }),
    ];
    expect(ruleBundledAssemblies(mods)[0].detail).toContain("belongs to Harmony");
  });

  it("carries no repair, since removing a bundled library is the author's call", () => {
    const mods = [mod("a.one", { assemblies: ["x.dll"] }), mod("b.two", { assemblies: ["x.dll"] })];
    expect(ruleBundledAssemblies(mods)[0].fix).toBeUndefined();
  });
});

describe("workshop updates", () => {
  const DAY = 86_400_000;
  const published = (steamId: string, at: number): WorkshopCache => ({
    fetchedAt: "2026-01-01T00:00:00.000Z",
    items: { [steamId]: { timeUpdated: Math.floor(at / 1000) } as WorkshopDetails },
  });

  const local = (iso: string) => mod("a.one", { name: "One", steamId: "1", updatedAt: iso });

  it("reports a mod the Workshop updated after the local copy", () => {
    const base = Date.parse("2026-03-01T00:00:00.000Z");
    const [finding] = ruleWorkshopUpdates(
      [local(new Date(base).toISOString())],
      published("1", base + 7 * DAY),
    );
    expect(finding.title).toContain("1 mod");
    expect(finding.detail).toContain("7d behind");
  });

  /**
   * Folder time is a proxy, not a version. A day of slack keeps timezone and touched-on-copy
   * noise from reporting the whole library as stale on every scan.
   */
  it("ignores a gap too small to mean anything", () => {
    const base = Date.parse("2026-03-01T00:00:00.000Z");
    expect(
      ruleWorkshopUpdates([local(new Date(base).toISOString())], published("1", base + DAY)),
    ).toHaveLength(0);
  });

  it("says nothing when the local copy is the newer one", () => {
    const base = Date.parse("2026-03-01T00:00:00.000Z");
    expect(
      ruleWorkshopUpdates([local(new Date(base).toISOString())], published("1", base - 30 * DAY)),
    ).toHaveLength(0);
  });

  /** The app works offline, so every rule reading fetched data reports nothing without it. */
  it("reports nothing at all without Workshop data", () => {
    expect(ruleWorkshopUpdates([local("2026-03-01T00:00:00.000Z")], null)).toHaveLength(0);
  });

  it("skips a mod with no Workshop id or no local date to compare", () => {
    const noId = mod("a.one", { updatedAt: "2026-03-01T00:00:00.000Z" });
    const noDate = mod("b.two", { steamId: "1" });
    expect(ruleWorkshopUpdates([noId, noDate], published("1", Date.now()))).toHaveLength(0);
  });
});

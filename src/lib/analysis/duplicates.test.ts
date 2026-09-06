import { describe, expect, it } from "vitest";
import type { ModEntry, WorkshopCache } from "../types";
import { rankDuplicates } from "./duplicates";

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

function workshopOf(entries: Record<string, { subscriptions: number; timeUpdated: number }>): WorkshopCache {
  return {
    fetchedAt: "2026-01-01T00:00:00.000Z",
    items: Object.fromEntries(
      Object.entries(entries).map(([id, v]) => [
        id,
        {
          id,
          title: id,
          subscriptions: v.subscriptions,
          favorited: 0,
          views: 0,
          timeUpdated: v.timeUpdated,
          timeCreated: 0,
          fileSize: 0,
          tags: [],
        },
      ]),
    ),
  };
}

const DAY = 86400;
const BASE = 1_750_000_000;

describe("rankDuplicates", () => {
  it("says nothing when there is only one copy", () => {
    expect(rankDuplicates([mod("a.one")], "1.6", null)).toBeNull();
  });

  it("prefers a local copy, since putting one there is a deliberate pin", () => {
    const copies = [
      mod("a.one", { name: "Workshop copy", steamId: "1" }),
      mod("a.one", { name: "Local copy", source: "local", folder: "C:/game/Mods/a" }),
    ];
    const ranking = rankDuplicates(
      copies,
      "1.6",
      workshopOf({ "1": { subscriptions: 9999, timeUpdated: BASE } }),
    )!;
    expect(ranking.recommended.name).toBe("Local copy");
    expect(ranking.reasons[0]).toMatch(/deliberate pin/);
  });

  it("rules out a copy that does not declare the running cycle", () => {
    const copies = [
      mod("a.one", { name: "Old", steamId: "1", supportedVersions: ["1.4"] }),
      mod("a.one", { name: "Current", steamId: "2", supportedVersions: ["1.6"], folder: "C:/mods/b" }),
    ];
    const ranking = rankDuplicates(
      copies,
      "1.6",
      workshopOf({
        // The stale copy is far more popular; version support still outranks that.
        "1": { subscriptions: 900_000, timeUpdated: BASE },
        "2": { subscriptions: 10, timeUpdated: BASE - 100 * DAY },
      }),
    )!;
    expect(ranking.recommended.name).toBe("Current");
    expect(ranking.reasons.some((r) => r.includes("do not declare") || r.includes("does not declare"))).toBe(
      true,
    );
  });

  it("prefers the more recently updated copy and says by how much", () => {
    const copies = [
      mod("a.one", { name: "Original", steamId: "1" }),
      mod("a.one", { name: "Continued", steamId: "2", folder: "C:/mods/b" }),
    ];
    const ranking = rankDuplicates(
      copies,
      "1.6",
      workshopOf({
        "1": { subscriptions: 100, timeUpdated: BASE },
        "2": { subscriptions: 50, timeUpdated: BASE + 30 * DAY },
      }),
    )!;
    expect(ranking.recommended.name).toBe("Continued");
    expect(ranking.reasons.join(" ")).toContain("30 days more recently");
  });

  it("names the subscriber gap as a caveat when it argues the other way", () => {
    // The real Hospitality case: the original is far more popular, the fork more current.
    const copies = [
      mod("orion.hospitality", { name: "Hospitality", steamId: "1" }),
      mod("orion.hospitality", { name: "Hospitality (Continued)", steamId: "2", folder: "C:/mods/b" }),
    ];
    const ranking = rankDuplicates(
      copies,
      "1.6",
      workshopOf({
        "1": { subscriptions: 787_940, timeUpdated: BASE },
        "2": { subscriptions: 195_340, timeUpdated: BASE + 398 * DAY },
      }),
    )!;
    expect(ranking.recommended.name).toBe("Hospitality (Continued)");
    expect(ranking.caveats.join(" ")).toContain("787,940");
    expect(ranking.caveats.length).toBeGreaterThan(0);
  });

  it("flags wider version support as a caveat", () => {
    const copies = [
      mod("a.one", { name: "Broad", steamId: "1", supportedVersions: ["1.4", "1.5", "1.6"] }),
      mod("a.one", { name: "Narrow", steamId: "2", supportedVersions: ["1.6"], folder: "C:/mods/b" }),
    ];
    const ranking = rankDuplicates(
      copies,
      "1.6",
      workshopOf({
        "1": { subscriptions: 10, timeUpdated: BASE },
        "2": { subscriptions: 10, timeUpdated: BASE + DAY },
      }),
    )!;
    expect(ranking.recommended.name).toBe("Narrow");
    expect(ranking.caveats.join(" ")).toContain("more game versions");
  });

  it("admits when nothing separates the copies", () => {
    const copies = [mod("a.one", { name: "A" }), mod("a.one", { name: "B", folder: "C:/mods/b" })];
    const ranking = rankDuplicates(copies, "1.6", null)!;
    expect(ranking.arbitrary).toBe(true);
    expect(ranking.reasons[0]).toMatch(/Nothing measurable/);
  });

  it("always recommends one of the copies it was given", () => {
    const copies = [mod("a.one", { name: "A" }), mod("a.one", { name: "B", folder: "C:/mods/b" })];
    const ranking = rankDuplicates(copies, "1.6", null)!;
    expect(copies).toContain(ranking.recommended);
  });
});

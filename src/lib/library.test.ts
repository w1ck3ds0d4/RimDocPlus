import { describe, expect, it } from "vitest";
import type { ModEntry, ScanResult, WorkshopCache } from "./types";
import { buildLibrary, cleanupCandidates, sortLibrary } from "./library";

const MB = 1024 ** 2;

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

function scanOf(mods: ModEntry[], activeOrder = mods.map((m) => m.packageId)): ScanResult {
  return {
    scannedAt: "2026-01-01T00:00:00.000Z",
    gameVersion: "1.6.4871 rev590",
    gameCycle: "1.6",
    paths: {},
    mods,
    activeOrder,
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

// 2026-01-01T00:00:00Z, so ages are computable without touching the clock.
const NOW = Date.UTC(2026, 0, 1);
const DAY = 86400;

describe("buildLibrary", () => {
  it("counts how many enabled mods depend on each one", () => {
    const rows = buildLibrary(
      scanOf([
        mod("a.lib"),
        mod("b.one", { dependencies: [{ packageId: "A.Lib" }] }),
        mod("c.two", { dependencies: [{ packageId: "a.lib" }] }),
      ]),
      null,
      NOW,
    );
    expect(rows.find((r) => r.mod.packageId === "a.lib")?.dependents).toBe(2);
  });

  it("ignores dependencies declared by mods that are switched off", () => {
    const rows = buildLibrary(
      scanOf([mod("a.lib"), mod("b.off", { dependencies: [{ packageId: "a.lib" }] })], ["a.lib"]),
      null,
      NOW,
    );
    expect(rows.find((r) => r.mod.packageId === "a.lib")?.dependents).toBe(0);
  });

  it("derives update age in days from the Workshop timestamp", () => {
    const rows = buildLibrary(
      scanOf([mod("a.one", { steamId: "111" })]),
      workshopOf({ "111": { subscriptions: 10, timeUpdated: NOW / 1000 - 30 * DAY } }),
      NOW,
    );
    expect(rows[0].ageDays).toBe(30);
  });

  it("leaves Workshop fields undefined for local mods", () => {
    const rows = buildLibrary(scanOf([mod("a.local", { source: "local" })]), workshopOf({}), NOW);
    expect(rows[0].workshop).toBeUndefined();
    expect(rows[0].ageDays).toBeUndefined();
  });

  it("works with no Workshop data at all", () => {
    const rows = buildLibrary(scanOf([mod("a.one", { steamId: "111" })]), null, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].workshop).toBeUndefined();
  });
});

describe("sortLibrary", () => {
  const rows = buildLibrary(
    scanOf([
      mod("a.big", { steamId: "1", loadIndex: 2, sizeBytes: 900, textures: texture(500 * MB) }),
      mod("b.small", { steamId: "2", loadIndex: 0, sizeBytes: 100, textures: texture(10 * MB) }),
      mod("c.mid", { steamId: "3", loadIndex: 1, sizeBytes: 400, textures: texture(90 * MB) }),
    ]),
    workshopOf({
      "1": { subscriptions: 10, timeUpdated: NOW / 1000 - 400 * DAY },
      "2": { subscriptions: 9000, timeUpdated: NOW / 1000 - 5 * DAY },
      "3": { subscriptions: 300, timeUpdated: NOW / 1000 - 50 * DAY },
    }),
    NOW,
  );

  it("orders by subscribers, most first", () => {
    expect(sortLibrary(rows, "subscribers").map((r) => r.mod.packageId)).toEqual([
      "b.small",
      "c.mid",
      "a.big",
    ]);
  });

  it("orders by least recently updated, since that is the end worth reading", () => {
    expect(sortLibrary(rows, "updated")[0].mod.packageId).toBe("a.big");
  });

  it("orders by texture cost and by disk size independently", () => {
    expect(sortLibrary(rows, "vram")[0].mod.packageId).toBe("a.big");
    expect(sortLibrary(rows, "size")[0].mod.packageId).toBe("a.big");
  });

  it("falls back to load order", () => {
    expect(sortLibrary(rows, "order").map((r) => r.mod.packageId)).toEqual(["b.small", "c.mid", "a.big"]);
  });

  it("does not mutate the input", () => {
    const before = rows.map((r) => r.mod.packageId);
    sortLibrary(rows, "subscribers");
    expect(rows.map((r) => r.mod.packageId)).toEqual(before);
  });
});

describe("cleanupCandidates", () => {
  it("picks heavy mods that nothing depends on", () => {
    const rows = buildLibrary(
      scanOf([
        mod("a.heavy", { textures: texture(500 * MB) }),
        mod("b.light", { textures: texture(5 * MB) }),
        mod("c.depended", { textures: texture(500 * MB) }),
        mod("d.user", { dependencies: [{ packageId: "c.depended" }] }),
      ]),
      null,
      NOW,
    );
    expect(cleanupCandidates(rows).map((r) => r.mod.packageId)).toEqual(["a.heavy"]);
  });

  it("never suggests official content", () => {
    const rows = buildLibrary(
      scanOf([mod("ludeon.rimworld", { source: "official", textures: texture(900 * MB) })]),
      null,
      NOW,
    );
    expect(cleanupCandidates(rows)).toHaveLength(0);
  });

  it("never suggests a mod that is already disabled", () => {
    const rows = buildLibrary(scanOf([mod("a.off", { textures: texture(900 * MB) })], []), null, NOW);
    expect(cleanupCandidates(rows)).toHaveLength(0);
  });
});

function texture(bytes: number) {
  return { count: 1, estimatedVramBytes: bytes, oversized: [], truncated: false };
}

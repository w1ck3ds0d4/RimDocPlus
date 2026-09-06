import type { ModEntry, ScanResult, WorkshopCache, WorkshopDetails } from "./types";

export interface LibraryRow {
  mod: ModEntry;
  workshop?: WorkshopDetails;
  /**
   * Enabled in the load order this row was built from. Derived here rather than read off
   * ModEntry.active so every field on the row agrees about which list it describes.
   */
  active: boolean;
  /** Enabled mods that declare this one as a dependency. */
  dependents: number;
  /** Decoded texture cost in bytes. */
  vramBytes: number;
  /** Days since the author last updated it, when Workshop data is available. */
  ageDays?: number;
}

export type LibrarySort = "order" | "subscribers" | "updated" | "vram" | "dependents" | "size";

/**
 * Everything known about each installed mod in one row: what it is, what depends on it,
 * what it costs, and how the wider community treats it.
 *
 * Local signals answer "what does this cost me and what breaks without it". Workshop
 * signals answer "is this maintained and does anyone else use it". Neither is a verdict
 * on its own, which is why the table shows them side by side rather than reducing them
 * to a single score.
 */
export function buildLibrary(
  scan: ScanResult,
  workshop: WorkshopCache | null,
  now = Date.now(),
): LibraryRow[] {
  const active = new Set(scan.activeOrder);
  const dependents = new Map<string, number>();
  for (const mod of scan.mods) {
    if (!active.has(mod.packageId)) continue;
    for (const dep of mod.dependencies) {
      const id = dep.packageId.toLowerCase();
      dependents.set(id, (dependents.get(id) ?? 0) + 1);
    }
  }

  return scan.mods.map((mod) => {
    const details = mod.steamId ? workshop?.items[mod.steamId] : undefined;
    return {
      mod,
      workshop: details,
      active: active.has(mod.packageId),
      dependents: dependents.get(mod.packageId) ?? 0,
      vramBytes: mod.textures?.estimatedVramBytes ?? 0,
      ageDays: details?.timeUpdated ? Math.round((now / 1000 - details.timeUpdated) / 86400) : undefined,
    };
  });
}

export function sortLibrary(rows: LibraryRow[], sort: LibrarySort): LibraryRow[] {
  const copy = [...rows];
  switch (sort) {
    case "subscribers":
      return copy.sort((a, b) => (b.workshop?.subscriptions ?? -1) - (a.workshop?.subscriptions ?? -1));
    case "updated":
      // Longest since an update first: that is the end of the list worth looking at.
      return copy.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
    case "vram":
      return copy.sort((a, b) => b.vramBytes - a.vramBytes);
    case "dependents":
      return copy.sort((a, b) => b.dependents - a.dependents);
    case "size":
      return copy.sort((a, b) => b.mod.sizeBytes - a.mod.sizeBytes);
    default:
      return copy.sort((a, b) => {
        const ai = a.mod.loadIndex;
        const bi = b.mod.loadIndex;
        if (ai !== null && bi !== null) return ai - bi;
        if (ai !== null) return -1;
        if (bi !== null) return 1;
        return a.mod.name.localeCompare(b.mod.name);
      });
  }
}

/**
 * Mods that cost a lot and hold nothing else up.
 *
 * Deliberately conservative: nothing may depend on it, it must be carrying real texture
 * weight, and it must not be a framework or official content. This is a shortlist to
 * look at, never a recommendation to remove, because "nobody depends on it" and "you do
 * not want it" are different statements and only one of them is measurable.
 */
export function cleanupCandidates(rows: LibraryRow[], minVramBytes = 200 * 1024 ** 2): LibraryRow[] {
  return rows
    .filter(
      (row) =>
        row.active && row.mod.source !== "official" && row.dependents === 0 && row.vramBytes >= minVramBytes,
    )
    .sort((a, b) => b.vramBytes - a.vramBytes);
}

export function workshopUrl(steamId: string): string {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${steamId}`;
}

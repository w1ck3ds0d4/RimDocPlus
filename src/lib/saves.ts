import type { ModEntry, ScanResult } from "./types";

export interface SaveMeta {
  path: string;
  name: string;
  savedAt?: string;
  gameVersion: string;
  /** packageIds in the order the save recorded them, lowercased. */
  modIds: string[];
  /** Display names as they were then, so a mod since uninstalled can still be named. */
  modNames: string[];
}

export interface SaveModChange {
  packageId: string;
  /** The save's own name for it, which may be the only record left. */
  name: string;
  /** Whether the mod is on disk now, whatever the load order says. */
  installed: boolean;
}

export interface SaveComparison {
  save: SaveMeta;
  /** In the save, absent from the load order. These are what breaks a load. */
  missing: SaveModChange[];
  /** In the load order, absent from the save. Usually harmless. */
  added: SaveModChange[];
  /** Present in both, but not in the same relative order. */
  reordered: number;
  /** The save was written by a different build of the game. */
  gameVersionChanged: boolean;
}

/**
 * What has changed between a save and the load order as it stands.
 *
 * A save records the mods it was made with, and loading it against a different list is a
 * distinct kind of breakage from anything the Doctor sees on disk: nothing is wrong with the
 * install, it simply is not the install this colony was built on.
 *
 * Missing mods are the ones that matter. Their content is still referenced throughout the
 * save, so RimWorld drops whatever it cannot resolve, which is how a colony loads with its
 * buildings gone. Added mods are usually harmless, and are reported quietly for completeness.
 */
export function compareSave(save: SaveMeta, scan: ScanResult, activeOrder: string[]): SaveComparison {
  const installed = new Set(scan.mods.map((m) => m.packageId));
  const active = new Set(activeOrder);
  const saved = new Set(save.modIds);
  const nameFor = new Map(save.modIds.map((id, i) => [id, save.modNames[i] ?? id]));

  const missing = save.modIds
    .filter((id) => !active.has(id))
    .map((id) => ({
      packageId: id,
      name: nameFor.get(id) ?? id,
      installed: installed.has(id),
    }));

  const added = activeOrder
    .filter((id) => !saved.has(id))
    .map((id) => ({
      packageId: id,
      name: displayName(id, scan.mods),
      installed: true,
    }));

  return {
    save,
    missing,
    added,
    reordered: countReordered(save.modIds, activeOrder),
    gameVersionChanged: normaliseVersion(save.gameVersion) !== normaliseVersion(scan.gameVersion),
  };
}

/**
 * How many shared mods sit in a different relative order.
 *
 * Only mods present in both are compared, since a mod missing from one side has no position
 * in it to differ from. Order matters far less than presence, so this is a number rather
 * than a list: it is worth knowing, not worth acting on by itself.
 */
function countReordered(savedIds: string[], activeOrder: string[]): number {
  const active = new Set(activeOrder);
  const savedShared = savedIds.filter((id) => active.has(id));
  const saved = new Set(savedIds);
  const activeShared = activeOrder.filter((id) => saved.has(id));
  return savedShared.filter((id, i) => activeShared[i] !== id).length;
}

/** RimWorld writes a build number that changes on every patch; the cycle is what matters. */
function normaliseVersion(version: string): string {
  return /^(\d+\.\d+)/.exec(version)?.[1] ?? version;
}

function displayName(packageId: string, mods: ModEntry[]): string {
  return mods.find((m) => m.packageId === packageId)?.name ?? packageId;
}

/**
 * Whether a comparison is worth putting in front of anyone.
 *
 * Added mods and reordering alone are not: adding a mod to an existing colony is ordinary,
 * and RimWorld sorts the order itself at load. Only a mod the save expects and the list does
 * not is a reason to say something before the colony is opened.
 */
export function isRisky(comparison: SaveComparison): boolean {
  return comparison.missing.length > 0;
}

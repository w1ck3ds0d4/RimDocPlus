import type { ModEntry, ScanResult } from "./types";
import { BOOTSTRAP_PACKAGE_IDS, OFFICIAL_PACKAGE_IDS } from "./analysis/about.ts";

/**
 * A saved mod list. This is the unit a player runs the game with: a named set of
 * package ids in load order, pinned to a game cycle.
 *
 * A profile records ids only, never mod files. Pinning exact mod versions arrives with
 * the vault, which is what makes a profile reproducible rather than merely repeatable.
 */
export interface Profile {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  gameCycle: string;
  activeOrder: string[];
  note?: string;
  /**
   * A restore point. Locked packs cannot be edited, renamed or deleted, so there is
   * always one record of what the install looked like before RimDoc+ touched anything.
   */
  locked?: boolean;
}

export interface ProfileDiff {
  added: string[];
  removed: string[];
  reordered: boolean;
}

const STORAGE_KEY = "rimdoc.profiles.v1";

export function newProfileId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * What to call the pack seeded from the install as found.
 *
 * Official content is not a mod, so a load order carrying only Ludeon entries is vanilla
 * however many DLCs are in it. An enabled id with no folder counts as modded: a vanilla
 * install has nothing to be missing.
 */
export function setupName(scan: ScanResult): string {
  const bySource = new Map(scan.mods.map((m) => [m.packageId, m.source]));
  const modded = scan.activeOrder.some((id) => (bySource.get(id) ?? "unknown") !== "official");
  return modded ? "Modded Game Setup" : "Vanilla Game Setup";
}

/** Snapshot whatever the game is currently set to run. */
export function profileFromScan(scan: ScanResult, name: string): Profile {
  const now = new Date().toISOString();
  return {
    id: newProfileId(),
    name,
    createdAt: now,
    updatedAt: now,
    gameCycle: scan.gameCycle,
    activeOrder: [...scan.activeOrder],
  };
}

export function duplicateProfile(profile: Profile, name: string): Profile {
  const now = new Date().toISOString();
  // A copy of a restore point is a working pack, not another restore point.
  return { ...profile, id: newProfileId(), name, createdAt: now, updatedAt: now, locked: false };
}

function touch(profile: Profile, activeOrder: string[]): Profile {
  if (profile.locked) return profile;
  return { ...profile, activeOrder, updatedAt: new Date().toISOString() };
}

/**
 * Turn a mod on or off.
 *
 * Enabling inserts at a defensible position rather than appending, so a freshly enabled
 * framework does not land behind the mods that depend on it and immediately trip the
 * load-order rules.
 */
export function toggleMod(profile: Profile, packageId: string, mods: ModEntry[]): Profile {
  if (profile.activeOrder.includes(packageId)) {
    return touch(
      profile,
      profile.activeOrder.filter((id) => id !== packageId),
    );
  }
  const next = [...profile.activeOrder];
  next.splice(insertionIndex(packageId, next, mods), 0, packageId);
  return touch(profile, next);
}

export function setEnabled(
  profile: Profile,
  packageIds: string[],
  enabled: boolean,
  mods: ModEntry[],
): Profile {
  return packageIds.reduce(
    (acc, id) => (acc.activeOrder.includes(id) === enabled ? acc : toggleMod(acc, id, mods)),
    profile,
  );
}

/** Move one mod up or down the load order by `delta` positions. */
export function moveMod(profile: Profile, packageId: string, delta: number): Profile {
  if (profile.locked) return profile;
  const from = profile.activeOrder.indexOf(packageId);
  if (from === -1) return profile;
  const to = Math.max(0, Math.min(profile.activeOrder.length - 1, from + delta));
  if (to === from) return profile;
  const next = [...profile.activeOrder];
  next.splice(to, 0, ...next.splice(from, 1));
  return touch(profile, next);
}

/** Where a newly enabled mod should go: after everything it declares it loads after. */
function insertionIndex(packageId: string, order: string[], mods: ModEntry[]): number {
  const byId = new Map(mods.map((m) => [m.packageId, m]));
  const mod = byId.get(packageId);
  if (!mod) return order.length;

  const rank = tierOf(packageId);
  // Bootstrap and official content belong in their own band at the top, ahead of the
  // first entry from a lower band.
  if (rank < 2) {
    const firstLower = order.findIndex((id) => tierOf(id) > rank);
    return firstLower === -1 ? order.length : firstLower;
  }

  let index = 0;
  for (const dependency of [...mod.loadAfter, ...mod.dependencies.map((d) => d.packageId.toLowerCase())]) {
    const at = order.indexOf(dependency);
    if (at >= index) index = at + 1;
  }
  // Never land after something that declared it must come later.
  for (const successor of mod.loadBefore) {
    const at = order.indexOf(successor);
    if (at !== -1 && at < index) index = at;
  }
  return Math.min(index === 0 ? order.length : index, order.length);
}

/** 0 = bootstrap, 1 = Ludeon content, 2 = everything else. */
function tierOf(packageId: string): number {
  if (BOOTSTRAP_PACKAGE_IDS.includes(packageId)) return 0;
  if (OFFICIAL_PACKAGE_IDS.includes(packageId)) return 1;
  return 2;
}

/** Position within a tier, so Core precedes its expansions and Prepatcher precedes Harmony. */
function tierRank(packageId: string): number {
  const bootstrap = BOOTSTRAP_PACKAGE_IDS.indexOf(packageId);
  if (bootstrap !== -1) return bootstrap;
  const official = OFFICIAL_PACKAGE_IDS.indexOf(packageId);
  return official === -1 ? 0 : official;
}

/**
 * Stable topological sort of the active list.
 *
 * Bootstrappers first, then Ludeon content in canonical order, then everything else
 * ordered by the loadAfter and loadBefore constraints the mods declare. Ties keep their
 * current position, so sorting a mostly-correct list barely moves anything and the diff
 * stays reviewable. A constraint cycle cannot be satisfied, so those mods are emitted in
 * their existing order instead of being dropped.
 */
export function sortLoadOrder(activeOrder: string[], mods: ModEntry[]): string[] {
  const byId = new Map(mods.map((m) => [m.packageId, m]));
  const active = new Set(activeOrder);
  const originalIndex = new Map(activeOrder.map((id, i) => [id, i]));

  const successors = new Map<string, Set<string>>(activeOrder.map((id) => [id, new Set<string>()]));
  const indegree = new Map<string, number>(activeOrder.map((id) => [id, 0]));

  const edge = (from: string, to: string) => {
    if (from === to || !active.has(from) || !active.has(to)) return;
    if (successors.get(from)!.has(to)) return;
    successors.get(from)!.add(to);
    indegree.set(to, indegree.get(to)! + 1);
  };

  for (const id of activeOrder) {
    const mod = byId.get(id);
    if (!mod) continue;
    for (const other of mod.loadAfter) edge(other, id);
    for (const other of mod.dependencies.map((d) => d.packageId.toLowerCase())) edge(other, id);
    for (const other of mod.loadBefore) edge(id, other);
  }

  // Band constraints are expressed as edges too, so one sort satisfies both the tier
  // layout and the declared dependencies.
  for (const id of activeOrder) {
    for (const other of activeOrder) {
      if (tierOf(id) < tierOf(other)) edge(id, other);
      else if (tierOf(id) === tierOf(other) && tierOf(id) < 2 && tierRank(id) < tierRank(other))
        edge(id, other);
    }
  }

  const ready = activeOrder.filter((id) => indegree.get(id) === 0);
  const sorted: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => originalIndex.get(a)! - originalIndex.get(b)!);
    const id = ready.shift()!;
    sorted.push(id);
    for (const next of successors.get(id)!) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }

  if (sorted.length < activeOrder.length) {
    const emitted = new Set(sorted);
    sorted.push(...activeOrder.filter((id) => !emitted.has(id)));
  }
  return sorted;
}

export function diffProfiles(from: string[], to: string[]): ProfileDiff {
  const before = new Set(from);
  const after = new Set(to);
  const added = to.filter((id) => !before.has(id));
  const removed = from.filter((id) => !after.has(id));
  const survivors = (list: string[]) => list.filter((id) => before.has(id) && after.has(id));
  return {
    added,
    removed,
    reordered: survivors(from).join("|") !== survivors(to).join("|"),
  };
}

/** Render a profile as the ModsConfig.xml RimWorld reads on launch. */
export function toModsConfigXml(activeOrder: string[], gameVersion: string): string {
  const items = activeOrder.map((id) => `    <li>${id}</li>`).join("\n");
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<ModsConfigData>",
    `  <version>${gameVersion}</version>`,
    "  <activeMods>",
    items,
    "  </activeMods>",
    "</ModsConfigData>",
    "",
  ].join("\n");
}

/* Storage ------------------------------------------------------------------ */

/**
 * Browser storage for the preview. The desktop build persists profiles to the app data
 * directory instead; this keeps the editor usable before the Tauri shell exists.
 */
export function loadProfiles(): Profile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Profile[]) : [];
  } catch {
    return [];
  }
}

export function saveProfiles(profiles: Profile[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  } catch {
    // Private windows and blocked site data both throw here. Losing persistence is
    // survivable; losing the editor is not.
  }
}

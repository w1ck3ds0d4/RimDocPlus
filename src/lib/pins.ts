import type { ModEntry } from "./types";
import type { Modpack } from "./modpacks";

export type PinState = "matched" | "drifted" | "missing" | "unpinned";

export interface PinCheck {
  packageId: string;
  name: string;
  state: PinState;
  /** The build the modpack was pinned to. */
  pinned?: string;
  /** The build on disk now. */
  current?: string;
}

export interface PinReport {
  checks: PinCheck[];
  pinned: number;
  drifted: number;
  missing: number;
}

/**
 * How the install compares to what a modpack was pinned to.
 *
 * Drift is the interesting state: the mod is still there and still enabled, but it is not
 * the build this setup was known to work with. That is invisible otherwise, because nothing
 * about a load order changes when Steam replaces a mod underneath it.
 *
 * Hashes are supplied rather than computed here, so this stays pure and the walk over a
 * gigabyte of mod folders happens once, where it can report progress.
 */
export function checkPins(modpack: Modpack, mods: ModEntry[], current: Record<string, string>): PinReport {
  const pins = modpack.pins ?? {};
  const byId = new Map(mods.map((m) => [m.packageId, m]));

  const checks: PinCheck[] = modpack.activeOrder.map((id) => {
    const name = byId.get(id)?.name ?? id;
    const pinned = pins[id];
    const now = current[id];

    if (!pinned) return { packageId: id, name, state: "unpinned", current: now };
    if (!byId.has(id)) return { packageId: id, name, state: "missing", pinned };
    // No hash for an installed mod means it was not measured this pass, which is not the
    // same as having drifted and must not be reported as though it were.
    if (!now) return { packageId: id, name, state: "unpinned", pinned };
    return { packageId: id, name, state: now === pinned ? "matched" : "drifted", pinned, current: now };
  });

  return {
    checks,
    pinned: checks.filter((c) => c.state !== "unpinned").length,
    drifted: checks.filter((c) => c.state === "drifted").length,
    missing: checks.filter((c) => c.state === "missing").length,
  };
}

/** Pin a modpack to exactly what is installed now. */
export function pinTo(modpack: Modpack, current: Record<string, string>): Modpack {
  const pins: Record<string, string> = {};
  for (const id of modpack.activeOrder) {
    if (current[id]) pins[id] = current[id];
  }
  return { ...modpack, pins, updatedAt: new Date().toISOString() };
}

export function clearPins(modpack: Modpack): Modpack {
  const { pins: _dropped, ...rest } = modpack;
  return { ...rest, updatedAt: new Date().toISOString() };
}

import type { ScanResult } from "./types";

export interface ModChange {
  packageId: string;
  name: string;
  /** Folder mtime at the time of the scan that noticed the change. */
  updatedAt?: string;
}

export interface InstallDiff {
  /** The scan this diff describes, so a reload shows the same answer. */
  scannedAt: string;
  added: ModChange[];
  removed: ModChange[];
  updated: ModChange[];
  /** True for the very first scan, where there is nothing to compare against. */
  baseline: boolean;
  /** When the compared-against scan was taken. */
  since?: string;
}

interface Snapshot {
  scannedAt: string;
  mods: Record<string, { name: string; updatedAt?: string }>;
}

const SNAPSHOT = "rimdoc.snapshot.v1";
const DIFF = "rimdoc.installdiff.v1";

/**
 * What changed in the mod list since the previous scan.
 *
 * This answers "the game worked yesterday, what moved", which is usually the fastest route
 * to a cause when a stable list suddenly breaks. Steam updates Workshop mods without asking,
 * so the change that broke a save is frequently one the player never made.
 *
 * The result is stored against the scan that produced it rather than recomputed, because
 * the comparison is destructive: once the snapshot advances, the previous state is gone and
 * reopening the app would otherwise report no changes at all.
 */
export function installDiff(scan: ScanResult): InstallDiff {
  const stored = read<InstallDiff>(DIFF);
  if (stored && stored.scannedAt === scan.scannedAt) return stored;

  const previous = read<Snapshot>(SNAPSHOT);
  const diff = compare(previous, scan);

  write(DIFF, diff);
  write(SNAPSHOT, snapshotOf(scan));
  return diff;
}

/** The comparison itself, kept free of storage so it can be tested directly. */
export function compare(previous: Snapshot | null, scan: ScanResult): InstallDiff {
  const now = snapshotOf(scan);
  if (!previous) {
    return { scannedAt: scan.scannedAt, added: [], removed: [], updated: [], baseline: true };
  }

  const added: ModChange[] = [];
  const updated: ModChange[] = [];
  for (const [id, mod] of Object.entries(now.mods)) {
    const before = previous.mods[id];
    if (!before) {
      added.push({ packageId: id, name: mod.name, updatedAt: mod.updatedAt });
    } else if (mod.updatedAt && before.updatedAt && mod.updatedAt !== before.updatedAt) {
      updated.push({ packageId: id, name: mod.name, updatedAt: mod.updatedAt });
    }
  }

  const removed = Object.entries(previous.mods)
    .filter(([id]) => !now.mods[id])
    .map(([id, mod]) => ({ packageId: id, name: mod.name, updatedAt: mod.updatedAt }));

  return {
    scannedAt: scan.scannedAt,
    added,
    removed,
    updated,
    baseline: false,
    since: previous.scannedAt,
  };
}

function snapshotOf(scan: ScanResult): Snapshot {
  const mods: Snapshot["mods"] = {};
  for (const mod of scan.mods) mods[mod.packageId] = { name: mod.name, updatedAt: mod.updatedAt };
  return { scannedAt: scan.scannedAt, mods };
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* the diff is a convenience; losing it must not break the scan */
  }
}

import type { ModEntry, ScanResult } from "./types";
import { BOOTSTRAP_PACKAGE_IDS, OFFICIAL_PACKAGE_IDS } from "./analysis/about";
import { sortLoadOrder } from "./modpacks";

export type Verdict = "still-there" | "gone";

export interface BisectTrial {
  step: number;
  /** How many suspects were enabled for this trial. */
  tested: number;
  verdict: Verdict;
}

export interface BisectSession {
  startedAt: string;
  /** The load order the search began from, restored when it ends however it ends. */
  original: string[];
  /**
   * Never disabled: official content and the bootstrap layer.
   *
   * Removing Core is not a test, it is a different game, and disabling Harmony breaks every
   * mod that patches through it, which would make each trial fail for a reason that has
   * nothing to do with what is being looked for.
   */
  pinned: string[];
  /** Still possibly responsible. */
  suspects: string[];
  /** Enabled for the trial now in front of the player. */
  testing: string[];
  step: number;
  trials: BisectTrial[];
}

const KEY = "rimdoc.bisect.v1";

/** Mods that stay enabled whatever the search does. */
function pinnedOf(order: string[]): string[] {
  const always = new Set([...OFFICIAL_PACKAGE_IDS, ...BOOTSTRAP_PACKAGE_IDS]);
  return order.filter((id) => always.has(id));
}

/**
 * Begin a search over the mods that could be responsible.
 *
 * Half the suspects are enabled for the first trial. Which half is arbitrary, so the list's
 * own order is used, which at least keeps each trial close to a load order the player has
 * actually run.
 */
export function startBisect(order: string[]): BisectSession {
  const pinned = pinnedOf(order);
  const pinnedSet = new Set(pinned);
  const suspects = order.filter((id) => !pinnedSet.has(id));
  return {
    startedAt: new Date().toISOString(),
    original: [...order],
    pinned,
    suspects,
    testing: firstHalf(suspects),
    step: 1,
    trials: [],
  };
}

function firstHalf(ids: string[]): string[] {
  return ids.slice(0, Math.ceil(ids.length / 2));
}

/**
 * Narrow the search by what the trial showed.
 *
 * The fault being present means it lives among the mods that were enabled, so those become
 * the new suspects. Absent means it lives among the ones that were not. Either way the
 * search halves, so a 224-mod list is settled in about eight launches.
 */
export function applyVerdict(session: BisectSession, verdict: Verdict): BisectSession {
  const tested = new Set(session.testing);
  const suspects =
    verdict === "still-there" ? session.testing : session.suspects.filter((id) => !tested.has(id));

  const trials = [...session.trials, { step: session.step, tested: session.testing.length, verdict }];

  return {
    ...session,
    suspects,
    testing: suspects.length > 1 ? firstHalf(suspects) : suspects,
    step: session.step + 1,
    trials,
  };
}

/** Settled once a single suspect is left, or none survived. */
export function isSettled(session: BisectSession): boolean {
  return session.suspects.length <= 1;
}

/**
 * The load order to run for the current trial.
 *
 * Every dependency of a kept mod is pulled back in, whether or not the split happened to
 * include it. Without that, half the trials fail because something is missing rather than
 * because the fault is present, and the search follows the wrong half from there.
 *
 * A dependency that is itself a suspect stays a suspect: being required by something does
 * not clear it. It is simply present for this trial so the trial means something.
 */
export function trialOrder(session: BisectSession, mods: ModEntry[]): string[] {
  const byId = new Map(mods.map((m) => [m.packageId, m]));
  const wanted = new Set([...session.pinned, ...session.testing]);

  // Dependencies pull in their own dependencies, so this runs to a fixed point rather than
  // one level deep.
  for (let added = true; added;) {
    added = false;
    for (const id of [...wanted]) {
      for (const dep of byId.get(id)?.dependencies ?? []) {
        const needed = dep.packageId.toLowerCase();
        // Only what is actually installed. A dependency that is merely declared and absent
        // is the missing-dependency rule's business, not something to conjure in here.
        if (byId.has(needed) && !wanted.has(needed)) {
          wanted.add(needed);
          added = true;
        }
      }
    }
  }

  return sortLoadOrder(
    session.original.filter((id) => wanted.has(id)),
    mods,
  );
}

/** Mods enabled for this trial only because something else needed them. */
export function pulledIn(session: BisectSession, mods: ModEntry[]): string[] {
  const chosen = new Set([...session.pinned, ...session.testing]);
  return trialOrder(session, mods).filter((id) => !chosen.has(id));
}

/** How many trials remain at most, which is what makes the search feel finite. */
export function trialsLeft(session: BisectSession): number {
  return session.suspects.length <= 1 ? 0 : Math.ceil(Math.log2(session.suspects.length));
}

export function loadBisect(): BisectSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as BisectSession) : null;
  } catch {
    return null;
  }
}

/**
 * Persisted on every step.
 *
 * A trial means closing the app, launching the game and coming back, so a search held only
 * in memory would be lost exactly when it is being used.
 */
export function saveBisect(session: BisectSession | null): void {
  try {
    if (session) localStorage.setItem(KEY, JSON.stringify(session));
    else localStorage.removeItem(KEY);
  } catch {
    /* private window; the search still works for as long as the app stays open */
  }
}

/** Named for a report, since a package id is not what the player is looking at. */
export function nameOf(packageId: string, scan: ScanResult): string {
  return scan.mods.find((m) => m.packageId === packageId)?.name ?? packageId;
}

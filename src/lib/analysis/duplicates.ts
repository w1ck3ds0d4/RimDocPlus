import type { ModEntry, WorkshopCache, WorkshopDetails } from "../types";

export interface DuplicateRanking {
  recommended: ModEntry;
  /** Why this copy, strongest first. */
  reasons: string[];
  /** What argues for the other copy. Non-empty means the evidence disagrees with itself. */
  caveats: string[];
  /** True when no signal separated them at all. */
  arbitrary: boolean;
}

interface Candidate {
  mod: ModEntry;
  workshop?: WorkshopDetails;
}

/**
 * Pick which of several copies of one mod to keep.
 *
 * The signals genuinely conflict in the field. An original with 788k subscribers and a
 * continuation with 195k that was updated thirteen months more recently is a real case,
 * and neither answer is wrong: the original may still work, the continuation may carry
 * fixes it lacks. So this ranks, states its reasoning, and says plainly when the evidence
 * points both ways. It never picks silently, because the choice is a judgement about what
 * the player wants and only the inputs to it are measurable.
 */
export function rankDuplicates(
  mods: ModEntry[],
  gameCycle: string,
  workshop: WorkshopCache | null,
): DuplicateRanking | null {
  if (mods.length < 2) return null;

  const candidates: Candidate[] = mods.map((mod) => ({
    mod,
    workshop: mod.steamId ? workshop?.items[mod.steamId] : undefined,
  }));

  // A copy that does not claim the running cycle loses outright, whatever else it has.
  const supports = candidates.filter((c) => c.mod.supportedVersions.includes(gameCycle));
  const pool = supports.length > 0 && supports.length < candidates.length ? supports : candidates;
  const excluded = candidates.filter((c) => !pool.includes(c));

  const newest = best(pool, (c) => c.workshop?.timeUpdated ?? 0);
  const popular = best(pool, (c) => c.workshop?.subscriptions ?? 0);
  const local = pool.find((c) => c.mod.source === "local");

  // A local copy is a deliberate pin: someone put it there on purpose to stop Steam
  // replacing it, and overriding that intent is not the tool's call.
  const winner = local ?? newest ?? pool[0];
  const reasons: string[] = [];
  const caveats: string[] = [];

  if (local) {
    reasons.push("It is a local copy, which is usually a deliberate pin against Steam updates");
  }

  if (excluded.length) {
    reasons.push(
      `The other ${excluded.length === 1 ? "copy does" : "copies do"} not declare ${gameCycle} support`,
    );
  }

  const winnerUpdated = winner.workshop?.timeUpdated;
  if (!local && newest === winner && winnerUpdated) {
    const rival = pool.find((c) => c !== winner && c.workshop?.timeUpdated);
    if (rival?.workshop) {
      const days = Math.round((winnerUpdated - rival.workshop.timeUpdated) / 86400);
      if (days > 0) reasons.push(`Updated ${days} days more recently than the other copy`);
    }
  }

  if (winner.workshop && popular === winner) {
    reasons.push(`More subscribed: ${winner.workshop.subscriptions.toLocaleString()}`);
  } else if (popular?.workshop && popular !== winner) {
    // The headline disagreement: say it rather than burying it under the recommendation.
    caveats.push(
      `${popular.mod.name} has more subscribers (${popular.workshop.subscriptions.toLocaleString()} vs ` +
        `${winner.workshop?.subscriptions.toLocaleString() ?? "unknown"}), which usually means it is the ` +
        "better-known copy",
    );
  }

  const widest = best(pool, (c) => c.mod.supportedVersions.length);
  if (
    widest &&
    widest !== winner &&
    widest.mod.supportedVersions.length > winner.mod.supportedVersions.length
  ) {
    caveats.push(`${widest.mod.name} declares support for more game versions`);
  }

  if (!reasons.length) {
    reasons.push("Nothing measurable separates these copies");
  }

  return { recommended: winner.mod, reasons, caveats, arbitrary: !local && !newest?.workshop };
}

/** Highest scorer, or undefined when no candidate has a non-zero score. */
function best(candidates: Candidate[], score: (c: Candidate) => number): Candidate | undefined {
  let winner: Candidate | undefined;
  let top = 0;
  for (const candidate of candidates) {
    const value = score(candidate);
    if (value > top) {
      top = value;
      winner = candidate;
    }
  }
  return winner;
}

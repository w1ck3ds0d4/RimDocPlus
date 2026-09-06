import type { Finding, ModEntry, ScanResult } from "../types";

/**
 * Operations that overwrite or delete what is already there. Two mods adding to the same
 * node usually coexist; two mods replacing it do not, and the later one silently wins.
 */
const DESTRUCTIVE = /Replace|Remove|AttributeSet|AttributeRemove|Insert/i;

/** Xpaths broad enough that a collision on them says nothing useful. */
const TOO_BROAD = new Set(["/Defs", "/", "/Defs/*"]);

interface Collision {
  xpath: string;
  /** Load-order position and operation for each mod touching this path. */
  touches: { mod: ModEntry; op: string; file: string; destructive: boolean }[];
}

/**
 * XML patch analysis.
 *
 * RimWorld applies patches in load order and reports nothing when two of them fight: the
 * later operation just wins. That makes overwrite collisions invisible in the log and
 * effectively undebuggable from inside the game, which is exactly the class of problem
 * worth catching before launch.
 */
export function runPatchRules(scan: ScanResult): Finding[] {
  const active = scan.mods.filter((m) => m.active && m.patches?.length);
  if (active.length < 2) return [];

  const byXpath = new Map<string, Collision>();
  for (const mod of active) {
    // One mod patching its own target twice is its own business, not a conflict.
    const seenHere = new Set<string>();
    for (const patch of mod.patches ?? []) {
      if (TOO_BROAD.has(patch.xpath) || seenHere.has(patch.xpath)) continue;
      seenHere.add(patch.xpath);
      const entry = byXpath.get(patch.xpath) ?? { xpath: patch.xpath, touches: [] };
      entry.touches.push({
        mod,
        op: patch.op,
        file: patch.file,
        destructive: DESTRUCTIVE.test(patch.op),
      });
      byXpath.set(patch.xpath, entry);
    }
  }

  const conflicts = [...byXpath.values()]
    .filter((c) => c.touches.length > 1 && c.touches.some((t) => t.destructive))
    .sort((a, b) => b.touches.length - a.touches.length);

  if (!conflicts.length) return [];

  // One finding per pair of mods rather than per xpath: a framework and an add-on can
  // collide on eighty paths, and eighty identical rows say no more than one does.
  const byPair = new Map<string, { mods: [ModEntry, ModEntry]; paths: Collision[] }>();
  for (const conflict of conflicts) {
    const destructive = conflict.touches.filter((t) => t.destructive);
    for (const first of destructive) {
      for (const second of conflict.touches) {
        if (first.mod.packageId === second.mod.packageId) continue;
        const key = [first.mod.packageId, second.mod.packageId].sort().join("|");
        const existing = byPair.get(key);
        if (existing) {
          if (!existing.paths.includes(conflict)) existing.paths.push(conflict);
        } else {
          byPair.set(key, { mods: [first.mod, second.mod], paths: [conflict] });
        }
      }
    }
  }

  return [...byPair.values()]
    .sort((a, b) => b.paths.length - a.paths.length)
    .slice(0, 15)
    .map(({ mods, paths }) => {
      // Whichever loads later wins the overwrite, which is the part worth naming.
      const [earlier, later] =
        (mods[0].loadIndex ?? 0) <= (mods[1].loadIndex ?? 0) ? mods : [mods[1], mods[0]];

      return {
        id: `patch-collision:${earlier.packageId}|${later.packageId}`,
        rule: "patch-collision",
        severity: paths.length > 5 ? "warning" : ("info" as const),
        title: `${later.name} overwrites ${paths.length} patch target${
          paths.length === 1 ? "" : "s"
        } also patched by ${earlier.name}`,
        detail:
          `Both mods patch the same nodes and at least one overwrites rather than adds. ` +
          `${later.name} loads later, so its version wins and ${earlier.name}'s change to these ` +
          "paths is discarded without any log entry.\n\n" +
          paths
            .slice(0, 8)
            .map((p) => `  ${p.xpath}`)
            .join("\n") +
          (paths.length > 8 ? `\n  and ${paths.length - 8} more` : ""),
        packageIds: [later.packageId, earlier.packageId],
        count: paths.length,
      } satisfies Finding;
    });
}

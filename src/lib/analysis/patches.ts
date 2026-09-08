import type { Finding, ModEntry, ScanResult } from "../types";

/**
 * Operations that overwrite or delete what is already there. Two mods adding to the same
 * node usually coexist; two mods replacing it do not, and the later one silently wins.
 *
 * Insert is not one of them, whatever this list used to say. PatchOperationInsert adds a
 * sibling beside the node it matched and leaves that node alone, so two mods inserting at
 * one anchor both apply. Calling that a collision told someone their earlier mod's change
 * was discarded, and offered to disable the later mod to get it back, when nothing had
 * been lost and disabling would only remove content.
 */
const DESTRUCTIVE = /Replace|Remove|AttributeSet|AttributeRemove/i;

/** Xpaths broad enough that a collision on them says nothing useful. */
const TOO_BROAD = new Set(["/Defs", "/", "/Defs/*"]);

export type OverrideIntent = "declared" | "documented" | "content" | "assumed";

/**
 * The author telling players where to load the mod, which is intent in plain words.
 *
 * Two shapes, because authors write both and the first version only caught one. "Load this
 * mod by the end of your mod list" leads with the verb; "MissileGirl should be the last mod
 * in your mod list" names the mod and never says load at all, which is how the one mod on
 * the reference install that most needs to be last went unnoticed.
 */
export const LOAD_INSTRUCTION =
  /\bload\s+(this\s+|the\s+|it\s+)?(mod\s+)?(by\s+the\s+end|at\s+the\s+end|last|after|below|later|towards?\s+the\s+(end|bottom))|\b(should\s+be|goes|belongs|put\s+(this|it))\s+(loaded\s+)?(the\s+)?(very\s+)?(last|at\s+the\s+(end|bottom)|near\s+the\s+(end|bottom))/i;

/** Language that marks a mod as content built on top of something else. */
const CONTENT_LANGUAGE =
  /\b(expanded|expansion|module\s+in|reimagining|overhaul|retexture|re-texture|replaces?|patch\s+(that|for)|add-?on|adds\s+(new|more))\b/i;

/**
 * Why one mod overwrites another's patches.
 *
 * Overwriting is how RimWorld content is layered: an expansion, a retexture or a patch
 * mod exists precisely to change what a earlier mod set, so an overwrite is the normal
 * case rather than a fault. The intent is graded by how directly it can be evidenced,
 * from a declared load order down to assuming it, and the evidence is quoted so the
 * reader can disagree with the reasoning rather than just the conclusion.
 */
export function overrideIntent(
  later: ModEntry,
  earlier: ModEntry,
): { kind: OverrideIntent; evidence?: string } {
  if (
    later.loadAfter.includes(earlier.packageId) ||
    earlier.loadBefore.includes(later.packageId) ||
    later.dependencies.some((d) => d.packageId.toLowerCase() === earlier.packageId)
  ) {
    return { kind: "declared" };
  }

  const documented = later.description && LOAD_INSTRUCTION.exec(later.description);
  if (documented)
    return { kind: "documented", evidence: sentenceAround(later.description!, documented.index) };

  const content = later.description && CONTENT_LANGUAGE.exec(later.description);
  if (content) return { kind: "content", evidence: sentenceAround(later.description!, content.index) };
  if (CONTENT_LANGUAGE.test(later.name)) return { kind: "content", evidence: later.name };

  return { kind: "assumed" };
}

/** The sentence a match sits in, so the quoted evidence reads as something an author wrote. */
function sentenceAround(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf(".", index) + 1);
  const end = text.indexOf(".", index);
  const sentence = text.slice(start, end === -1 ? text.length : end + 1).trim();
  return sentence.length > 180 ? `${sentence.slice(0, 180).trimEnd()}...` : sentence;
}

/** How the finding explains itself, by how directly the intent could be evidenced. */
const INTENT_NOTE: Record<OverrideIntent, (later: ModEntry, earlier: ModEntry) => string> = {
  declared: (later, earlier) =>
    `${later.name} declares that it loads after ${earlier.name}, so this is what its author asked for.`,
  documented: (later) => `${later.name} documents where it expects to sit in the load order.`,
  content: (later) =>
    `${later.name} reads as content layered on top of other mods, which is exactly what overriding is for.`,
  assumed: (later, earlier) =>
    `Neither mod says anything about the other, so this was not deliberately arranged. It is still ` +
    `most likely fine: ${later.name} is the later mod and overriding is how content stacks. Worth a ` +
    `glance only if ${earlier.name}'s version of these is what you actually wanted.`,
};

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
export function runPatchRulesWithIntents(scan: ScanResult): {
  findings: Finding[];
  intents: Record<OverrideIntent, number>;
} {
  const intents: Record<OverrideIntent, number> = { declared: 0, documented: 0, content: 0, assumed: 0 };
  const active = scan.mods.filter((m) => m.active && m.patches?.length);
  if (active.length < 2) return { findings: [], intents };

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

  if (!conflicts.length) return { findings: [], intents };

  // One finding per pair of mods rather than per xpath: a framework and an add-on can
  // collide on eighty paths, and eighty identical rows say no more than one does.
  const byPair = new Map<string, { mods: [ModEntry, ModEntry]; paths: Collision[] }>();
  for (const conflict of conflicts) {
    const destructive = conflict.touches.filter((t) => t.destructive);
    for (const first of destructive) {
      for (const second of conflict.touches) {
        if (first.mod.packageId === second.mod.packageId) continue;
        // The mod that loads later is the one the finding names as overriding, so it has to
        // be the one that overwrote. Requiring only `first` to be destructive meant a later
        // mod that merely adds to a node was accused of discarding an earlier mod's
        // replacement, with a repair offering to disable it: disabling it would have
        // removed content and restored nothing. This is the false collision the DESTRUCTIVE
        // list exists to prevent, arriving from the other direction.
        const later = (first.mod.loadIndex ?? 0) > (second.mod.loadIndex ?? 0) ? first : second;
        if (!later.destructive) continue;
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

  const findings = [...byPair.values()]
    .sort((a, b) => b.paths.length - a.paths.length)
    .slice(0, 15)
    .map(({ mods, paths }) => {
      // Whichever loads later wins the overwrite, which is the part worth naming.
      const [earlier, later] =
        (mods[0].loadIndex ?? 0) <= (mods[1].loadIndex ?? 0) ? mods : [mods[1], mods[0]];

      const intent = overrideIntent(later, earlier);
      intents[intent.kind]++;

      return {
        id: `patch-override:${earlier.packageId}|${later.packageId}`,
        rule: "patch-override",
        // Overwriting is how content layers in RimWorld, so this is always a note. An
        // expansion changing what the mod it expands set is the system working.
        severity: "info" as const,
        title: `${later.name} overrides ${paths.length} patch target${
          paths.length === 1 ? "" : "s"
        } from ${earlier.name}`,
        detail:
          `${later.name} loads later, so where both patch the same node its version is the one that ` +
          `takes effect. ${INTENT_NOTE[intent.kind](later, earlier)}` +
          (intent.evidence ? `\n\nFrom its own description: "${intent.evidence}"` : "") +
          "\n\n" +
          paths
            .slice(0, 8)
            .map((p) => `  ${p.xpath}`)
            .join("\n") +
          (paths.length > 8 ? `\n  and ${paths.length - 8} more` : ""),
        packageIds: [later.packageId, earlier.packageId],
        observation: true as const,
        count: paths.length,
        // Still info, and still usually deliberate. The repair is offered because the one
        // thing a reader cannot do from a note is act on it, not because the app thinks
        // the override is wrong. It needs a decision, so it is never automatic.
        fix: {
          kind: "disable-overriding-mod",
          label: `Disable ${later.name}`,
          tier: 2 as const,
          auto: false,
          params: { overriding: later.packageId, overridden: earlier.packageId },
        },
      } satisfies Finding;
    });

  return { findings, intents };
}

export function runPatchRules(scan: ScanResult): Finding[] {
  return runPatchRulesWithIntents(scan).findings;
}

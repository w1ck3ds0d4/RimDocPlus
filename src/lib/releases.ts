/** One group of changes, so a release reads as parts of an app rather than a list. */
export interface ReleaseSection {
  /** What this group is about, as a verb the reader recognises. */
  title: string;
  items: string[];
}

export interface Release {
  version: string;
  /** ISO date. */
  date: string;
  /** What this build is, grouped by the part of the app it belongs to. */
  sections: ReleaseSection[];
  /** Anything that is still not true, so the notes cannot oversell the build. */
  known?: string[];
}

/**
 * RimDoc+'s own version history.
 *
 * Held here rather than parsed from git so the notes say what changed for the player, which
 * is rarely what the commits say. Newest first.
 *
 * Grouped, and shorter than the work behind it. A first release is not a list of every
 * change made on the way to it: thirty-three flat bullets in one column, some of them about
 * eleven diagnostic rules and some about tab icons, is a changelog nobody finishes. What
 * belongs here is what the build does, in the shape someone would go looking for it.
 */
export const RELEASES: Release[] = [
  {
    version: "0.1.0",
    date: "2026-09-08",
    sections: [
      {
        title: "Diagnose",
        items: [
          "Reads your install directly: every mod's metadata, assemblies, textures and place in the load order",
          "Eleven rules over that load order, from orphaned entries and missing dependencies to bootstrap position, duplicate libraries and patch overrides",
          "Reads the last run's Player.log, groups faults by RimWorld's own reference id, and names the mods whose Harmony patches were on the way to each one",
          "Also reads the previous run's log, one pasted out of the game, or one shared as a gist",
          "Checks every mod's assemblies for Harmony patches aiming at methods the game no longer has, without launching anything",
          "Separates what it can repair from what it only observed, so a finished triage does not read as work waiting",
        ],
      },
      {
        title: "Repair",
        items: [
          "Triage applies every repair it can defend, then re-runs the rules to count what actually resolved",
          "Every repair is a plan you read before it runs, graded by how much can go wrong, and nothing above the safest tier is silent",
          "Every change is backed up first, and anything that touched disk can be rolled back in one click",
          "Writes the load order into ModsConfig.xml and starts the game, or closes Steam, applies and starts it again",
          "Subscribes to a mod you are missing, and re-fetches one Steam recorded but never downloaded",
          "Find the culprit halves the mod list, runs the game and halves again, judging its own trials where the fault stops the list loading",
        ],
      },
      {
        title: "Compare",
        items: [
          "Modpacks: build, rename, compare and switch between load orders, with your original setup kept as a baseline",
          "A modpack can be pinned to exact mod builds, and the vault keeps a copy of each so a pin still refers to something",
          "Saves: what each colony was made with, against what would load today",
          "Library: what each mod costs you and what breaks without it, beside Steam's public Workshop signals",
        ],
      },
      {
        title: "Measure",
        items: [
          "Play and watch: the log streams in live, and the run reports how it ended",
          "Every watched run is measured, so two modpacks can be compared on load time, memory and faults",
          "A small companion mod times the ticking from inside the game and reports what each mod costs per tick",
          "A session report you can copy or save: the environment, the faults and the mod list, without the raw log",
        ],
      },
    ],
    known: [
      "Harmony patches registered in code rather than declared with an attribute cannot be checked. The target is built while the game runs, so nothing outside it can say whether it still resolves",
      "Assembly-level repairs and stub defs for an absent dependency are specified and not implemented",
      "The search judges itself only for faults that stop the mod list loading. A crash an hour into a colony looks the same as a healthy boot from out here",
    ],
  },
];

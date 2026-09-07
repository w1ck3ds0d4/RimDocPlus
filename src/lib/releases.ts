export interface Release {
  version: string;
  /** ISO date. */
  date: string;
  /** What this build added, in the order it matters to someone using it. */
  changes: string[];
  /** Anything that is still not true, so the notes cannot oversell the build. */
  known?: string[];
}

/**
 * RimDoc+'s own version history.
 *
 * Held here rather than parsed from git so the notes say what changed for the player,
 * which is rarely what the commits say. Newest first.
 */
export const RELEASES: Release[] = [
  {
    version: "0.1.0",
    date: "2026-09-07",
    changes: [
      "Doctor: nine static rules over the load order, from orphaned entries and missing dependencies to bootstrap position and patch overrides",
      "Perform triage applies every repair it can defend, then re-runs the rules to count what actually resolved",
      "Desktop shell applies repairs directly, writes the load order into ModsConfig.xml and launches the game",
      "The desktop build scans your install itself, so the numbers are what is on disk rather than what was there when the app was built",
      "Applying a repair shows a live transcript, one line per file, and rescans when it finishes",
      "Modpacks: build, rename, compare and switch between load orders, with the original setup kept as a baseline",
      "Library: what each mod costs you and what breaks without it, beside Steam's public Workshop signals",
      "Session: reads the last Player.log, clusters faults by fingerprint and attributes them to a mod",
      "Mod details: click any mod for its banner, description, cost, relationships and findings",
      "The Doctor separates what it can repair from what it merely observed, so a finished triage does not look like it achieved nothing",
      "Triage covers the faults read out of your log too, which is where the most severe findings are",
      "A logged fault the scan can prove was fixed since is marked settled rather than offered a repair that would do nothing",
      "Findings are outlined in their severity, so a list can be read by shape before it is read as words",
      "Retry download on any Workshop mod: removes it and Steam's record of having downloaded it, keeping the subscription, so Steam fetches it again",
      "Warns when two mods ship the same library, which is how one gets silently bound to the other's build",
      "Reports mods the Workshop has updated more recently than the copy on disk",
      "Find the culprit: halves the mod list, runs the game, and halves again on your verdict until one mod is left",
      "Saves: compares the mod list each colony was made with against the one that would load today",
      "Harmony patches in a stack trace are named above it, with their kind and the mod that owns them",
      "A session report you can copy or save: the environment, the faults and the mod list, without the raw log",
      "Settings: choose the size at which a texture counts as oversized, from 1024px down to anything above the 512px target",
      "Every change is backed up first, and every repair that touches disk can be rolled back",
    ],
    known: [
      "Launching the game is not yet supervised: no live log streaming or crash capture",
      "Nothing here can tell you the game boots, only that the load order is structurally sound",
      "Harmony patch analysis needs a C# sidecar that is not built yet",
    ],
  },
];

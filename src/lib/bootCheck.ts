export type BootVerdict = "loading" | "loaded" | "reset" | "crashed" | "unknown";

export interface BootResult {
  verdict: BootVerdict;
  /** The line that decided it, so the verdict can be checked rather than trusted. */
  evidence?: string;
  /** Mods that reported themselves initialised, a rough measure of how far it got. */
  modsInitialised: number;
}

/**
 * RimWorld's own admission that the load failed.
 *
 * When loading throws with mods active, the game rewrites ModsConfig.xml back to Core and
 * retries, which is both the clearest failure signal there is and destructive: any load
 * order not saved elsewhere is gone by the time this line appears.
 */
const RESET = /Caught exception while loading play data but there are active mods other than Core/i;

/**
 * Mod construction, which only happens once every def has loaded.
 *
 * Reaching it means the part of startup that mods can break is behind you. It is not the
 * main menu, and nothing here claims the game is playable: it claims the mod list loaded.
 */
const MOD_CLASSES = /Verse\.LoadedModManager:CreateModClasses/;

/** A mod announcing itself. Not a standard, so this is deliberately loose. */
const MOD_READY = /^\[[^\]]+\]|::\s*initialized|Harmony patches have been applied|\bv\d+\.\d+/i;

/**
 * Unity's allocator dump, written only on a clean shutdown. Its absence after the process
 * has gone is what separates a crash from someone quitting.
 */
const CLEAN_EXIT = /^\[ALLOC_|Peak Allocated memory/;

/**
 * What a run did, judged only from what it wrote.
 *
 * Grounded in two real logs from the reference install: a failed load of 43 lines carrying
 * the reset line, and a successful one of 2,689 that does not. Nothing here infers a verdict
 * from silence, so a run still going, or one that ended in a way these markers do not
 * describe, is reported as unknown rather than guessed at.
 */
export function bootVerdict(lines: string[], exitCode?: number | null): BootResult {
  let modsInitialised = 0;
  let reachedModClasses = false;
  let cleanExit = false;
  let evidence: string | undefined;

  for (const line of lines) {
    if (RESET.test(line)) {
      // Decisive, and worth returning on immediately: everything after it describes the
      // game's recovery attempt with Core only, which is not the run being judged.
      return { verdict: "reset", evidence: line.trim(), modsInitialised };
    }
    if (MOD_CLASSES.test(line)) reachedModClasses = true;
    if (CLEAN_EXIT.test(line)) cleanExit = true;
    if (MOD_READY.test(line)) modsInitialised++;
  }

  if (reachedModClasses) {
    evidence = "Reached mod construction, so every def loaded";
    return { verdict: "loaded", evidence, modsInitialised };
  }

  // Still running, and nothing has gone wrong yet.
  if (exitCode === undefined) return { verdict: "loading", modsInitialised };

  // Gone, without the reset line and without a clean shutdown. Something took the process
  // down rather than the game deciding it could not load.
  if (!cleanExit) {
    return {
      verdict: "crashed",
      evidence: `Exited with code ${exitCode ?? "unknown"} without finishing a load`,
      modsInitialised,
    };
  }

  return { verdict: "unknown", modsInitialised };
}

/** Whether a verdict means the mod list failed to load, for a search that acts on it. */
export function isBootFailure(verdict: BootVerdict): boolean {
  return verdict === "reset" || verdict === "crashed";
}

/** Whether the verdict is settled enough to stop the game and move on. */
export function isDecided(verdict: BootVerdict): boolean {
  return verdict === "loaded" || verdict === "reset" || verdict === "crashed";
}

export function describeVerdict(result: BootResult): string {
  switch (result.verdict) {
    case "loaded":
      return `Loaded. ${result.modsInitialised} mods reported themselves during startup.`;
    case "reset":
      return "The game could not load this mod list and reset ModsConfig.xml back to Core.";
    case "crashed":
      return "The game stopped before finishing a load, and did not shut down cleanly.";
    case "loading":
      return "Still loading.";
    default:
      return "Ended in a way these markers do not describe.";
  }
}

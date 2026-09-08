export type BootVerdict = "loading" | "loaded" | "reset" | "crashed" | "crashed-after-load" | "unknown";

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

/*
 * There was a CLEAN_EXIT marker here, matching Unity's allocator dump, on the belief that it
 * is written only on a clean shutdown. It is not. A RimWorld killed mid-run with
 * Stop-Process wrote seventeen of those lines, including "Peak Allocated memory", so the
 * marker was true for a crash and a run that died before loading came back "unknown".
 *
 * The exit code answers the question the dump was being asked to answer, and on Windows
 * every process that ends has one.
 */

/**
 * The process dying, said by the game rather than inferred.
 *
 * Unity's crash handler writes the first line after it has walked the native stack, and it
 * is the only line in a log that means the process was killed rather than closed. The
 * second is what usually causes it on a modded install: one allocation the machine refused.
 *
 * These are what let a trial be judged past the main menu. Everything else here is about
 * whether the mod list loaded, which is a question that stops mattering the moment it has.
 */
const DIED = [
  /^A crash has been intercepted by the crash handler/,
  /^Could not allocate memory: System out of memory/,
];

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
  let died: string | undefined;
  let evidence: string | undefined;

  for (const line of lines) {
    if (RESET.test(line)) {
      // Decisive, and worth returning on immediately: everything after it describes the
      // game's recovery attempt with Core only, which is not the run being judged.
      return { verdict: "reset", evidence: line.trim(), modsInitialised };
    }
    if (MOD_CLASSES.test(line)) reachedModClasses = true;
    if (MOD_READY.test(line)) modsInitialised++;
    if (!died && DIED.some((d) => d.test(line))) died = line.trim();
  }

  // Checked before "loaded", because a run that loaded and then died is a failed trial and
  // used to be a passed one: the search stopped looking the moment mod construction was
  // reached, which is the earliest point at which nothing has gone wrong yet.
  if (died && reachedModClasses) {
    return { verdict: "crashed-after-load", evidence: died, modsInitialised };
  }
  if (died) return { verdict: "crashed", evidence: died, modsInitialised };

  if (reachedModClasses) {
    evidence = "Reached mod construction, so every def loaded";
    return { verdict: "loaded", evidence, modsInitialised };
  }

  // Still running, and nothing has gone wrong yet.
  if (exitCode === undefined) return { verdict: "loading", modsInitialised };

  // Gone, before mod construction, without the reset line. Something took the process down
  // rather than the game deciding it could not load. A zero code here is the one shape this
  // cannot read: the game closed tidily without ever finishing a load, which is not a thing
  // it does on its own, so it is reported as unknown rather than guessed at.
  if (exitCode !== 0) {
    return {
      verdict: "crashed",
      evidence: `Exited with code ${exitCode ?? "unknown"} without finishing a load`,
      modsInitialised,
    };
  }

  return { verdict: "unknown", modsInitialised };
}

/** Whether a verdict means this trial failed, for a search that acts on it. */
export function isBootFailure(verdict: BootVerdict): boolean {
  return verdict === "reset" || verdict === "crashed" || verdict === "crashed-after-load";
}

/**
 * Whether the verdict is settled enough to stop the game and move on.
 *
 * "loaded" is settled only for a fault that stops the mod list loading. A fault that shows
 * up in a colony is still ahead of a run that has merely finished loading, which is why the
 * search asks what it is looking for before it decides when to stop watching.
 */
export function isDecided(verdict: BootVerdict, lookingFor: FaultShape = "load"): boolean {
  if (verdict === "reset" || verdict === "crashed" || verdict === "crashed-after-load") return true;
  return verdict === "loaded" && lookingFor === "load";
}

/**
 * What the search is hunting.
 *
 * "load" is a fault that stops the mod list loading, which a trial proves by getting past
 * it. "play" is a fault that needs a colony, which a trial can only prove by being played,
 * so the game stays open and the log is read until it ends.
 */
export type FaultShape = "load" | "play";

export function describeVerdict(result: BootResult): string {
  switch (result.verdict) {
    case "loaded":
      return `Loaded. ${result.modsInitialised} mods reported themselves during startup.`;
    case "reset":
      return "The game could not load this mod list and reset ModsConfig.xml back to Core.";
    case "crashed":
      return "The game stopped before finishing a load, and did not shut down cleanly.";
    case "crashed-after-load":
      return "The mod list loaded and the game died later. This trial is a failure.";
    case "loading":
      return "Still loading.";
    default:
      return "Ended in a way these markers do not describe.";
  }
}

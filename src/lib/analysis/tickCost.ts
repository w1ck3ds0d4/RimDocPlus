/**
 * What the companion mod measured, read back.
 *
 * The mod times the tick methods each mod declares and writes the totals every five seconds.
 * This turns that into something to read. It is a pure function of the report, like every
 * other analysis here, so the only thing that had to run inside the game is the measuring.
 */

export interface TickCostEntry {
  /** The assembly the time was spent in. */
  assembly: string;
  /** The mod that owns it, as the game's own loader reported it. */
  packageId: string;
  mod: string;
  calls: number;
  ms: number;
}

export interface TickReport {
  schema: number;
  gameVersion: string;
  uptimeSeconds: number;
  /** How many tick methods the probe is timing. */
  patchedMethods: number;
  /** Ticks the colony has run. Zero at the main menu, where nothing ticks. */
  ticksPlayed: number;
  mods: TickCostEntry[];
}

export interface TickCostRow extends TickCostEntry {
  /** Milliseconds per thousand calls, which is what makes two mods comparable. */
  perThousand: number;
  /** Share of all measured mod time. */
  share: number;
}

/**
 * Parse a report, or null if it is not one.
 *
 * Null rather than throwing, because the file is written by another process on a timer and
 * the ordinary reasons to fail here are that it does not exist yet or was read mid-write.
 * Neither is worth an error on screen.
 */
export function parseTickReport(text: string | null): TickReport | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const report = parsed as TickReport;
    if (report.schema !== 1 || !Array.isArray(report.mods)) return null;
    return report;
  } catch {
    return null;
  }
}

/**
 * The measured mods, most expensive first, with the numbers that let them be compared.
 *
 * Total time is what a mod costs you, so it leads. Time per thousand calls is beside it
 * because the two answer different questions: a mod that is expensive because it is called
 * constantly is a different problem from one that is expensive every time.
 */
export function tickCostRows(report: TickReport): TickCostRow[] {
  const total = report.mods.reduce((sum, entry) => sum + entry.ms, 0);
  return report.mods
    .filter((entry) => entry.calls > 0)
    .map((entry) => ({
      ...entry,
      perThousand: (entry.ms / entry.calls) * 1000,
      share: total > 0 ? entry.ms / total : 0,
    }))
    .sort((a, b) => b.ms - a.ms);
}

/**
 * Whether the game is still ticking, and how recently it said so.
 *
 * This is the whole reason the report is written repeatedly rather than once at exit. From
 * outside the process, a game that has hung an hour into a colony looks exactly like one
 * sitting happily at the main menu, and a tick count that keeps climbing is the difference.
 */
export function isTicking(before: TickReport | null, after: TickReport | null): boolean {
  if (!before || !after) return false;
  return after.ticksPlayed > before.ticksPlayed;
}

/**
 * What the report can and cannot say, in the app's own words.
 *
 * Rendered next to the numbers rather than left for a reader to work out. A profiler that
 * does not say what it missed invites the reading that everything else is free.
 */
export function tickCoverage(report: TickReport): string {
  if (report.ticksPlayed === 0) {
    return `Watching ${report.patchedMethods} tick methods. Nothing has ticked yet: load a colony and the numbers start.`;
  }
  return (
    `${report.patchedMethods} tick methods timed across ${report.ticksPlayed.toLocaleString()} ticks. ` +
    `Only what a mod does inside a tick is counted, so work it does while drawing, on its own threads, ` +
    `or in another mod's patches is not here.`
  );
}

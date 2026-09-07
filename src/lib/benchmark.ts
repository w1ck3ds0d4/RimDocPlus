import type { SessionAnalysis } from "./analysis/logParser";
import type { GameExit } from "./shell";
import { formatMs } from "./format";

export interface RunMeasurement {
  /** The modpack this run used. */
  modpack: string;
  at: string;
  mods: number;
  /** Wall clock from launch to exit. */
  durationMs: number;
  peakMemoryMb: number;
  logLines: number;
  /** Distinct faults the log analysis found in this run. */
  faults: number;
  /** Startup phases the game reported, longest first. */
  phases: { label: string; ms: number }[];
  /** Sum of the reported phases, which is the closest thing to a load time. */
  loadMs: number;
}

const KEY = "rimdoc.runs.v1";

/**
 * What one supervised run cost.
 *
 * Everything here is measured from outside the process: phases the game writes to its own
 * log, wall clock, peak working set, and the faults the log analysis already finds. None of
 * it needs code running inside the game.
 *
 * What it deliberately does not claim is a frame rate or a tick rate. Attributing simulation
 * time to a particular mod means timing methods inside the process, which needs an in-game
 * companion. A number invented in its absence would be worse than none.
 */
export function measureRun(
  modpack: string,
  mods: number,
  exit: GameExit,
  analysis: SessionAnalysis,
): RunMeasurement {
  const phases = analysis.timings;
  return {
    modpack,
    at: new Date().toISOString(),
    mods,
    durationMs: exit.durationMs,
    peakMemoryMb: exit.peakMemoryMb,
    logLines: exit.lines,
    faults: analysis.events.length,
    phases,
    loadMs: phases.reduce((sum, p) => sum + p.ms, 0),
  };
}

export interface Comparison {
  label: string;
  a: number;
  b: number;
  /** Positive means b is worse than a. */
  deltaPct: number;
  /** How the number reads, since bytes and milliseconds do not format alike. */
  format: "ms" | "mb" | "count";
}

/**
 * Two runs, side by side.
 *
 * Only measures both runs actually carry are compared. A run that ended in a crash has no
 * meaningful load time, and pairing it against a healthy one would produce a number that
 * looks like a comparison and is not.
 */
export function compareRuns(a: RunMeasurement, b: RunMeasurement): Comparison[] {
  const rows: [string, number, number, Comparison["format"]][] = [
    ["Load time", a.loadMs, b.loadMs, "ms"],
    ["Peak memory", a.peakMemoryMb, b.peakMemoryMb, "mb"],
    ["Session length", a.durationMs, b.durationMs, "ms"],
    ["Faults", a.faults, b.faults, "count"],
    ["Mods", a.mods, b.mods, "count"],
  ];

  return rows
    .filter(([, x, y]) => x > 0 || y > 0)
    .map(([label, x, y, format]) => ({
      label,
      a: x,
      b: y,
      deltaPct: x === 0 ? (y === 0 ? 0 : 100) : Math.round(((y - x) / x) * 100),
      format,
    }));
}

export function formatMeasure(value: number, format: Comparison["format"]): string {
  if (format === "mb") return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value} MB`;
  if (format === "ms") return formatMs(value);
  return String(value);
}

export function loadRuns(): RunMeasurement[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as RunMeasurement[]) : [];
  } catch {
    return [];
  }
}

/** Kept newest first, and bounded: a comparison needs a handful of runs, not a history. */
export function recordRun(run: RunMeasurement): RunMeasurement[] {
  const next = [run, ...loadRuns()].slice(0, 20);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private window; the run still shows for as long as the app stays open */
  }
  return next;
}

export function clearRuns(): RunMeasurement[] {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
  return [];
}

/**
 * How numbers are written on screen.
 *
 * Gathered here because each of these existed three or four times over, and the copies had
 * started to disagree: one `formatBytes` stopped at megabytes while the others went down to
 * kilobytes, and one progress bar divided by a total that can be zero. A number formatted
 * two ways in one app reads as two different numbers.
 */

/**
 * A size, in the largest unit that leaves a number worth reading.
 *
 * Binary units, because this counts what is on disk and in memory rather than what a drive
 * manufacturer would call it. Never rounds to "0 KB": a file that exists should not be
 * reported as nothing.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * A duration in milliseconds, as seconds once that is the more readable of the two.
 *
 * One decimal place past a second: these are load times and repair runs, where the
 * difference between 4.2 and 4.3 seconds is noise and the second decimal was false
 * precision about a number the operating system rounded first.
 */
export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/**
 * A whole percentage, guarded against the empty case.
 *
 * A progress bar is built before its total is known and rendered on the way there, so
 * `done / total` is `0 / 0` on the first frame. Unguarded that is NaN, which lands in a
 * width and makes the bar vanish rather than sit at zero.
 */
export function percent(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.round((done / total) * 100);
}

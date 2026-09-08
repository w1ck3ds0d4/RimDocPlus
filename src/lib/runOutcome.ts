import type { GameExit } from "./shell";

/**
 * What to say about a run that did not end cleanly.
 *
 * The exit code is the thing someone searches for, so it is always printed, in hex too when
 * it is one of Windows' negative NTSTATUS values because that is the form every result for
 * it is written in. Two codes are named because they are unambiguous and common; the rest
 * are reported without a guess about what they mean.
 */
export function howItEnded(exit: GameExit): string {
  const minutes = Math.round(exit.durationMs / 60000);
  const spent = `after ${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (exit.code === 0 || exit.code === null) {
    return `RimWorld stopped writing to its log well before it closed, ${spent}.`;
  }
  // Unsigned, which is how Windows documents these and how they are searched for.
  const hex = exit.code < 0 ? ` (0x${(exit.code >>> 0).toString(16).toUpperCase()})` : "";
  const known =
    exit.code === -1
      ? "It was killed rather than closing on its own"
      : exit.code === -1073741819
        ? "That is an access violation: something read memory it does not own"
        : null;
  return known
    ? `${known}. RimWorld ended with code ${exit.code}${hex} ${spent}.`
    : `RimWorld exited with code ${exit.code}${hex} ${spent}.`;
}

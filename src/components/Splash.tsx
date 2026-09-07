import { Logo } from "./Logo";
import type { ScanProgress } from "../lib/shell";

/**
 * What the window shows while the install is being read.
 *
 * A 252-mod scan takes about four seconds, and the window used to render nothing at all for
 * the whole of it. The bar is driven by the scan's own reported position rather than an
 * indeterminate spinner, so it says how far along the work is instead of only that some
 * work exists.
 */
export function Splash({ progress, note }: { progress: ScanProgress | null; note: string }) {
  // Determinate the moment the scan reports its first folder. Before that there is nothing
  // honest to draw a percentage from, so the bar sweeps instead of claiming a position.
  const determinate = !!progress && progress.total > 0;
  const pct = determinate ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="splash" role="status" aria-live="polite">
      <div className="splash-mark">
        <Logo />
      </div>

      <div
        className={`splash-bar${determinate ? "" : " sweeping"}`}
        role="progressbar"
        aria-valuenow={determinate ? pct : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={note}
      >
        <span className="splash-fill" style={determinate ? { width: `${pct}%` } : undefined} />
      </div>

      <p className="splash-note">
        {note}
        {determinate && (
          <span className="splash-count">
            {progress.done} / {progress.total}
          </span>
        )}
      </p>

      {/* The folder currently being read. Its own line, because mod names vary wildly in
          length and reflowing the sentence above on every one of 252 updates is a mess. */}
      <p className="splash-label">{progress?.label ?? " "}</p>
    </div>
  );
}

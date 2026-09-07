import { useEffect, useRef, useState } from "react";
import type { RepairProgress, RunReport } from "../lib/shell";

export interface ConsoleLine {
  tone: "cmd" | "info" | "ok" | "warn" | "work" | "done";
  label?: string;
  text: string;
}

/**
 * The run as it happens, in a modal that cannot be dismissed while work is in flight.
 *
 * Every action reports itself, which for a texture pass is 730 lines over the better part
 * of a minute. The point is that the window is visibly doing something: a run that shows
 * nothing until it finishes is indistinguishable from one that has hung, and the actions
 * here are rewriting files in the player's install.
 */
export function RepairConsole({
  lines,
  done,
  total,
  report,
  error,
  onClose,
}: {
  lines: ConsoleLine[];
  /** How many actions have reported back so far. */
  done: number;
  total: number;
  report: RunReport | null;
  error: string | null;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const running = !report && !error;

  // Follows the tail only while the reader has not scrolled away from it. Yanking someone
  // back to the bottom while they are reading a failure they just spotted is worse than
  // letting the transcript run on without them.
  useEffect(() => {
    const body = bodyRef.current;
    if (body && pinned) body.scrollTop = body.scrollHeight;
  }, [lines, pinned]);

  useEffect(() => {
    if (running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [running, onClose]);

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="drawer-scrim console-scrim" onClick={() => !running && onClose()}>
      <div
        className="console modal"
        role="dialog"
        aria-label="Applying repairs"
        aria-busy={running}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="console-bar">
          <span className="dot r" />
          <span className="dot y" />
          <span className="dot g" />
          <span className="console-title">rimdoc apply</span>
          <span className="console-status">{error ? "failed" : running ? `${done} / ${total}` : "done"}</span>
        </div>

        <div className="console-progress" aria-hidden="true">
          <span
            className={`console-progress-fill${error ? " bad" : running ? "" : " done"}`}
            style={{ width: `${error ? 100 : pct}%` }}
          />
        </div>

        <div
          className="console-body"
          ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          }}
        >
          {lines.map((line, i) => (
            <div className={`line ${line.tone}`} key={i}>
              {line.tone === "cmd" ? (
                <>
                  <span className="prompt">$</span>
                  <span className="text">{line.text}</span>
                </>
              ) : (
                <>
                  <span className="label">{line.label ?? ""}</span>
                  <span className="text">{line.text}</span>
                </>
              )}
            </div>
          ))}
          {running && (
            <div className="line work">
              <span className="label" />
              <span className="text caret">working</span>
            </div>
          )}
        </div>

        <div className="console-foot">
          {error && <span className="prompt-error">{error}</span>}
          {report && (
            <span className="muted">
              {report.applied} applied, {report.skipped} skipped
              {report.failed > 0 ? `, ${report.failed} failed` : ""}. Backups in {report.backup_dir}.
            </span>
          )}
          <button className="btn" type="button" onClick={onClose} disabled={running}>
            {running ? "Working..." : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Turn one reported action into a transcript line. */
export function lineOf(progress: RepairProgress): ConsoleLine {
  return {
    tone: progress.ok ? "ok" : "warn",
    label: progress.ok ? "ok" : "fail",
    text: `${shorten(progress.target)}  ${progress.detail}`,
  };
}

/**
 * Keep the tail of a path, which is the part that identifies the file.
 *
 * A Workshop path is mostly the same 60 characters of Steam library prefix on every line,
 * and at 730 lines that prefix is all the reader would see.
 */
function shorten(path: string, keep = 3): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= keep) return path;
  return `.../${parts.slice(-keep).join("/")}`;
}

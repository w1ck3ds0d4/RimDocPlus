import { useEffect, useMemo, useState } from "react";
import type { Finding, Severity } from "../lib/types";
import { SEVERITY_ORDER, sortFindings } from "../lib/types";
import { frameKind, patchFrames } from "../lib/analysis/logParser";
import { useRepairApi } from "./Repair";
import { RepairAction } from "./Repair";

const SEVERITIES: Severity[] = ["critical", "error", "warning", "info"];

/**
 * Filter the list by severity.
 *
 * The active filter clears itself once nothing of that severity is left, so repairing
 * the last critical does not leave the reader staring at an empty list wondering whether
 * the findings vanished or the filter did.
 */
export function useSeverityFilter(findings: Finding[]) {
  const [active, setActive] = useState<Severity | null>(null);

  useEffect(() => {
    if (active && !findings.some((f) => f.severity === active)) setActive(null);
  }, [findings, active]);

  const filtered = useMemo(
    () => (active ? findings.filter((f) => f.severity === active) : findings),
    [findings, active],
  );

  return {
    active,
    filtered,
    toggle: (severity: Severity) => setActive((current) => (current === severity ? null : severity)),
  };
}

export function SeveritySummary({
  findings,
  active,
  onToggle,
}: {
  findings: Finding[];
  active?: Severity | null;
  onToggle?: (severity: Severity) => void;
}) {
  return (
    <div className="summary">
      {SEVERITIES.map((severity) => {
        const count = findings.filter((f) => f.severity === severity).length;
        const on = active === severity;
        return (
          <button
            key={severity}
            type="button"
            className={`chip${count === 0 ? " zero" : ""}${on ? " active" : ""}`}
            style={{ ["--sev" as string]: `var(--${severity})` }}
            // Filtering to a severity with nothing in it would only ever show nothing.
            disabled={!onToggle || count === 0}
            aria-pressed={on}
            title={count === 0 ? `No ${severity} findings` : on ? "Show everything" : `Show only ${severity}`}
            onClick={() => onToggle?.(severity)}
          >
            <b>{count}</b>
            <small>{severity}</small>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The findings, with the ones nothing can be done about kept separate.
 *
 * A patch override is reported deliberately and resolves never: it is how content layers,
 * not a fault. Thirteen of them sitting in one list beside a single real problem made a
 * finished triage look like it had achieved nothing, which is the opposite of true. Split
 * on whether a repair exists, because that is exactly the distinction being drawn.
 */
export function FindingList({ findings, empty }: { findings: Finding[]; empty: string }) {
  const settled = findings.filter((f) => f.stale);
  // An observation with a repair is still an observation. Sorting on `fix` alone put every
  // patch override above the list of actual faults.
  const actionable = findings.filter((f) => !f.stale && f.fix && !f.observation);
  const notes = findings.filter((f) => !f.stale && (!f.fix || f.observation));

  if (!findings.length) return <p className="muted">{empty}</p>;

  return (
    <>
      {actionable.length > 0 && (
        <div className="finding-list">
          {sortFindings(actionable).map((finding) => (
            <FindingRow key={finding.id} finding={finding} />
          ))}
        </div>
      )}

      {actionable.length === 0 && notes.length > 0 && (
        <p className="muted resolved-note">
          Nothing here has an outstanding repair. What follows is what the Doctor observed, not work waiting
          to be done.
        </p>
      )}

      {settled.length > 0 && (
        <>
          <p className="section-title">
            Already dealt with <span className="count">{settled.length}</span>
          </p>
          <p className="note">
            Read out of a log of a run that has finished, and the current scan shows they no longer apply.
            Kept because knowing a fault happened is worth something even once it is gone.
          </p>
          <div className="finding-list settled">
            {sortFindings(settled).map((finding) => (
              <FindingRow key={finding.id} finding={finding} />
            ))}
          </div>
        </>
      )}

      {notes.length > 0 && (
        <>
          <p className="section-title">
            Observations <span className="count">{notes.length}</span>
          </p>
          <p className="note">
            Read rather than fixed. A patch override is how one mod layers content over another, so it is
            reported and left alone; a total measurement is a fact about the list, not a defect.
          </p>
          <div className="finding-list notes">
            {sortFindings(notes).map((finding) => (
              <FindingRow key={finding.id} finding={finding} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <details
      className="finding"
      data-sev={finding.severity}
      style={{ ["--sev" as string]: `var(--${finding.severity})` }}
      // Anything the game cannot recover from is worth reading without a click.
      open={SEVERITY_ORDER[finding.severity] === 0}
    >
      <summary>
        <i className="sev-dot" />
        <span className="f-title">{finding.title}</span>
        {finding.stale && <span className="f-settled">settled</span>}
        {finding.count && finding.count > 1 ? (
          <span className="f-count" title={`Seen ${finding.count} times`}>
            &times;{finding.count}
          </span>
        ) : null}
        <span className="f-rule">{finding.rule}</span>
      </summary>

      <div className="f-body">
        {finding.stale && <p className="f-settled-why">{finding.stale}</p>}
        <p className="f-detail">{finding.detail}</p>

        {finding.packageIds.length > 0 && (
          <div className="f-mods">
            {finding.packageIds.slice(0, 12).map((id) => (
              <span key={id}>{id}</span>
            ))}
            {finding.packageIds.length > 12 && (
              <span className="more">and {finding.packageIds.length - 12} more</span>
            )}
          </div>
        )}

        {finding.frames && finding.frames.length > 0 && <StackTrace frames={finding.frames} />}

        <div className="f-foot">
          <RepairAction finding={finding} />
          {finding.firstLine && <span className="f-line">log line {finding.firstLine}</span>}
        </div>
      </div>
    </details>
  );
}

/**
 * The trace, with engine plumbing dimmed. Harmony patch annotations are pulled out first
 * because they name the mod whose patch is on the stack, which is usually the answer.
 */
function StackTrace({ frames }: { frames: string[] }) {
  const mods = useRepairApi()?.scan.mods ?? [];
  const patches = frames.filter((f) => frameKind(f) === "patch");
  const modFrames = frames.filter((f) => frameKind(f) === "mod");
  const named = patchFrames(frames, mods);

  return (
    <>
      {/* Named above the trace rather than left inside it. A fault inside a postfix belongs
          to whoever wrote the postfix, not to whatever they patched, and reading forty
          frames of Mono plumbing is the only other way to see that. */}
      {named.length > 0 && (
        <div className="patched-by">
          <h4>Ran through {named.length === 1 ? "a patch" : `${named.length} patches`}</h4>
          <ul>
            {named.map((p) => (
              <li key={`${p.kind}:${p.method}`}>
                <span className={`patch-kind ${p.kind.toLowerCase()}`}>{p.kind}</span>
                <code>{p.method}</code>
                <span className="muted">
                  {p.packageId
                    ? (mods.find((m) => m.packageId === p.packageId)?.name ?? p.packageId)
                    : "owner unknown"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <details className="trace" open={frames.length <= 12}>
        <summary>
          Stack trace
          <span className="trace-meta">
            {frames.length} frames
            {modFrames.length > 0 && `, ${modFrames.length} in mod code`}
            {patches.length > 0 && `, ${patches.length} patched`}
          </span>
        </summary>
        <ol className="trace-body">
          {frames.map((frame, i) => (
            <li key={`${i}:${frame}`} className={`fr ${frameKind(frame)}`}>
              <code>{stripAddress(frame)}</code>
            </li>
          ))}
        </ol>
      </details>
    </>
  );
}

/** Mono appends an IL offset and an assembly GUID to every frame. Neither helps a reader. */
function stripAddress(frame: string): string {
  return frame.replace(/\s*\[0x[0-9a-f]+\]\s*in\s*<[0-9a-f]+>:\d+\s*$/i, "").trim();
}

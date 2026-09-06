import type { Finding, Severity } from "../lib/types";
import { SEVERITY_ORDER, sortFindings } from "../lib/types";
import { frameKind } from "../lib/analysis/logParser";
import { RepairAction } from "./Repair";

const SEVERITIES: Severity[] = ["critical", "error", "warning", "info"];

export function SeveritySummary({ findings }: { findings: Finding[] }) {
  return (
    <div className="summary">
      {SEVERITIES.map((severity) => {
        const count = findings.filter((f) => f.severity === severity).length;
        return (
          <div
            key={severity}
            className={`chip${count === 0 ? " zero" : ""}`}
            style={{ ["--sev" as string]: `var(--${severity})` }}
          >
            <b>{count}</b>
            <small>{severity}</small>
          </div>
        );
      })}
    </div>
  );
}

export function FindingList({ findings, empty }: { findings: Finding[]; empty: string }) {
  if (!findings.length) return <p className="muted">{empty}</p>;
  return (
    <div className="finding-list">
      {sortFindings(findings).map((finding) => (
        <FindingRow key={finding.id} finding={finding} />
      ))}
    </div>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <details
      className="finding"
      style={{ ["--sev" as string]: `var(--${finding.severity})` }}
      // Anything the game cannot recover from is worth reading without a click.
      open={SEVERITY_ORDER[finding.severity] === 0}
    >
      <summary>
        <i className="sev-dot" />
        <span className="f-title">{finding.title}</span>
        {finding.count && finding.count > 1 ? (
          <span className="f-count" title={`Seen ${finding.count} times`}>
            &times;{finding.count}
          </span>
        ) : null}
        <span className="f-rule">{finding.rule}</span>
      </summary>

      <div className="f-body">
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
  const patches = frames.filter((f) => frameKind(f) === "patch");
  const modFrames = frames.filter((f) => frameKind(f) === "mod");

  return (
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
  );
}

/** Mono appends an IL offset and an assembly GUID to every frame. Neither helps a reader. */
function stripAddress(frame: string): string {
  return frame.replace(/\s*\[0x[0-9a-f]+\]\s*in\s*<[0-9a-f]+>:\d+\s*$/i, "").trim();
}

import type { Finding, Severity } from "../lib/types";
import { SEVERITY_ORDER, sortFindings } from "../lib/types";

const SEVERITIES: Severity[] = ["critical", "error", "warning", "info"];

export function SeveritySummary({ findings }: { findings: Finding[] }) {
  return (
    <div className="summary">
      {SEVERITIES.map((severity) => (
        <div key={severity} className="chip" style={{ ["--sev" as string]: `var(--${severity})` }}>
          <b>{findings.filter((f) => f.severity === severity).length}</b>
          <small>{severity}</small>
        </div>
      ))}
    </div>
  );
}

export function FindingList({ findings, empty }: { findings: Finding[]; empty: string }) {
  if (!findings.length) return <p style={{ color: "var(--dim)" }}>{empty}</p>;
  return (
    <>
      {sortFindings(findings).map((finding) => (
        <FindingRow key={finding.id} finding={finding} />
      ))}
    </>
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
        {finding.count && finding.count > 1 ? <span className="f-count">{finding.count}</span> : null}
        <span className="f-rule">{finding.rule}</span>
      </summary>
      <div className="f-body">
        <p className="f-detail">{finding.detail}</p>
        {finding.packageIds.length > 0 && (
          <div className="f-mods">
            {finding.packageIds.slice(0, 12).map((id) => (
              <span key={id}>{id}</span>
            ))}
            {finding.packageIds.length > 12 && <span>and {finding.packageIds.length - 12} more</span>}
          </div>
        )}
        {finding.fix && (
          <button className="fix" type="button" disabled title="Repair engine lands in the next slice">
            {finding.fix.label}
            <span className="tier">TIER {finding.fix.tier}</span>
            {finding.fix.auto && <span className="auto">auto</span>}
          </button>
        )}
      </div>
    </details>
  );
}

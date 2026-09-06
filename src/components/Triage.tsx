import { useState } from "react";
import type { Finding, ScanResult } from "../lib/types";
import type { Profile } from "../lib/profiles";
import { toPowerShell } from "../lib/repair/repairs";
import { allFileActions, runTriage, type TriageResult } from "../lib/repair/triage";
import { download } from "../lib/download";

/**
 * Triage: assess everything, treat what can be treated safely, escalate the rest.
 *
 * The automatic repairs are applied in one commit so the whole pass undoes as a unit.
 * Everything that needs a decision, a disk write, or the player is listed rather than
 * guessed at, so the report is a worklist and not a claim that the game is now fixed.
 */
export function Triage({
  findings,
  scan,
  profile,
  applyProfile,
}: {
  findings: Finding[];
  scan: ScanResult;
  profile: Profile;
  applyProfile: (profile: Profile, label: string) => void;
}) {
  const [result, setResult] = useState<TriageResult | null>(null);

  function run() {
    const triage = runTriage(findings, { scan, profile });
    if (triage.applied.length)
      applyProfile(
        triage.profile,
        `triage (${triage.applied.length} fix${triage.applied.length === 1 ? "" : "es"})`,
      );
    setResult(triage);
  }

  return (
    <>
      <div className="triage-bar">
        <button className="triage-btn" type="button" onClick={run}>
          <span className="cross" aria-hidden="true">
            +
          </span>
          <span className="triage-label">
            <b>Perform triage</b>
            <small>Apply every safe fix, stage the rest</small>
          </span>
          <span className="triage-count">{findings.length}</span>
        </button>
      </div>

      {result && <TriageReport result={result} onDismiss={() => setResult(null)} />}
    </>
  );
}

function TriageReport({ result, onDismiss }: { result: TriageResult; onDismiss: () => void }) {
  const actions = allFileActions(result);
  const resolved = result.before - result.after;

  return (
    <div className="triage-report">
      <div className="triage-head">
        <h2>
          {resolved > 0
            ? `${resolved} of ${result.before} issues resolved`
            : "Nothing to apply automatically"}
        </h2>
        <button className="btn" type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>

      <Section
        title="Applied to the pack"
        count={result.applied.length}
        tone="ok"
        empty="No automatic repairs were needed."
      >
        {result.applied.map(({ finding, summary }) => (
          <li key={finding.id}>
            <b>{finding.title}</b>
            <span>{summary}</span>
          </li>
        ))}
      </Section>

      <Section
        title="Needs your decision"
        count={result.decisions.length}
        tone="warn"
        empty="Nothing ambiguous."
      >
        {result.decisions.map(({ finding, plan }) => (
          <li key={finding.id}>
            <b>{finding.title}</b>
            <span>{plan.choices.map((c) => c.label).join("  |  ")}</span>
          </li>
        ))}
      </Section>

      <Section title="Needs a script" count={actions.length} tone="warn" empty="Nothing on disk to change.">
        {result.files.map(({ finding, actions: own, summary }) => (
          <li key={finding.id}>
            <b>
              {finding.title} <span className="muted">({own.length})</span>
            </b>
            <span>{summary}</span>
          </li>
        ))}
        {actions.length > 0 && (
          <li className="triage-cta">
            <button
              className="btn primary"
              type="button"
              onClick={() => download("rimdoc-triage.ps1", toPowerShell(actions))}
            >
              Download all {actions.length} as one script
            </button>
            <span className="repair-note">Backs up every file before touching it.</span>
          </li>
        )}
      </Section>

      <Section title="Needs you" count={result.external.length} tone="info" empty="Nothing outside the app.">
        {result.external.map(({ finding, summary, url }) => (
          <li key={finding.id}>
            <b>{finding.title}</b>
            <span>{summary}</span>
            {url && (
              <a href={url} target="_blank" rel="noreferrer noopener">
                Open
              </a>
            )}
          </li>
        ))}
      </Section>

      <Section
        title="No repair yet"
        count={result.unresolved.length}
        tone="dim"
        empty="Everything found has a repair."
      >
        {result.unresolved.map((finding) => (
          <li key={finding.id}>
            <b>{finding.title}</b>
            <span className="muted">{finding.rule}</span>
          </li>
        ))}
      </Section>

      <p className="triage-foot">
        Triage applies what is provably safe and stages what is not. It does not guarantee the game runs:
        problems that only appear once the game is executing need the supervised launch and the headless boot
        check, neither of which is built yet.
      </p>
    </div>
  );
}

function Section({
  title,
  count,
  tone,
  empty,
  children,
}: {
  title: string;
  count: number;
  tone: string;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`triage-section ${tone}`}>
      <p className="triage-section-title">
        {title}
        <span className="n">{count}</span>
      </p>
      {count === 0 ? <p className="muted triage-empty">{empty}</p> : <ul>{children}</ul>}
    </div>
  );
}

import { useEffect, useState } from "react";
import type { Finding, ScanResult, WorkshopCache } from "../lib/types";
import type { Profile } from "../lib/profiles";
import { runStaticRulesWithDiagnostics, type RuleRun } from "../lib/analysis/rules";
import { buildDiagnostics } from "../lib/diagnostics";
import { clearDevLog, getDevLog, subscribeDevLog, type CapturedEntry } from "../lib/devLog";
import { runSelfChecks } from "../lib/selfCheck";
import { download } from "../lib/download";

const DEV_KEY = "rimdoc.devMode";

export function loadDevMode(): boolean {
  try {
    return localStorage.getItem(DEV_KEY) === "1";
  } catch {
    return false;
  }
}

export function Settings({
  scan,
  workshop,
  profiles,
  session,
  devMode,
  onDevMode,
}: {
  scan: ScanResult;
  workshop: WorkshopCache | null;
  profiles: Profile[];
  session: { path: string; text: string } | null;
  devMode: boolean;
  onDevMode: (on: boolean) => void;
}) {
  return (
    <>
      <p className="section-title">Developer</p>
      <div className="setting">
        <label className="setting-toggle">
          <input
            type="checkbox"
            checked={devMode}
            onChange={(e) => onDevMode(e.target.checked)}
            aria-label="Developer mode"
          />
          <span className="switch" aria-hidden="true">
            <i />
          </span>
          <span className="setting-text">
            <b>Developer mode</b>
            <small>
              Shows what every rule and parser actually produced, and surfaces errors instead of swallowing
              them.
            </small>
          </span>
        </label>
      </div>

      {devMode && <Diagnostics scan={scan} workshop={workshop} profiles={profiles} session={session} />}
    </>
  );
}

function Diagnostics({
  scan,
  workshop,
  profiles,
  session,
}: {
  scan: ScanResult;
  workshop: WorkshopCache | null;
  profiles: Profile[];
  session: { path: string; text: string } | null;
}) {
  const [runs, setRuns] = useState<RuleRun[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const groups = buildDiagnostics(scan, workshop, profiles, session);

  useEffect(() => {
    const result = runStaticRulesWithDiagnostics(scan);
    setRuns(result.runs);
    setFindings(result.findings);
  }, [scan]);

  const checks = runSelfChecks(scan, findings);
  const failedChecks = checks.filter((c) => !c.ok);

  const broken = runs.filter((r) => r.error);
  const silent = runs.filter((r) => !r.error && r.count === 0);
  const zeroes = groups.flatMap((g) => g.stats.filter((s) => s.suspiciousWhenZero && isZero(s.value)));

  return (
    <>
      <p className="section-title">Health</p>
      <div
        className={`dev-banner${broken.length || zeroes.length || failedChecks.length ? " bad" : " good"}`}
      >
        {broken.length > 0
          ? `${broken.length} rule(s) threw`
          : failedChecks.length > 0
            ? `${failedChecks.length} self-check(s) failed`
            : zeroes.length > 0
              ? `${zeroes.length} count(s) are zero that should not be`
              : "Every rule ran, every check passed, every parser produced something"}
      </div>

      <p className="section-title">Self-checks</p>
      <div className="checks">
        {checks.map((check) => (
          <div key={check.name} className={`check${check.ok ? "" : " bad"}`}>
            <span className="mark">{check.ok ? "PASS" : "FAIL"}</span>
            <span className="check-name">{check.name}</span>
            <span className="check-detail">{check.detail}</span>
          </div>
        ))}
      </div>

      <CapturedConsole />

      <p className="section-title">Rules</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Rule</th>
              <th style={{ width: 90 }}>Findings</th>
              <th style={{ width: 80 }}>Time</th>
              <th style={{ width: 220 }}>Error</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.name} className={run.error ? "dev-error" : undefined}>
                <td className="pid">{run.name}</td>
                <td className="num">{run.count}</td>
                <td className="num">{run.ms.toFixed(1)} ms</td>
                <td className="num">{run.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {silent.length > 0 && (
        <p className="note">
          Produced nothing: {silent.map((r) => r.name).join(", ")}. Usually correct, but a rule that never
          matches looks exactly like a rule with nothing to report.
        </p>
      )}

      {groups.map((group) => (
        <div key={group.title}>
          <p className="section-title">{group.title}</p>
          <div className="dev-stats">
            {group.stats.map((stat) => (
              <div
                key={stat.label}
                className={`dev-stat${stat.suspiciousWhenZero && isZero(stat.value) ? " zero" : ""}`}
              >
                <small>{stat.label}</small>
                <b>{stat.value}</b>
              </div>
            ))}
          </div>
        </div>
      ))}

      <p className="section-title">Export</p>
      <div className="toolbar">
        <button
          className="btn"
          type="button"
          onClick={() =>
            download(
              "rimdoc-diagnostics.json",
              JSON.stringify({ scannedAt: scan.scannedAt, runs, groups }, null, 2),
            )
          }
        >
          Download diagnostics
        </button>
        <span className="repair-note">
          Rule timings and parse counts only. No file paths from your install.
        </span>
      </div>
    </>
  );
}

/**
 * Console errors and warnings, mirrored into the app.
 *
 * React reports duplicate keys and similar only to the console, which means they are
 * invisible unless devtools happens to be open. Repeats collapse into a count, because
 * a render warning fires once per render and 400 identical rows say nothing extra.
 */
function CapturedConsole() {
  const [entries, setEntries] = useState<CapturedEntry[]>(getDevLog);

  useEffect(() => subscribeDevLog(() => setEntries(getDevLog())), []);

  return (
    <>
      <p className="section-title">Console</p>
      {entries.length === 0 ? (
        <p className="muted">Nothing logged since this page loaded.</p>
      ) : (
        <>
          <div className="console">
            <div className="console-body">
              {entries.map((entry, i) => (
                <div className={`line ${entry.level === "error" ? "warn" : "info"}`} key={i}>
                  <span className="label">{entry.at}</span>
                  <span className="text">
                    {entry.count > 1 && <b>&times;{entry.count} </b>}
                    {entry.text}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="toolbar" style={{ marginTop: 8 }}>
            <button className="btn" type="button" onClick={clearDevLog}>
              Clear {entries.length}
            </button>
          </div>
        </>
      )}
    </>
  );
}

function isZero(value: string): boolean {
  // "0", "0 of 253" and "0.00 GB" all count; "1024" and "10 of 12" do not.
  return /^0(\s|$|\.0*(\s|$))/.test(value.trim());
}

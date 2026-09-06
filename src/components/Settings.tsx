import { useEffect, useState } from "react";
import type { ScanResult, WorkshopCache } from "../lib/types";
import type { Profile } from "../lib/profiles";
import { runStaticRulesWithDiagnostics, type RuleRun } from "../lib/analysis/rules";
import { buildDiagnostics } from "../lib/diagnostics";
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
  const groups = buildDiagnostics(scan, workshop, profiles, session);

  useEffect(() => {
    setRuns(runStaticRulesWithDiagnostics(scan).runs);
  }, [scan]);

  const broken = runs.filter((r) => r.error);
  const silent = runs.filter((r) => !r.error && r.count === 0);
  const zeroes = groups.flatMap((g) => g.stats.filter((s) => s.suspiciousWhenZero && isZero(s.value)));

  return (
    <>
      <p className="section-title">Health</p>
      <div className={`dev-banner${broken.length || zeroes.length ? " bad" : " good"}`}>
        {broken.length > 0
          ? `${broken.length} rule(s) threw`
          : zeroes.length > 0
            ? `${zeroes.length} count(s) are zero that should not be`
            : "Every rule ran and every parser produced something"}
      </div>

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

function isZero(value: string): boolean {
  // "0", "0 of 253" and "0.00 GB" all count; "1024" and "10 of 12" do not.
  return /^0(\s|$|\.0*(\s|$))/.test(value.trim());
}

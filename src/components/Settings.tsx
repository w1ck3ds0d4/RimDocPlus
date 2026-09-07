import { useEffect, useMemo, useState } from "react";
import type { Finding, ScanResult, WorkshopCache } from "../lib/types";
import type { Modpack } from "../lib/modpacks";
import { runStaticRulesWithDiagnostics, type RuleRun } from "../lib/analysis/rules";
import { DEFAULT_OVERSIZE_PX } from "../lib/analysis/performance";
import { buildDiagnostics } from "../lib/diagnostics";
import { clearDevLog, getDevLog, subscribeDevLog, type CapturedEntry } from "../lib/devLog";
import { runSelfChecks } from "../lib/selfCheck";
import { download } from "../lib/download";
import { resetApp, storedKeys } from "../lib/reset";
import { useConfirm } from "./Confirm";

const DEV_KEY = "rimdoc.devMode";
const OVERSIZE_KEY = "rimdoc.oversizePx";

export function loadDevMode(): boolean {
  try {
    return localStorage.getItem(DEV_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The size at which a texture is worth resizing.
 *
 * The scan records everything above the 512px downscale target, so this only decides which
 * of them the rule counts. Moving it re-decides that immediately, with no rescan.
 */
export function loadOversizePx(): number {
  try {
    const raw = Number(localStorage.getItem(OVERSIZE_KEY));
    return OVERSIZE_CHOICES.some((c) => c.px === raw) ? raw : DEFAULT_OVERSIZE_PX;
  } catch {
    return DEFAULT_OVERSIZE_PX;
  }
}

export function saveOversizePx(px: number): void {
  try {
    localStorage.setItem(OVERSIZE_KEY, String(px));
  } catch {
    /* private window; the choice still holds for this session */
  }
}

const OVERSIZE_CHOICES = [
  { px: 1024, label: "1024px", note: "Only the obviously outsized. The default, and the safest." },
  { px: 768, label: "768px", note: "Catches the middle band most mods sit in." },
  { px: 513, label: "Anything above 512px", note: "Everything the 512px target could shrink." },
];

export function Settings({
  scan,
  workshop,
  modpacks,
  session,
  devMode,
  onDevMode,
  oversizePx,
  onOversizePx,
}: {
  scan: ScanResult;
  workshop: WorkshopCache | null;
  modpacks: Modpack[];
  session: { path: string; text: string } | null;
  devMode: boolean;
  onDevMode: (on: boolean) => void;
  oversizePx: number;
  onOversizePx: (px: number) => void;
}) {
  return (
    <>
      <p className="section-title">Textures</p>
      <div className="setting">
        <div className="setting-head">
          <b>Call a texture oversized at</b>
          <span className="muted">
            Resizing never goes below 512px, which is already generous at RimWorld's zoom. This decides how
            far down from there the Doctor bothers you, and what a triage pass will touch.
          </span>
        </div>
        <div className="segmented">
          {OVERSIZE_CHOICES.map((choice) => (
            <button
              key={choice.px}
              type="button"
              aria-pressed={oversizePx === choice.px}
              title={choice.note}
              onClick={() => onOversizePx(choice.px)}
            >
              {choice.label}
            </button>
          ))}
        </div>
        <p className="note">
          {OVERSIZE_CHOICES.find((c) => c.px === oversizePx)?.note} Lowering it takes effect at once: the scan
          already records every texture above 512px, so nothing needs re-reading.
        </p>
      </div>

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

      {devMode && <Diagnostics scan={scan} workshop={workshop} modpacks={modpacks} session={session} />}
      {devMode && <ResetApp modpacks={modpacks} />}
    </>
  );
}

/**
 * Put the app back to a first run.
 *
 * Behind developer mode because it is for testing what a new player sees, not for tidying
 * up: everything it clears was worth keeping until someone deliberately decided otherwise.
 * It forgets and nothing more. The backups a repair took and the builds in the vault are
 * how real changes to a real install get undone, and they survive this untouched.
 */
function ResetApp({ modpacks }: { modpacks: Modpack[] }) {
  const { confirm, dialog } = useConfirm();
  const keys = storedKeys();

  async function reset() {
    const ok = await confirm({
      title: "Put the app back to a first run?",
      body: (
        <>
          <p>
            Forgets {keys.length} stored {keys.length === 1 ? "item" : "items"}: your {modpacks.length}{" "}
            modpack{modpacks.length === 1 ? " and its" : "s and their"} pins, the run history, any search in
            progress, the install baseline, and these settings. Developer mode goes with them, which is what a
            first run looks like.
          </p>
          <p className="muted">
            Your game is not touched. Neither are the backups a repair took, nor the builds in the vault:
            those are how real changes get undone, and this is not a repair.
          </p>
        </>
      ),
      confirmLabel: "Forget all of it",
      destructive: true,
    });
    if (!ok) return;
    resetApp();
    // Reloaded rather than re-rendered, because half this state was read once at startup and
    // handed down as props. Anything short of starting again shows a mixture of the two.
    window.location.reload();
  }

  return (
    <div className="setting">
      {dialog}
      <span className="setting-text">
        <b>Reset the app</b>
        <small>
          Clears everything RimDoc+ remembers, so the next start is a first one. {keys.length} stored{" "}
          {keys.length === 1 ? "item" : "items"} right now. Your install, your backups and the vault are left
          alone.
        </small>
      </span>
      <button className="btn danger" type="button" onClick={() => void reset()}>
        Reset the app
      </button>
    </div>
  );
}

function Diagnostics({
  scan,
  workshop,
  modpacks,
  session,
}: {
  scan: ScanResult;
  workshop: WorkshopCache | null;
  modpacks: Modpack[];
  session: { path: string; text: string } | null;
}) {
  const [runs, setRuns] = useState<RuleRun[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const groups = useMemo(
    () => buildDiagnostics(scan, workshop, modpacks, session),
    [scan, workshop, modpacks, session],
  );

  useEffect(() => {
    const result = runStaticRulesWithDiagnostics(scan);
    setRuns(result.runs);
    setFindings(result.findings);
  }, [scan]);

  const checks = useMemo(() => runSelfChecks(scan, findings), [scan, findings]);
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

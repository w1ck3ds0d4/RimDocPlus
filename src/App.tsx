import { useCallback, useEffect, useMemo, useState } from "react";
import type { Finding, ScanResult, WorkshopCache } from "./lib/types";
import { runStaticRules } from "./lib/analysis/rules";
import { analyzeLog, findingsFromLog, type SessionAnalysis } from "./lib/analysis/logParser";
import { loadScan, loadSession, loadWorkshop } from "./lib/devData";
import {
  diffModpacks,
  loadModpacks,
  modpackFromScan,
  saveBaselineOnce,
  saveModpacks,
  setupName,
  type Modpack,
} from "./lib/modpacks";
import { FindingList, SeveritySummary, useSeverityFilter } from "./components/Findings";
import { PackEditor } from "./components/ModpackEditor";
import { Modpacks } from "./components/Modpacks";
import { LogSourcePicker, SessionReport, type LogSource } from "./components/SessionReport";
import { RepairProvider } from "./components/Repair";
import { Triage } from "./components/Triage";
import { Library } from "./components/Library";
import { ModDetail } from "./components/ModDetail";
import { Home } from "./components/Home";
import { Bisect } from "./components/Bisect";
import { PatchProbe } from "./components/PatchProbe";
import { findingsFromProbe, type ProbeReport } from "./lib/analysis/harmony";
import { Saves } from "./components/Saves";
import { GameWatch } from "./components/GameWatch";
import { Vault } from "./components/Vault";
import { record } from "./lib/history";
import { installDiff } from "./lib/installDiff";
import { Settings, loadDevMode, loadOversizePx, saveOversizePx } from "./components/Settings";
import { GameControls } from "./components/GameControls";
import { Logo } from "./components/Logo";
import { TabIcon } from "./components/TabIcon";
import { Splash } from "./components/Splash";
import { inShell, readSessionLog, scanInstall, watchScan, type ScanProgress } from "./lib/shell";

type Tab = "home" | "doctor" | "session" | "saves" | "packs" | "order" | "library" | "settings";

export default function App() {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [session, setSession] = useState<{ path: string; text: string } | null>(null);
  /**
   * Which log the Session tab is reading.
   *
   * RimWorld truncates Player.log on launch, so after a crash the run worth reading is the
   * previous one and the live file describes the relaunch that went looking for it. Pasting
   * covers the log RimWorld's own debug window copies out, which carries the mod list and
   * the Harmony patches that Player.log alone does not.
   */
  const [logSource, setLogSource] = useState<LogSource>("current");
  const [pasted, setPasted] = useState("");
  /** Bumped when the header asks for a watched run. */
  const [watchRequest, setWatchRequest] = useState(0);
  const [openMod, setOpenMod] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<WorkshopCache | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("home");
  const [modpacks, setProfiles] = useState<Modpack[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [devMode, setDevMode] = useState(loadDevMode);
  const [scanning, setScanning] = useState(false);
  const [oversizePx, setOversizePx] = useState(loadOversizePx);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);

  const setDevModePersisted = useCallback((on: boolean) => {
    setDevMode(on);
    try {
      localStorage.setItem("rimdoc.devMode", on ? "1" : "0");
    } catch {
      /* private window; the toggle still works for this session */
    }
  }, []);
  // Every repair pushes the modpack it replaced, so any applied fix is one click from undone.
  const [undoStack, setUndoStack] = useState<{ modpack: Modpack; label: string }[]>([]);

  useEffect(() => {
    // Armed before the scan starts, or the first folders report into nothing and the bar
    // begins part-way along.
    let stop: (() => void) | undefined;
    void watchScan(setScanProgress).then((off) => {
      stop = off;
    });

    // Both the install and the log are read live in the shell. The browser has only the
    // fixtures `pnpm scan` wrote.
    Promise.all([
      inShell() ? scanInstall() : loadScan(),
      inShell() ? readSessionLog(false) : loadSession(),
      loadWorkshop(),
    ])
      .then(([s, l, w]) => {
        setScan(s);
        setSession(l);
        setWorkshop(w);
        if (!s) return;
        const stored = loadModpacks();
        // One modpack to work in. The order the install started with is recorded separately
        // as a baseline, because a second identical modpack is noise until something
        // diverges, and there is nothing to restore to before then.
        const seeded = stored.length
          ? // Modpacks saved before the name depended on the install keep working; only
            // the placeholder name is brought up to date.
            stored.map((p) => (p.name === "Current game setup" ? { ...p, name: setupName(s) } : p))
          : [modpackFromScan(s, setupName(s))];
        // Recorded on the very first scan and never overwritten, so there is always a
        // record of the order the install started with.
        saveBaselineOnce(s);
        setProfiles(seeded);
        setActiveId(seeded[0].id);
      })
      .finally(() => {
        setLoading(false);
        setScanProgress(null);
        stop?.();
      });
  }, []);

  useEffect(() => {
    if (modpacks.length) saveModpacks(modpacks);
  }, [modpacks]);

  const active = modpacks.find((p) => p.id === activeId) ?? null;

  const upsert = useCallback((modpack: Modpack) => {
    setProfiles((current) =>
      current.some((p) => p.id === modpack.id)
        ? current.map((p) => (p.id === modpack.id ? modpack : p))
        : [...current, modpack],
    );
  }, []);

  const create = useCallback((modpack: Modpack) => {
    setProfiles((current) => [...current, modpack]);
    setActiveId(modpack.id);
  }, []);

  /**
   * Commit a repaired modpack, remembering the one it replaced.
   *
   * Both updates are issued side by side rather than nesting one inside the other's
   * updater. React re-invokes updaters (twice under StrictMode), so a setState hidden
   * in one pushed the same undo entry twice per repair.
   */
  const applyModpack = useCallback(
    (modpack: Modpack, label: string) => {
      const previous = modpacks.find((p) => p.id === modpack.id);
      if (previous) setUndoStack((stack) => [{ modpack: previous, label }, ...stack].slice(0, 20));
      setProfiles((current) => current.map((p) => (p.id === modpack.id ? modpack : p)));
      // Recorded here rather than at each call site: everything that changes a load order
      // goes through this function, so the journal cannot miss one by omission.
      const delta = previous ? modpack.activeOrder.length - previous.activeOrder.length : 0;
      record({
        kind: "modpack",
        summary: `${label} in ${modpack.name}`,
        detail: `${modpack.activeOrder.length} mods enabled${
          delta === 0 ? "" : delta > 0 ? `, ${delta} added` : `, ${-delta} removed`
        }`,
      });
    },
    [modpacks],
  );

  /**
   * Retake the scan.
   *
   * Called after anything that changes the install, so the findings describe what is on
   * disk rather than what was there when the app started. Only the scan is replaced: the
   * modpacks are the user's own state and a rescan is not a reason to discard them.
   */
  const rescan = useCallback(async () => {
    if (!inShell() || scanning) return;
    setScanning(true);
    const stop = await watchScan(setScanProgress);
    try {
      // The log is retaken alongside the install. A rescan that refreshed only the files
      // left the Session tab reporting faults from a run the player had already dealt with,
      // with no way to clear them short of restarting the app.
      const [next, log] = await Promise.all([
        scanInstall(),
        // Retaken from whichever log is being read, so a rescan does not quietly switch the
        // Session tab back to the live run while the picker still says otherwise.
        logSource === "pasted" || logSource === "link"
          ? Promise.resolve(session)
          : readSessionLog(logSource === "previous"),
      ]);
      setScan(next);
      setSession(log);
      // The assemblies may have changed with everything else, so the last report is no
      // longer about what is on disk.
      setProbe(null);
    } catch (e) {
      console.error("Rescan failed", e);
    } finally {
      stop();
      setScanProgress(null);
      setScanning(false);
    }
  }, [scanning]);

  const undo = useCallback(() => {
    const [last, ...rest] = undoStack;
    if (!last) return;
    setProfiles((current) => current.map((p) => (p.id === last.modpack.id ? last.modpack : p)));
    setUndoStack(rest);
  }, [undoStack]);

  const remove = useCallback(
    (id: string) => {
      setProfiles((current) => {
        const next = current.filter((p) => p.id !== id);
        if (id === activeId) setActiveId(next[0]?.id ?? null);
        return next;
      });
    },
    [activeId],
  );

  /**
   * The doctor analyses the modpack being edited, not the load order the game happens to
   * hold. Toggling a mod therefore updates the findings immediately, which is the whole
   * point of building a modpack in here rather than in the game's own mod screen.
   */
  const workingScan = useMemo<ScanResult | null>(() => {
    if (!scan) return null;
    if (!active) return scan;
    const position = new Map(active.activeOrder.map((id, i) => [id, i]));
    return {
      ...scan,
      activeOrder: active.activeOrder,
      mods: scan.mods.map((mod) => ({
        ...mod,
        active: position.has(mod.packageId),
        loadIndex: position.get(mod.packageId) ?? null,
      })),
    };
  }, [scan, active]);

  /**
   * What the patch probe last reported, if it has been asked.
   *
   * Kept apart from the static rules because it costs seconds and an external process, so
   * it is asked for rather than run on every scan. Cleared on a rescan: a report about
   * assemblies that may have changed is worse than no report.
   */
  const [probe, setProbe] = useState<ProbeReport | null>(null);

  const staticFindings = useMemo<Finding[]>(() => {
    if (!workingScan) return [];
    const rules = runStaticRules(workingScan, { oversizePx, workshop });
    return probe ? [...rules, ...findingsFromProbe(probe, workingScan.mods, workingScan.gameCycle)] : rules;
  }, [workingScan, oversizePx, workshop, probe]);

  // Reloads when the picker moves. Pasted text needs no shell call: it is already here.
  useEffect(() => {
    if (logSource === "pasted") {
      setSession(pasted.trim() ? { path: "pasted from RimWorld", text: pasted } : null);
      return;
    }
    // A fetched log arrives through the picker's own button, so switching to this source
    // clears what was there rather than reading a file over it.
    if (logSource === "link") {
      setSession(null);
      return;
    }
    if (!inShell()) return;
    let live = true;
    void readSessionLog(logSource === "previous")
      .then((log) => live && setSession(log))
      .catch(() => live && setSession(null));
    return () => {
      live = false;
    };
  }, [logSource, pasted]);

  const sessionAnalysis = useMemo<SessionAnalysis | null>(
    () => (session ? analyzeLog(session.text) : null),
    [session],
  );

  const sessionFindings = useMemo<Finding[]>(
    () => (sessionAnalysis && scan ? findingsFromLog(sessionAnalysis, scan.mods, scan.activeOrder) : []),
    [sessionAnalysis, scan],
  );

  // Computed once per scan rather than per render: the comparison advances a stored
  // snapshot, so running it is what consumes the previous state.
  const diff = useMemo(() => (scan ? installDiff(scan) : null), [scan]);

  const doctorFilter = useSeverityFilter(staticFindings);

  if (loading)
    return (
      <main>
        <Splash progress={scanProgress} note="Reading your install" />
      </main>
    );
  if (!scan || !workingScan) return <NoFixtures />;

  // The detail panel is opened from several tabs and stays open across a tab change, so the
  // mod it points at is resolved from the scan rather than passed around as an object.
  const selectedMod = openMod ? (scan.mods.find((m) => m.packageId === openMod) ?? null) : null;
  const allFindings = [...staticFindings, ...sessionFindings];

  const drift = active ? diffModpacks(scan.activeOrder, active.activeOrder) : null;
  const dirty = drift ? drift.added.length > 0 || drift.removed.length > 0 || drift.reordered : false;

  return (
    <RepairProvider
      value={{
        scan: workingScan,
        modpack: active ?? modpackFromScan(scan, "scratch"),
        workshop,
        applyModpack,
      }}
    >
      {devMode && (
        <div className="dev-strip" role="status">
          <b>Dev mode</b>
          <span>Diagnostics, self-checks and captured console are in Settings</span>
          <button className="dev-strip-off" type="button" onClick={() => setDevModePersisted(false)}>
            Turn off
          </button>
        </div>
      )}

      <header className="hdr">
        <Logo />
        {active && (
          <div className={`modpack-badge${dirty ? " dirty" : ""}`}>
            <small>Editing</small>
            <b>{active.name}</b>
            {dirty && <span className="dot" title="Differs from the game's current load order" />}
          </div>
        )}
        {active && (
          <GameControls
            scan={scan}
            modpack={active}
            onRescan={rescan}
            scanning={scanning}
            onPlayAndWatch={() => {
              // The watched run lives on the Session tab, so the menu takes you there and
              // starts it rather than starting something you cannot see.
              setTab("session");
              setWatchRequest((n) => n + 1);
            }}
          />
        )}
        <div className="facts">
          <Fact label="Game" value={scan.gameVersion} />
          <Fact label="Installed" value={String(scan.mods.length)} optional />
          <Fact label="In modpack" value={String(workingScan.activeOrder.length)} optional />
          <Fact
            label="Issues"
            value={String(staticFindings.length + sessionFindings.length)}
            alert={staticFindings.length + sessionFindings.length > 0}
          />
        </div>
      </header>

      <nav className="tabs" role="tablist">
        <TabButton id="home" tab={tab} setTab={setTab} label="Home" />
        <TabButton
          id="doctor"
          tab={tab}
          setTab={setTab}
          label="Doctor"
          count={staticFindings.length}
          tone={
            staticFindings.some((f) => f.severity === "critical" || f.severity === "error")
              ? "critical"
              : staticFindings.some((f) => f.severity === "warning")
                ? "warning"
                : undefined
          }
        />
        <TabButton
          id="session"
          tab={tab}
          setTab={setTab}
          label="Session"
          count={sessionFindings.length}
          tone={
            sessionFindings.some((f) => f.severity === "critical" || f.severity === "error")
              ? "critical"
              : sessionFindings.some((f) => f.severity === "warning")
                ? "warning"
                : "info"
          }
        />
        {/* Only counts that mean "something needs attention" are shown. Modpack, load order
            and library sizes are inventory, they are on Home and in the header already, and
            three extra pills were most of what pushed the tab bar off a narrow window. */}
        <TabButton id="saves" tab={tab} setTab={setTab} label="Saves" />
        <TabButton id="packs" tab={tab} setTab={setTab} label="Modpacks" />
        <TabButton id="order" tab={tab} setTab={setTab} label="Load order" />
        <TabButton id="library" tab={tab} setTab={setTab} label="Library" />
        <TabButton id="settings" tab={tab} setTab={setTab} label="Settings" />
      </nav>

      {scanning && (
        <div className="rescan-strip" role="status" aria-live="polite">
          <span className="rescan-spin" aria-hidden="true" />
          <span>
            Rescanning
            {scanProgress && scanProgress.total > 0 ? ` ${scanProgress.done} of ${scanProgress.total}` : ""}
          </span>
          <span className="muted rescan-label">{scanProgress?.label ?? ""}</span>
        </div>
      )}

      <main>
        {tab === "home" && diff && (
          <Home
            scan={workingScan}
            modpack={active}
            findings={staticFindings}
            sessionFindings={sessionFindings}
            diff={diff}
            onGo={setTab}
            onOpenMod={setOpenMod}
          />
        )}
        {tab === "doctor" && (
          <>
            <SeveritySummary
              findings={staticFindings}
              active={doctorFilter.active}
              onToggle={doctorFilter.toggle}
            />
            {active && workingScan && (
              <PatchProbe scan={workingScan} modpack={active} report={probe} onReport={setProbe} />
            )}
            {active && (
              <Triage
                // Both sets: the log's faults are the most severe the app finds, and a
                // "fix everything" button that quietly skipped every critical one was the
                // largest gap in it.
                findings={[...staticFindings, ...sessionFindings]}
                scan={workingScan}
                modpack={active}
                workshop={workshop}
                applyModpack={applyModpack}
                onApplied={() => void rescan()}
              />
            )}
            {undoStack.length > 0 && (
              <div className="toolbar">
                <button className="btn" type="button" onClick={undo}>
                  Undo {undoStack[0].label}
                </button>
              </div>
            )}
            <FindingList
              findings={doctorFilter.filtered}
              empty="No static problems found. This load order is structurally sound."
            />
            {/* After the findings, because it is what to reach for once they have run out. */}
            {active && <Bisect scan={workingScan} modpack={active} />}
          </>
        )}
        {tab === "session" && active && (
          <GameWatch scan={workingScan} modpack={active} startSignal={watchRequest} />
        )}
        {tab === "session" && (
          <>
            <LogSourcePicker
              value={logSource}
              onChange={setLogSource}
              pasted={pasted}
              onPasted={setPasted}
              onFetched={setSession}
            />
            {sessionAnalysis ? (
              <SessionReport
                analysis={sessionAnalysis}
                findings={sessionFindings}
                source={session?.path ?? "unknown"}
              />
            ) : (
              <p className="muted">
                {logSource === "previous"
                  ? "No previous run. RimWorld keeps one only once the game has been launched twice."
                  : logSource === "pasted"
                    ? "Nothing pasted yet."
                    : logSource === "link"
                      ? "Paste a gist link and press Fetch."
                      : "No session log loaded."}
              </p>
            )}
          </>
        )}
        {tab === "saves" &&
          (active ? (
            <Saves scan={workingScan} modpack={active} />
          ) : (
            <p className="muted">Create a modpack first.</p>
          ))}
        {tab === "packs" && (
          <Modpacks
            modpacks={modpacks}
            activeId={activeId}
            scan={scan}
            mods={scan.mods}
            onSelect={(id) => {
              setActiveId(id);
              setTab("order");
            }}
            onCreate={create}
            onUpdate={upsert}
            onRestore={(modpack) => applyModpack(modpack, "restore original")}
            onDelete={remove}
          />
        )}
        {tab === "packs" && active && <Vault scan={workingScan} modpack={active} onChange={upsert} />}
        {tab === "library" && <Library scan={scan} workshop={workshop} onOpenMod={setOpenMod} />}
        {tab === "settings" && (
          <Settings
            scan={workingScan}
            workshop={workshop}
            modpacks={modpacks}
            session={session}
            devMode={devMode}
            onDevMode={setDevModePersisted}
            oversizePx={oversizePx}
            onOversizePx={(px) => {
              setOversizePx(px);
              saveOversizePx(px);
            }}
          />
        )}
        {tab === "order" &&
          (active ? (
            <PackEditor modpack={active} mods={scan.mods} onChange={upsert} onOpenMod={setOpenMod} />
          ) : (
            <p className="muted">Create a modpack first.</p>
          ))}
      </main>

      {selectedMod && (
        <ModDetail
          mod={selectedMod}
          scan={workingScan}
          workshop={workshop}
          findings={allFindings}
          onOpen={setOpenMod}
          onClose={() => setOpenMod(null)}
        />
      )}
    </RepairProvider>
  );
}

/**
 * One number in the header.
 *
 * `optional` marks a fact that is inventory rather than a signal, and is dropped when the
 * header is short of room. The game version and the issue count are worth a row of their
 * own on any window; how many mods are installed is not.
 */
function Fact({
  label,
  value,
  alert,
  optional,
}: {
  label: string;
  value: string;
  alert?: boolean;
  optional?: boolean;
}) {
  return (
    <div className={`fact${alert ? " alert" : ""}${optional ? " optional" : ""}`}>
      <b>{value}</b>
      <small>{label}</small>
    </div>
  );
}

/**
 * One tab: an icon, its name, and a count when the count means something.
 *
 * The name is dropped when the strip runs out of room, leaving the icon. Eight labels do not
 * fit a narrow window, and a label sliced to "Setti" is worse than no label at all. The full
 * name stays in the title and the accessible name either way, so nothing is lost to anything
 * but the eye.
 */
function TabButton({
  id,
  tab,
  setTab,
  label,
  count,
  tone,
}: {
  id: Tab;
  tab: Tab;
  setTab: (t: Tab) => void;
  label: string;
  count?: number;
  /**
   * What the count means, which decides its colour.
   *
   * A count is only on a tab because something in there wants looking at, so it is coloured
   * by how much: red for anything blocking, amber for a warning, blue for a fact. A number
   * that is the same colour whatever it says is just a number.
   */
  tone?: "critical" | "warning" | "info";
}) {
  return (
    <button
      className="tab"
      role="tab"
      aria-selected={tab === id}
      aria-label={label}
      title={label}
      onClick={() => setTab(id)}
    >
      <TabIcon name={id} />
      <span className="tab-label">{label}</span>
      {count !== undefined && <span className={`pill${tone ? ` pill-${tone}` : ""}`}>{count}</span>}
    </button>
  );
}

function NoFixtures() {
  return (
    <main>
      <div className="empty">
        <h2>No install scanned yet</h2>
        <p>
          The dev UI reads fixtures produced from a real RimWorld install. Generate them, then this page
          reloads with your own mod list.
        </p>
        <code>pnpm scan</code>
      </div>
    </main>
  );
}

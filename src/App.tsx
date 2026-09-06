import { useCallback, useEffect, useMemo, useState } from "react";
import type { Finding, ScanResult, WorkshopCache } from "./lib/types";
import { runStaticRules } from "./lib/analysis/rules";
import { analyzeLog, findingsFromLog, type SessionAnalysis } from "./lib/analysis/logParser";
import { loadScan, loadSession, loadWorkshop } from "./lib/devData";
import {
  diffProfiles,
  loadProfiles,
  profileFromScan,
  saveBaselineOnce,
  saveProfiles,
  setupName,
  type Profile,
} from "./lib/profiles";
import { FindingList, SeveritySummary, useSeverityFilter } from "./components/Findings";
import { PackEditor } from "./components/PackEditor";
import { Packs } from "./components/Packs";
import { SessionReport } from "./components/SessionReport";
import { RepairProvider } from "./components/Repair";
import { Triage } from "./components/Triage";
import { Library } from "./components/Library";
import { Settings, loadDevMode } from "./components/Settings";

type Tab = "doctor" | "session" | "packs" | "order" | "library" | "settings";

export default function App() {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [session, setSession] = useState<{ path: string; text: string } | null>(null);
  const [workshop, setWorkshop] = useState<WorkshopCache | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("doctor");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [devMode, setDevMode] = useState(loadDevMode);

  const setDevModePersisted = useCallback((on: boolean) => {
    setDevMode(on);
    try {
      localStorage.setItem("rimdoc.devMode", on ? "1" : "0");
    } catch {
      /* private window; the toggle still works for this session */
    }
  }, []);
  // Every repair pushes the pack it replaced, so any applied fix is one click from undone.
  const [undoStack, setUndoStack] = useState<{ profile: Profile; label: string }[]>([]);

  useEffect(() => {
    Promise.all([loadScan(), loadSession(), loadWorkshop()])
      .then(([s, l, w]) => {
        setScan(s);
        setSession(l);
        setWorkshop(w);
        if (!s) return;
        const stored = loadProfiles();
        // One pack to work in. The order the install started with is recorded separately
        // as a baseline, because a second identical pack is noise until something
        // diverges, and there is nothing to restore to before then.
        const seeded = stored.length
          ? // Packs saved before the name depended on the install keep working; only
            // the placeholder name is brought up to date.
            stored.map((p) => (p.name === "Current game setup" ? { ...p, name: setupName(s) } : p))
          : [profileFromScan(s, setupName(s))];
        // Recorded on the very first scan and never overwritten, so there is always a
        // record of the order the install started with.
        saveBaselineOnce(s);
        setProfiles(seeded);
        setActiveId(seeded[0].id);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (profiles.length) saveProfiles(profiles);
  }, [profiles]);

  const active = profiles.find((p) => p.id === activeId) ?? null;

  const upsert = useCallback((profile: Profile) => {
    setProfiles((current) =>
      current.some((p) => p.id === profile.id)
        ? current.map((p) => (p.id === profile.id ? profile : p))
        : [...current, profile],
    );
  }, []);

  const create = useCallback((profile: Profile) => {
    setProfiles((current) => [...current, profile]);
    setActiveId(profile.id);
  }, []);

  /**
   * Commit a repaired pack, remembering the one it replaced.
   *
   * Both updates are issued side by side rather than nesting one inside the other's
   * updater. React re-invokes updaters (twice under StrictMode), so a setState hidden
   * in one pushed the same undo entry twice per repair.
   */
  const applyProfile = useCallback(
    (profile: Profile, label: string) => {
      const previous = profiles.find((p) => p.id === profile.id);
      if (previous) setUndoStack((stack) => [{ profile: previous, label }, ...stack].slice(0, 20));
      setProfiles((current) => current.map((p) => (p.id === profile.id ? profile : p)));
    },
    [profiles],
  );

  const undo = useCallback(() => {
    const [last, ...rest] = undoStack;
    if (!last) return;
    setProfiles((current) => current.map((p) => (p.id === last.profile.id ? last.profile : p)));
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
   * The doctor analyses the pack being edited, not the load order the game happens to
   * hold. Toggling a mod therefore updates the findings immediately, which is the whole
   * point of building a pack in here rather than in the game's own mod screen.
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

  const staticFindings = useMemo<Finding[]>(
    () => (workingScan ? runStaticRules(workingScan) : []),
    [workingScan],
  );

  const sessionAnalysis = useMemo<SessionAnalysis | null>(
    () => (session ? analyzeLog(session.text) : null),
    [session],
  );

  const sessionFindings = useMemo<Finding[]>(
    () => (sessionAnalysis && scan ? findingsFromLog(sessionAnalysis, scan.mods) : []),
    [sessionAnalysis, scan],
  );

  const doctorFilter = useSeverityFilter(staticFindings);

  if (loading) return <main />;
  if (!scan || !workingScan) return <NoFixtures />;

  const drift = active ? diffProfiles(scan.activeOrder, active.activeOrder) : null;
  const dirty = drift ? drift.added.length > 0 || drift.removed.length > 0 || drift.reordered : false;

  return (
    <RepairProvider
      value={{
        scan: workingScan,
        profile: active ?? profileFromScan(scan, "scratch"),
        workshop,
        applyProfile,
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
          <div className={`pack-badge${dirty ? " dirty" : ""}`}>
            <small>Editing</small>
            <b>{active.name}</b>
            {dirty && <span className="dot" title="Differs from the game's current load order" />}
          </div>
        )}
        <div className="facts">
          <Fact label="Game" value={scan.gameVersion} />
          <Fact label="Installed" value={String(scan.mods.length)} />
          <Fact label="In pack" value={String(workingScan.activeOrder.length)} />
          <Fact
            label="Issues"
            value={String(staticFindings.length + sessionFindings.length)}
            alert={staticFindings.length + sessionFindings.length > 0}
          />
        </div>
      </header>

      <nav className="tabs" role="tablist">
        <TabButton id="doctor" tab={tab} setTab={setTab} label="Doctor" count={staticFindings.length} />
        <TabButton id="session" tab={tab} setTab={setTab} label="Session" count={sessionFindings.length} />
        <TabButton id="packs" tab={tab} setTab={setTab} label="Packs" count={profiles.length} />
        <TabButton
          id="order"
          tab={tab}
          setTab={setTab}
          label="Load order"
          count={workingScan.activeOrder.length}
        />
        <TabButton id="library" tab={tab} setTab={setTab} label="Library" count={scan.mods.length} />
        <TabButton id="settings" tab={tab} setTab={setTab} label="Settings" />
      </nav>

      <main>
        {tab === "doctor" && (
          <>
            <SeveritySummary
              findings={staticFindings}
              active={doctorFilter.active}
              onToggle={doctorFilter.toggle}
            />
            {active && (
              <Triage
                findings={staticFindings}
                scan={workingScan}
                profile={active}
                workshop={workshop}
                applyProfile={applyProfile}
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
          </>
        )}
        {tab === "session" &&
          (sessionAnalysis ? (
            <SessionReport
              analysis={sessionAnalysis}
              findings={sessionFindings}
              source={session?.path ?? "unknown"}
            />
          ) : (
            <p className="muted">No session log loaded.</p>
          ))}
        {tab === "packs" && (
          <Packs
            profiles={profiles}
            activeId={activeId}
            scan={scan}
            mods={scan.mods}
            onSelect={(id) => {
              setActiveId(id);
              setTab("order");
            }}
            onCreate={create}
            onUpdate={upsert}
            onRestore={(profile) => applyProfile(profile, "restore original")}
            onDelete={remove}
          />
        )}
        {tab === "library" && <Library scan={scan} workshop={workshop} />}
        {tab === "settings" && (
          <Settings
            scan={workingScan}
            workshop={workshop}
            profiles={profiles}
            session={session}
            devMode={devMode}
            onDevMode={setDevModePersisted}
          />
        )}
        {tab === "order" &&
          (active ? (
            <PackEditor profile={active} mods={scan.mods} onChange={upsert} />
          ) : (
            <p className="muted">Create a pack first.</p>
          ))}
      </main>
    </RepairProvider>
  );
}

/** RD with a medical cross: the mark reads as a doctor, not a mod list. */
function Logo() {
  return (
    <div className="brand" aria-label="RimDoc+" title="RimDoc+">
      <span className="r">R</span>
      <span className="d">D</span>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="6.2" y="0.8" width="3.6" height="14.4" rx="1.1" fill="#e5484d" />
        <rect x="0.8" y="6.2" width="14.4" height="3.6" rx="1.1" fill="#e5484d" />
      </svg>
    </div>
  );
}

function Fact({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className={`fact${alert ? " alert" : ""}`}>
      <b>{value}</b>
      <small>{label}</small>
    </div>
  );
}

function TabButton({
  id,
  tab,
  setTab,
  label,
  count,
}: {
  id: Tab;
  tab: Tab;
  setTab: (t: Tab) => void;
  label: string;
  count?: number;
}) {
  return (
    <button className="tab" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
      {label}
      {count !== undefined && <span className="pill">{count}</span>}
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

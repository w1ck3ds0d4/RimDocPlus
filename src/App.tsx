import { useEffect, useMemo, useState } from "react";
import type { Finding, ScanResult } from "./lib/types";
import { runStaticRules } from "./lib/analysis/rules";
import { analyzeLog, findingsFromLog, type SessionAnalysis } from "./lib/analysis/logParser";
import { loadScan, loadSession } from "./lib/devData";
import { FindingList, SeveritySummary } from "./components/Findings";
import { ModTable } from "./components/ModTable";
import { SessionReport } from "./components/SessionReport";

type Tab = "doctor" | "session" | "mods";

export default function App() {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [session, setSession] = useState<{ path: string; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("doctor");

  useEffect(() => {
    Promise.all([loadScan(), loadSession()])
      .then(([s, l]) => {
        setScan(s);
        setSession(l);
      })
      .finally(() => setLoading(false));
  }, []);

  const staticFindings = useMemo<Finding[]>(() => (scan ? runStaticRules(scan) : []), [scan]);

  const sessionAnalysis = useMemo<SessionAnalysis | null>(
    () => (session ? analyzeLog(session.text) : null),
    [session],
  );

  const sessionFindings = useMemo<Finding[]>(
    () => (sessionAnalysis && scan ? findingsFromLog(sessionAnalysis, scan.mods) : []),
    [sessionAnalysis, scan],
  );

  if (loading) return <main />;
  if (!scan) return <NoFixtures />;

  const activeCount = scan.activeOrder.length;

  return (
    <>
      <header className="hdr">
        <div className="brand">
          Rim<span>Doc</span>
        </div>
        <div className="facts">
          <Fact label="Game" value={scan.gameVersion} />
          <Fact label="Cycle" value={scan.gameCycle} />
          <Fact label="Installed" value={String(scan.mods.length)} />
          <Fact label="Active" value={String(activeCount)} />
          <Fact label="Issues" value={String(staticFindings.length + sessionFindings.length)} />
        </div>
      </header>

      <nav className="tabs" role="tablist">
        <Tab id="doctor" tab={tab} setTab={setTab} label="Doctor" count={staticFindings.length} />
        <Tab id="session" tab={tab} setTab={setTab} label="Session" count={sessionFindings.length} />
        <Tab id="mods" tab={tab} setTab={setTab} label="Mods" count={scan.mods.length} />
      </nav>

      <main>
        {tab === "doctor" && (
          <>
            <SeveritySummary findings={staticFindings} />
            <FindingList
              findings={staticFindings}
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
            <p style={{ color: "var(--dim)" }}>No session log loaded.</p>
          ))}
        {tab === "mods" && <ModTable mods={scan.mods} />}
      </main>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <b>{value}</b>
      <small>{label}</small>
    </div>
  );
}

function Tab({
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
  count: number;
}) {
  return (
    <button className="tab" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
      {label}
      <span className="pill">{count}</span>
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

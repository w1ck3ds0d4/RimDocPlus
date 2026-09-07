import type { Finding, ScanResult } from "../lib/types";
import type { Modpack } from "../lib/modpacks";
import { clearHistory, loadHistory, type HistoryKind } from "../lib/history";
import type { InstallDiff, ModChange } from "../lib/installDiff";
import { useState } from "react";
import { RELEASES } from "../lib/releases";

export interface HomeProps {
  scan: ScanResult;
  modpack: Modpack | null;
  findings: Finding[];
  sessionFindings: Finding[];
  diff: InstallDiff;
  /** Jump to a tab, so a card can be the way in rather than only a number. */
  onGo: (tab: "doctor" | "session" | "order" | "library") => void;
  onOpenMod: (packageId: string) => void;
}

/**
 * The landing page: the state of the install, and what has been happening to it.
 *
 * The other tabs each answer one question in depth. This one exists to say whether anything
 * needs attention and what changed recently, which together are the two things worth knowing
 * before deciding whether to open the game or open the Doctor.
 */
export function Home({ scan, modpack, findings, sessionFindings, diff, onGo, onOpenMod }: HomeProps) {
  // Read on mount rather than held by App. Repairs and load order writes are journalled
  // from the components that perform them, so a copy passed down from above would be
  // whatever it was when the app started.
  const [history, setHistory] = useState(loadHistory);

  const counts = {
    critical: findings.filter((f) => f.severity === "critical").length,
    error: findings.filter((f) => f.severity === "error").length,
    warning: findings.filter((f) => f.severity === "warning").length,
  };
  const blocking = counts.critical + counts.error;
  const vram = scan.mods
    .filter((m) => scan.activeOrder.includes(m.packageId))
    .reduce((sum, m) => sum + (m.textures?.estimatedVramBytes ?? 0), 0);

  return (
    <div className="home">
      <section className={`verdict ${blocking > 0 ? "bad" : counts.warning > 0 ? "warn" : "good"}`}>
        <div>
          <h2>{headline(blocking, counts.warning)}</h2>
          <p>
            {scan.mods.length} mods installed, {scan.activeOrder.length} in{" "}
            {modpack?.name ?? "the load order"}, on RimWorld {scan.gameVersion}.
          </p>
        </div>
        <button className="btn primary" type="button" onClick={() => onGo("doctor")}>
          {blocking > 0 ? "Open the Doctor" : "Review findings"}
        </button>
      </section>

      {/* Each card is coloured by its own state rather than by what it counts, so a healthy
          install reads green at a glance and only a real number pulls the eye. */}
      <div className="home-cards">
        <Card
          label="Blocking"
          value={String(blocking)}
          note="Critical and error findings"
          tone={blocking > 0 ? "critical" : "ok"}
          onGo={() => onGo("doctor")}
        />
        <Card
          label="Warnings"
          value={String(counts.warning)}
          note="Worth a look, not urgent"
          tone={counts.warning > 0 ? "warning" : "ok"}
          onGo={() => onGo("doctor")}
        />
        <Card
          label="From the last session"
          value={String(sessionFindings.length)}
          note="Faults read out of Player.log"
          tone={sessionFindings.length > 0 ? "info" : "ok"}
          onGo={() => onGo("session")}
        />
        <Card
          label="Texture memory"
          value={formatBytes(vram)}
          note="Decoded cost of every active mod's textures"
          tone="accent"
          onGo={() => onGo("library")}
        />
      </div>

      <div className="home-columns">
        <section className="panel">
          <header className="panel-head">
            <h3>What RimDoc+ did</h3>
            {history.length > 0 && (
              <button className="btn small" type="button" onClick={() => setHistory(clearHistory())}>
                Clear
              </button>
            )}
          </header>
          {history.length === 0 ? (
            <p className="muted">
              Nothing yet. Repairs, load order writes and rollbacks are recorded here as they happen, so a
              change that breaks the game can be traced back to what caused it.
            </p>
          ) : (
            <ul className="feed">
              {history.slice(0, 12).map((entry) => (
                <li key={entry.id}>
                  <span className={`kind ${entry.kind}`}>{kindLabel(entry.kind)}</span>
                  <div>
                    <span>{entry.summary}</span>
                    {entry.detail && <p className="muted">{entry.detail}</p>}
                  </div>
                  <time dateTime={entry.at}>{ago(entry.at)}</time>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <header className="panel-head">
            <h3>What changed in your mods</h3>
            <span className="muted">{scanAge(scan.scannedAt)}</span>
          </header>
          <InstallChanges diff={diff} onOpenMod={onOpenMod} />
        </section>
      </div>

      <section className="panel">
        <header className="panel-head">
          <h3>What's new in RimDoc+</h3>
          <span className="muted">v{RELEASES[0]?.version}</span>
        </header>
        {RELEASES.map((release) => (
          <article key={release.version} className="release">
            <h4>
              {release.version} <time dateTime={release.date}>{release.date}</time>
            </h4>
            <ul>
              {release.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
            {release.known && release.known.length > 0 && (
              <>
                <p className="muted release-known">Not yet true of this build:</p>
                <ul className="muted">
                  {release.known.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            )}
          </article>
        ))}
      </section>
    </div>
  );
}

function InstallChanges({ diff, onOpenMod }: { diff: InstallDiff; onOpenMod: (id: string) => void }) {
  if (diff.baseline) {
    return (
      <p className="muted">
        This is the first scan, so there is nothing to compare against yet. Run <code>pnpm scan</code> again
        after Steam updates something and the difference will show up here.
      </p>
    );
  }

  const total = diff.added.length + diff.removed.length + diff.updated.length;
  if (total === 0) {
    return <p className="muted">Nothing added, removed or updated since the previous scan.</p>;
  }

  return (
    <>
      <ChangeGroup label="Added" mods={diff.added} onOpenMod={onOpenMod} />
      <ChangeGroup label="Updated" mods={diff.updated} onOpenMod={onOpenMod} />
      {/* Removed mods are gone from the scan, so there is nothing to open. */}
      <ChangeGroup label="Removed" mods={diff.removed} />
      <p className="note">
        Updates are detected from each mod folder's modification time, which is what Steam touches when it
        replaces a Workshop item. It catches changes you did not make, which are the ones worth knowing about.
      </p>
    </>
  );
}

function ChangeGroup({
  label,
  mods,
  onOpenMod,
}: {
  label: string;
  mods: ModChange[];
  onOpenMod?: (id: string) => void;
}) {
  if (mods.length === 0) return null;
  return (
    <div className="change-group">
      <h4>
        {label} <span className="count">{mods.length}</span>
      </h4>
      <div className="chips">
        {mods.slice(0, 20).map((mod) => (
          <button
            key={mod.packageId}
            type="button"
            className="relation"
            disabled={!onOpenMod}
            onClick={() => onOpenMod?.(mod.packageId)}
            title={mod.packageId}
          >
            {mod.name}
          </button>
        ))}
        {mods.length > 20 && <span className="muted">and {mods.length - 20} more</span>}
      </div>
    </div>
  );
}

type Tone = "critical" | "warning" | "info" | "ok" | "accent";

function Card({
  label,
  value,
  note,
  tone,
  onGo,
}: {
  label: string;
  value: string;
  note: string;
  tone: Tone;
  onGo: () => void;
}) {
  return (
    <button className={`home-card ${tone}`} type="button" onClick={onGo} title={note}>
      <span className="home-card-value">{value}</span>
      <span className="home-card-label">{label}</span>
    </button>
  );
}

function headline(blocking: number, warnings: number): string {
  if (blocking > 0) return `${blocking} thing${blocking === 1 ? "" : "s"} worth fixing before you play`;
  if (warnings > 0) return "Nothing blocking, a few things worth a look";
  return "This load order is structurally sound";
}

function kindLabel(kind: HistoryKind): string {
  const labels: Record<HistoryKind, string> = {
    modpack: "modpack",
    repair: "repair",
    order: "order",
    rollback: "undo",
    launch: "launch",
  };
  return labels[kind];
}

/**
 * Relative time, which is what a journal is read in.
 *
 * Falls back to the date past a week, because "23 days ago" stops being easier to place
 * than the date itself.
 */
function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  if (mins < 60 * 24 * 7) return `${Math.floor(mins / (60 * 24))}d ago`;
  return iso.slice(0, 10);
}

function scanAge(iso: string): string {
  const label = ago(iso);
  return label ? `scanned ${label}` : "";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

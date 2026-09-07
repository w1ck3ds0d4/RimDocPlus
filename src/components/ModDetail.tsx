import { useEffect, useState } from "react";
import type { Finding, ModEntry, ScanResult, WorkshopCache } from "../lib/types";
import { workshopUrl } from "../lib/library";
import { loadPreview } from "../lib/preview";
import { planRepair } from "../lib/repair/repairs";
import { inShell, isSteamRunning, runFileActions, targetsOf } from "../lib/shell";
import { record } from "../lib/history";
import { useConfirm } from "./Confirm";

export interface ModDetailProps {
  mod: ModEntry;
  scan: ScanResult;
  workshop: WorkshopCache | null;
  /** Every finding from the current analysis, filtered here to the ones naming this mod. */
  findings: Finding[];
  /** Follow a relationship to another mod, keeping the panel open. */
  onOpen: (packageId: string) => void;
  onClose: () => void;
}

/**
 * Everything known about one mod, in one place.
 *
 * The table views each answer a single question well and deliberately show one column's
 * worth of any given mod. This is where the rest of what the scan already read becomes
 * visible, so deciding whether to keep something does not mean cross-referencing four tabs.
 */
export function ModDetail({ mod, scan, workshop, findings, onOpen, onClose }: ModDetailProps) {
  const details = mod.steamId ? workshop?.items[mod.steamId] : undefined;
  const installed = new Map(scan.mods.map((m) => [m.packageId.toLowerCase(), m]));
  const active = new Set(scan.activeOrder.map((id) => id.toLowerCase()));
  const mine = findings.filter((f) => f.packageIds.some((id) => id.toLowerCase() === mod.packageId));

  const dependents = scan.mods.filter(
    (m) =>
      active.has(m.packageId.toLowerCase()) &&
      m.dependencies.some((d) => d.packageId.toLowerCase() === mod.packageId),
  );

  // Escape closes, matching every other dismissable surface in the app and costing nothing
  // to support. Bound on the document so it works wherever focus happens to be.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const order = scan.activeOrder.findIndex((id) => id.toLowerCase() === mod.packageId);
  const supportsCycle = mod.supportedVersions.includes(scan.gameCycle);

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label={mod.name} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div className="drawer-head-titles">
            <h2>{mod.name}</h2>
            <code className="pid">{mod.packageId}</code>
          </div>
          <button className="btn icon" type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="drawer-body">
          <Banner mod={mod} />

          <div className="chips">
            <span className={`tag ${mod.source}`}>{mod.source}</span>
            {order >= 0 ? (
              <span className="tag on">enabled, position {order}</span>
            ) : (
              <span className="tag off">disabled</span>
            )}
            {mod.hasAssemblies && <span className="tag">C#</span>}
            {mod.hasPatches && <span className="tag">xml patches</span>}
            {mod.author && <span className="muted">by {mod.author}</span>}
          </div>

          <div className="chips">
            {mod.supportedVersions.length === 0 && <span className="tag warn">declares no version</span>}
            {mod.supportedVersions.map((v) => (
              <span key={v} className={`tag${v === scan.gameCycle ? " on" : ""}`}>
                {v}
              </span>
            ))}
            {mod.supportedVersions.length > 0 && !supportsCycle && (
              <span className="tag warn">not {scan.gameCycle}</span>
            )}
          </div>

          {mine.length > 0 && (
            <section>
              <h3>What the Doctor says</h3>
              <ul className="detail-findings">
                {mine.map((f) => (
                  <li key={f.id}>
                    <span className={`dot ${f.severity}`} />
                    <span>{f.title}</span>
                    <code className="rule">{f.rule}</code>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {mod.description && (
            <section>
              <h3>Description</h3>
              <p className="description">{clean(mod.description)}</p>
            </section>
          )}

          <section>
            <h3>Cost</h3>
            <dl className="stats">
              <Stat label="Disk" value={formatBytes(mod.sizeBytes)} />
              <Stat
                label="Textures"
                value={mod.textures ? `${mod.textures.count.toLocaleString()}` : "not measured"}
              />
              <Stat
                label="Texture memory"
                value={mod.textures ? formatBytes(mod.textures.estimatedVramBytes) : "-"}
                note="Width x height x 4, the cost once decoded"
              />
              <Stat label="Patch operations" value={mod.patches ? String(mod.patches.length) : "0"} />
              <Stat
                label="Subscribers"
                value={details ? details.subscriptions.toLocaleString() : "no Workshop data"}
              />
              <Stat label="Folder changed" value={mod.updatedAt ? shortDate(mod.updatedAt) : "unknown"} />
            </dl>
          </section>

          <Relations
            title="Needs"
            ids={mod.dependencies.map((d) => d.packageId)}
            labels={Object.fromEntries(
              mod.dependencies.flatMap((d) => (d.displayName ? [[d.packageId, d.displayName]] : [])),
            )}
            installed={installed}
            active={active}
            onOpen={onOpen}
          />
          <Relations
            title="Depended on by"
            ids={dependents.map((m) => m.packageId)}
            installed={installed}
            active={active}
            onOpen={onOpen}
          />
          <Relations
            title="Incompatible with"
            ids={mod.incompatibleWith}
            installed={installed}
            active={active}
            onOpen={onOpen}
          />
          <Relations
            title="Loads after"
            ids={mod.loadAfter}
            installed={installed}
            active={active}
            onOpen={onOpen}
          />
          <Relations
            title="Loads before"
            ids={mod.loadBefore}
            installed={installed}
            active={active}
            onOpen={onOpen}
          />

          {mod.steamId && <RetryDownload mod={mod} scan={scan} />}

          <section>
            <h3>On disk</h3>
            <code className="path">{mod.folder}</code>
            {mod.steamId && (
              <p>
                <a href={workshopUrl(mod.steamId)} target="_blank" rel="noreferrer noopener">
                  Open on the Steam Workshop
                </a>
              </p>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}

/**
 * Ask Steam to fetch this Workshop item again.
 *
 * For a copy that arrived damaged rather than absent, where the Workshop page offers nothing
 * but unsubscribing and resubscribing by hand. Steam treats a present folder as proof of a
 * good copy, so both the folder and Steam's record of having downloaded it have to go; the
 * subscription stays, which is what makes this a re-fetch rather than an unsubscribe.
 */
function RetryDownload({ mod, scan }: { mod: ModEntry; scan: ScanResult }) {
  const [steamUp, setSteamUp] = useState<boolean | null>(null);
  const { confirm, dialog } = useConfirm();
  const shell = inShell();

  useEffect(() => {
    if (!shell) return;
    let live = true;
    void isSteamRunning().then((up) => live && setSteamUp(up));
    return () => {
      live = false;
    };
  }, [shell]);

  const plan = planRepair({
    scan,
    modpack: { id: "", name: "", createdAt: "", updatedAt: "", gameCycle: scan.gameCycle, activeOrder: [] },
    finding: {
      id: `retry:${mod.steamId}`,
      rule: "retry-workshop-download",
      severity: "info",
      title: `Re-download ${mod.name}`,
      detail: "",
      packageIds: [mod.packageId],
      fix: {
        kind: "retry-workshop-download",
        label: "Retry download",
        tier: 3,
        auto: false,
        params: { steamId: mod.steamId ?? "" },
      },
    },
  });

  if (!plan || plan.kind !== "files") return null;
  // Bound to a fresh const: a function declaration hoists, so the narrowing above has not
  // happened yet as far as the closure below is concerned.
  const filePlan = plan;

  const blocked = !shell ? "Needs the desktop app" : steamUp ? "Close Steam first" : null;

  async function retry() {
    const ok = await confirm({
      title: `Have Steam fetch ${mod.name} again?`,
      body: (
        <>
          <p>{filePlan.summary}</p>
          <p className="muted">
            Steam re-downloads on its next check, which usually means the next time you start it or launch the
            game. Nothing is lost either way: the current copy is backed up first.
          </p>
        </>
      ),
      confirmLabel: "Remove and re-fetch",
    });
    if (!ok) return;
    await runFileActions(filePlan.actions, null);
    record({
      kind: "repair",
      summary: `Asked Steam to re-download ${mod.name}`,
      detail: `Workshop item ${mod.steamId}`,
      targets: targetsOf(filePlan.actions),
    });
  }

  return (
    <section>
      {dialog}
      <h3>Download</h3>
      <div className="repair-actions">
        <button
          className="btn"
          type="button"
          disabled={!!blocked}
          title={blocked ?? filePlan.summary}
          onClick={() => void retry()}
        >
          Retry download
        </button>
        <span className="repair-note">
          {blocked === "Close Steam first"
            ? "Steam is open. It rewrites its download record when it closes, so the change would be undone."
            : "For a copy that downloaded damaged. Removes it and Steam's record of it, keeping the subscription."}
        </span>
      </div>
    </section>
  );
}

/**
 * The mod's own banner.
 *
 * Resolved asynchronously because the two builds fetch it by different routes, and the
 * frame keeps its height while that happens so opening the panel does not shift the
 * content underneath it.
 */
function Banner({ mod }: { mod: ModEntry }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setSrc(null);
    setFailed(false);
    loadPreview(mod.previewPath).then((resolved) => {
      if (live) setSrc(resolved);
    });
    return () => {
      live = false;
    };
  }, [mod.previewPath]);

  if (!mod.previewPath || failed) {
    return (
      <div className="banner empty">
        <span>{initials(mod.name)}</span>
      </div>
    );
  }

  return (
    <div className={`banner${src ? "" : " loading"}`}>
      {src && <img src={src} alt="" onError={() => setFailed(true)} />}
    </div>
  );
}

function Relations({
  title,
  ids,
  labels = {},
  installed,
  active,
  onOpen,
}: {
  title: string;
  ids: string[];
  labels?: Record<string, string>;
  installed: Map<string, ModEntry>;
  active: Set<string>;
  onOpen: (packageId: string) => void;
}) {
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (unique.length === 0) return null;

  return (
    <section>
      <h3>
        {title} <span className="count">{unique.length}</span>
      </h3>
      <div className="chips">
        {unique.map((id) => {
          const mod = installed.get(id);
          const state = !mod ? "missing" : active.has(id) ? "on" : "off";
          return (
            <button
              key={id}
              type="button"
              className={`relation ${state}`}
              disabled={!mod}
              title={mod ? id : `${id} is not installed`}
              onClick={() => mod && onOpen(id)}
            >
              {mod?.name ?? labels[id] ?? id}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat" title={note}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * RimWorld descriptions are rich text, not plain text.
 *
 * Authors write real markup in them and the game renders a subset. Stripping the tags is
 * closer to what the player sees on the Workshop page than printing them raw, and safer
 * than trying to render markup nobody validated.
 */
function clean(description: string): string {
  return description
    .replace(/\[\/?[a-z]+(=[^\]]*)?\]/gi, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 10);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

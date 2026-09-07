import { useMemo, useState } from "react";
import type { ScanResult, WorkshopCache } from "../lib/types";
import { buildLibrary, cleanupCandidates, sortLibrary, type LibrarySort } from "../lib/library";

const SORTS: { key: LibrarySort; label: string }[] = [
  { key: "order", label: "Load order" },
  { key: "dependents", label: "Depended on" },
  { key: "vram", label: "Texture cost" },
  { key: "subscribers", label: "Subscribers" },
  { key: "updated", label: "Least updated" },
  { key: "size", label: "Disk size" },
];

export function Library({
  scan,
  workshop,
  onOpenMod,
}: {
  scan: ScanResult;
  workshop: WorkshopCache | null;
  onOpenMod: (packageId: string) => void;
}) {
  const [sort, setSort] = useState<LibrarySort>("dependents");
  const [query, setQuery] = useState("");
  const [onlyCleanup, setOnlyCleanup] = useState(false);

  const rows = useMemo(() => buildLibrary(scan, workshop), [scan, workshop]);
  const candidates = useMemo(() => cleanupCandidates(rows), [rows]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const base = onlyCleanup ? candidates : rows;
    return sortLibrary(
      base.filter(
        (r) => !needle || r.mod.name.toLowerCase().includes(needle) || r.mod.packageId.includes(needle),
      ),
      sort,
    );
  }, [rows, candidates, query, sort, onlyCleanup]);

  if (!workshop) return <NoWorkshopData />;

  return (
    <>
      <div className="toolbar">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name or package id"
        />
        <button
          className={`btn${onlyCleanup ? " primary" : ""}`}
          type="button"
          onClick={() => setOnlyCleanup((v) => !v)}
          title="Enabled, nothing depends on them, and carrying real texture weight"
        >
          Cleanup candidates ({candidates.length})
        </button>
      </div>

      <div className="segmented sorts">
        {SORTS.map((s) => (
          <button key={s.key} type="button" aria-pressed={sort === s.key} onClick={() => setSort(s.key)}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <table className="lib-table">
          <thead>
            <tr>
              <th>Mod</th>
              <th style={{ width: 90 }}>Depended on</th>
              <th style={{ width: 100 }}>Subscribers</th>
              <th style={{ width: 92 }}>Updated</th>
              <th style={{ width: 92 }}>Textures</th>
              <th style={{ width: 78 }}>Disk</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr
                key={`${row.mod.packageId}:${row.mod.folder}`}
                className={`clickable${row.active ? "" : " row-off"}`}
                onClick={() => onOpenMod(row.mod.packageId)}
              >
                <td className="name" title="Open the mod's details">
                  <span className="link">{row.mod.name}</span>
                  {row.mod.source === "official" && <span className="tag official">core</span>}
                </td>
                <td className="num">{row.dependents > 0 ? row.dependents : ""}</td>
                <td className="num">{row.workshop ? compact(row.workshop.subscriptions) : ""}</td>
                <td className="num">{row.ageDays !== undefined ? `${row.ageDays}d` : ""}</td>
                <td className="num">{row.vramBytes ? formatBytes(row.vramBytes) : ""}</td>
                <td className="num">{formatBytes(row.mod.sizeBytes)}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td className="muted" colSpan={6} style={{ padding: "18px 12px" }}>
                  Nothing matches that filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="note">
        Depended on and texture cost are measured from your install. Subscribers and update age come from
        Steam's public Workshop data, refreshed with <code>pnpm workshop</code>. Neither half is a verdict: a
        niche mod you love beats a popular one you do not, and "nothing depends on it" is not the same as "you
        do not want it".
      </p>
    </>
  );
}

function NoWorkshopData() {
  return (
    <div className="empty">
      <h2>No Workshop data yet</h2>
      <p>
        RimDoc+ works entirely offline by default. Fetching subscriber counts and update dates is a separate
        opt-in step that sends only public Workshop file ids to Steam, with no account, key, or credential.
      </p>
      <code>pnpm workshop</code>
    </div>
  );
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

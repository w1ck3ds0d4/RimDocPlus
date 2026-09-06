import { useMemo, useState } from "react";
import type { ModEntry } from "../lib/types";

export function ModTable({ mods }: { mods: ModEntry[] }) {
  const [query, setQuery] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return mods
      .filter((m) => (activeOnly ? m.active : true))
      .filter((m) => !needle || m.name.toLowerCase().includes(needle) || m.packageId.includes(needle))
      .sort((a, b) => {
        // Active mods read best in load order; disabled ones have no index, so fall
        // back to name to keep the list stable.
        if (a.loadIndex !== null && b.loadIndex !== null) return a.loadIndex - b.loadIndex;
        if (a.loadIndex !== null) return -1;
        if (b.loadIndex !== null) return 1;
        return a.name.localeCompare(b.name);
      });
  }, [mods, query, activeOnly]);

  return (
    <>
      <div className="toolbar">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name or package id"
        />
        <button className="fix" type="button" onClick={() => setActiveOnly((v) => !v)}>
          {activeOnly ? `Active only (${rows.length})` : `All mods (${rows.length})`}
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th style={{ width: 48 }}>#</th>
            <th>Mod</th>
            <th style={{ width: 280 }}>Package id</th>
            <th style={{ width: 150 }}>Tags</th>
            <th style={{ width: 90 }}>Size</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((mod) => (
            <tr key={`${mod.packageId}:${mod.folder}`}>
              <td className="idx">{mod.loadIndex ?? "-"}</td>
              <td>{mod.name}</td>
              <td className="pid">{mod.packageId}</td>
              <td>
                {mod.source === "official" && <span className="tag official">core</span>}
                {mod.hasAssemblies && <span className="tag code">C#</span>}
                {mod.hasPatches && <span className="tag">xml</span>}
                {!mod.active && <span className="tag off">off</span>}
              </td>
              <td className="size">{formatSize(mod.sizeBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

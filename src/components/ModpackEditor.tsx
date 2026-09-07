import { useMemo, useState } from "react";
import type { ModEntry } from "../lib/types";
import type { Modpack } from "../lib/modpacks";
import { moveMod, setEnabled, sortLoadOrder, toggleMod } from "../lib/modpacks";

type Filter = "active" | "inactive" | "all";

export function PackEditor({
  modpack,
  mods,
  onChange,
  onOpenMod,
}: {
  modpack: Modpack;
  mods: ModEntry[];
  onChange: (next: Modpack) => void;
  onOpenMod: (packageId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("active");

  const position = useMemo(() => new Map(modpack.activeOrder.map((id, i) => [id, i])), [modpack.activeOrder]);

  /**
   * How many enabled mods declare each mod as a dependency. A high count means the list
   * is built on it, which is the difference between a mod you can drop and one that takes
   * fifty others down with it.
   */
  const dependents = useMemo(() => {
    const counts = new Map<string, number>();
    for (const mod of mods) {
      if (!position.has(mod.packageId)) continue;
      for (const dep of mod.dependencies) {
        const id = dep.packageId.toLowerCase();
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  }, [mods, position]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return mods
      .filter((m) => {
        const on = position.has(m.packageId);
        return filter === "all" || (filter === "active" ? on : !on);
      })
      .filter((m) => !needle || m.name.toLowerCase().includes(needle) || m.packageId.includes(needle))
      .sort((a, b) => {
        const ai = position.get(a.packageId);
        const bi = position.get(b.packageId);
        if (ai !== undefined && bi !== undefined) return ai - bi;
        if (ai !== undefined) return -1;
        if (bi !== undefined) return 1;
        return a.name.localeCompare(b.name);
      });
  }, [mods, query, filter, position]);

  const visibleIds = rows.map((m) => m.packageId);
  const allVisibleOn = visibleIds.length > 0 && visibleIds.every((id) => position.has(id));

  return (
    <>
      <div className="toolbar">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name or package id"
        />
        <div className="segmented">
          {(["active", "inactive", "all"] as Filter[]).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
        <button
          className="btn"
          type="button"
          onClick={() => onChange({ ...modpack, activeOrder: sortLoadOrder(modpack.activeOrder, mods) })}
          title="Bootstrappers first, then Ludeon content, then declared constraints"
        >
          Auto-sort
        </button>
        {visibleIds.length > 0 && (query || filter !== "active") && (
          <button
            className="btn"
            type="button"
            onClick={() => onChange(setEnabled(modpack, visibleIds, !allVisibleOn, mods))}
          >
            {allVisibleOn ? "Disable" : "Enable"} {visibleIds.length} shown
          </button>
        )}
      </div>

      <div className="table-wrap">
        <table className="mod-table">
          <thead>
            <tr>
              <th style={{ width: 40 }} />
              <th style={{ width: 48 }}>#</th>
              <th>Mod</th>
              <th style={{ width: 250 }}>Package id</th>
              <th style={{ width: 130 }}>Tags</th>
              <th style={{ width: 74 }}>Order</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((mod) => {
              const index = position.get(mod.packageId);
              const on = index !== undefined;
              return (
                <tr key={`${mod.packageId}:${mod.folder}`} className={on ? undefined : "row-off"}>
                  <td className="toggle-cell">
                    <button
                      className={`toggle${on ? " on" : ""}`}
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={`${on ? "Disable" : "Enable"} ${mod.name}`}
                      onClick={() => onChange(toggleMod(modpack, mod.packageId, mods))}
                    >
                      <i />
                    </button>
                  </td>
                  <td className="idx">{on ? index : "-"}</td>
                  <td className="name" title="Open the mod's details">
                    <button type="button" className="link" onClick={() => onOpenMod(mod.packageId)}>
                      {mod.name}
                    </button>
                    {mod.description && <span className="has-desc">?</span>}
                  </td>
                  <td className="pid">{mod.packageId}</td>
                  <td>
                    {mod.source === "official" && <span className="tag official">core</span>}
                    {mod.hasAssemblies && <span className="tag code">C#</span>}
                    {mod.hasPatches && <span className="tag">xml</span>}
                    {(dependents.get(mod.packageId) ?? 0) > 0 && (
                      <span
                        className="tag load-bearing"
                        title={`${dependents.get(mod.packageId)} enabled mods depend on this`}
                      >
                        &#8592;{dependents.get(mod.packageId)}
                      </span>
                    )}
                  </td>
                  <td>
                    {on && (
                      <span className="nudge">
                        <button
                          type="button"
                          aria-label={`Move ${mod.name} earlier`}
                          disabled={index === 0}
                          onClick={() => onChange(moveMod(modpack, mod.packageId, -1))}
                        >
                          &#9650;
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${mod.name} later`}
                          disabled={index === modpack.activeOrder.length - 1}
                          onClick={() => onChange(moveMod(modpack, mod.packageId, 1))}
                        >
                          &#9660;
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td className="muted" colSpan={6} style={{ padding: "18px 12px" }}>
                  Nothing matches that filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

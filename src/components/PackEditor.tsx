import { useMemo, useState } from "react";
import type { ModEntry } from "../lib/types";
import type { Profile } from "../lib/profiles";
import { moveMod, setEnabled, sortLoadOrder, toggleMod } from "../lib/profiles";

type Filter = "active" | "inactive" | "all";

export function PackEditor({
  profile,
  mods,
  onChange,
}: {
  profile: Profile;
  mods: ModEntry[];
  onChange: (next: Profile) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("active");

  const position = useMemo(() => new Map(profile.activeOrder.map((id, i) => [id, i])), [profile.activeOrder]);

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
          className="fix"
          type="button"
          onClick={() => onChange({ ...profile, activeOrder: sortLoadOrder(profile.activeOrder, mods) })}
          title="Bootstrappers first, then Ludeon content, then declared constraints"
        >
          Auto-sort
        </button>
        {visibleIds.length > 0 && (query || filter !== "active") && (
          <button
            className="fix"
            type="button"
            onClick={() => onChange(setEnabled(profile, visibleIds, !allVisibleOn, mods))}
          >
            {allVisibleOn ? "Disable" : "Enable"} {visibleIds.length} shown
          </button>
        )}
      </div>

      <table>
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
                <td>
                  <button
                    className={`toggle${on ? " on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={`${on ? "Disable" : "Enable"} ${mod.name}`}
                    onClick={() => onChange(toggleMod(profile, mod.packageId, mods))}
                  >
                    <i />
                  </button>
                </td>
                <td className="idx">{on ? index : "-"}</td>
                <td>{mod.name}</td>
                <td className="pid">{mod.packageId}</td>
                <td>
                  {mod.source === "official" && <span className="tag official">core</span>}
                  {mod.hasAssemblies && <span className="tag code">C#</span>}
                  {mod.hasPatches && <span className="tag">xml</span>}
                </td>
                <td>
                  {on && (
                    <span className="nudge">
                      <button
                        type="button"
                        aria-label={`Move ${mod.name} earlier`}
                        disabled={index === 0}
                        onClick={() => onChange(moveMod(profile, mod.packageId, -1))}
                      >
                        &#9650;
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${mod.name} later`}
                        disabled={index === profile.activeOrder.length - 1}
                        onClick={() => onChange(moveMod(profile, mod.packageId, 1))}
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
              <td colSpan={6} style={{ color: "var(--dim)", padding: "18px 12px" }}>
                Nothing matches that filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

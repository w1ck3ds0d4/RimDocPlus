import type { ModEntry, ScanResult } from "../lib/types";
import type { Profile } from "../lib/profiles";
import { diffProfiles, duplicateProfile, profileFromScan, toModsConfigXml } from "../lib/profiles";
import { download, slug } from "../lib/download";

export function Packs({
  profiles,
  activeId,
  scan,
  mods,
  onSelect,
  onCreate,
  onUpdate,
  onDelete,
}: {
  profiles: Profile[];
  activeId: string | null;
  scan: ScanResult;
  mods: ModEntry[];
  onSelect: (id: string) => void;
  onCreate: (profile: Profile) => void;
  onUpdate: (profile: Profile) => void;
  onDelete: (id: string) => void;
}) {
  const byId = new Map(mods.map((m) => [m.packageId, m]));

  return (
    <>
      <div className="toolbar">
        <button
          className="btn"
          type="button"
          onClick={() => onCreate(profileFromScan(scan, nextName(profiles, "New pack")))}
        >
          New pack from current game setup
        </button>
        <button
          className="btn"
          type="button"
          onClick={() =>
            onCreate({
              ...profileFromScan(scan, nextName(profiles, "Minimal")),
              // A vanilla-plus starting point: Ludeon content and the bootstrappers only.
              activeOrder: scan.activeOrder.filter(
                (id) =>
                  byId.get(id)?.source === "official" ||
                  id.startsWith("brrainz.") ||
                  id.startsWith("zetrith."),
              ),
            })
          }
        >
          New minimal pack
        </button>
      </div>

      {profiles.length === 0 && <p className="muted">No packs yet.</p>}

      {profiles.map((profile) => {
        const drift = diffProfiles(scan.activeOrder, profile.activeOrder);
        const clean = !drift.added.length && !drift.removed.length && !drift.reordered;
        return (
          <div key={profile.id} className={`pack${profile.id === activeId ? " current" : ""}`}>
            <div className="pack-head">
              <input
                className="pack-name"
                value={profile.name}
                aria-label="Pack name"
                onChange={(e) => onUpdate({ ...profile, name: e.target.value })}
              />
              <span className="pack-count">{profile.activeOrder.length} mods</span>
              {profile.id === activeId && <span className="tag official">editing</span>}
            </div>

            <p className="pack-drift">
              {clean ? (
                "Identical to what the game is set to run."
              ) : (
                <>
                  {drift.added.length > 0 && <b className="add">+{drift.added.length} </b>}
                  {drift.removed.length > 0 && <b className="rm">-{drift.removed.length} </b>}
                  {drift.reordered && <span>reordered </span>}
                  <span>vs the game's current load order</span>
                </>
              )}
            </p>

            <div className="pack-actions">
              <button className="btn" type="button" onClick={() => onSelect(profile.id)}>
                Edit
              </button>
              <button
                className="btn"
                type="button"
                onClick={() =>
                  onCreate(duplicateProfile(profile, nextName(profiles, `${profile.name} copy`)))
                }
              >
                Duplicate
              </button>
              <button
                className="btn"
                type="button"
                onClick={() =>
                  download(
                    `ModsConfig-${slug(profile.name)}.xml`,
                    toModsConfigXml(profile.activeOrder, scan.gameVersion),
                  )
                }
                title="The file RimWorld reads on launch"
              >
                Export ModsConfig.xml
              </button>
              <button
                className="btn"
                type="button"
                onClick={() =>
                  download(`${slug(profile.name)}.rimdoc.json`, JSON.stringify(profile, null, 2))
                }
              >
                Export pack
              </button>
              <button className="btn danger" type="button" onClick={() => onDelete(profile.id)}>
                Delete
              </button>
            </div>
          </div>
        );
      })}

      <p className="section-title">Applying a pack</p>
      <p className="note">
        Writing the load order straight into the game and launching it belongs to the Tauri shell, which is
        the next slice. Until then, exporting ModsConfig.xml over the file in your save-data Config folder
        does the same job by hand.
      </p>
    </>
  );
}

function nextName(profiles: Profile[], base: string): string {
  const taken = new Set(profiles.map((p) => p.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }
}

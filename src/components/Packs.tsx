import type { ModEntry, ScanResult } from "../lib/types";
import type { Baseline, Profile } from "../lib/profiles";
import {
  diffProfiles,
  duplicateProfile,
  loadBaseline,
  profileFromScan,
  toModsConfigXml,
} from "../lib/profiles";
import { download, slug } from "../lib/download";
import { useConfirm } from "./Confirm";

export function Packs({
  profiles,
  activeId,
  scan,
  mods,
  onSelect,
  onCreate,
  onUpdate,
  onRestore,
  onDelete,
}: {
  profiles: Profile[];
  activeId: string | null;
  scan: ScanResult;
  mods: ModEntry[];
  onSelect: (id: string) => void;
  onCreate: (profile: Profile) => void;
  onUpdate: (profile: Profile) => void;
  onRestore: (profile: Profile) => void;
  onDelete: (id: string) => void;
}) {
  const byId = new Map(mods.map((m) => [m.packageId, m]));
  const baseline = loadBaseline();
  const { confirm, dialog } = useConfirm();

  async function confirmDelete(profile: Profile) {
    const ok = await confirm({
      title: `Delete "${profile.name}"?`,
      body: (
        <>
          <p>
            This modpack holds {profile.activeOrder.length} mods in a particular order. Deleting it cannot be
            undone, and it is the only copy unless you exported one.
          </p>
          <p className="muted">Nothing on your install changes. Your mods stay exactly where they are.</p>
        </>
      ),
      confirmLabel: "Delete Modpack",
      destructive: true,
    });
    if (ok) onDelete(profile.id);
  }

  return (
    <>
      {dialog}
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

      {baseline && <RestoreOriginal baseline={baseline} profiles={profiles} onRestore={onRestore} />}

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
              <button className="btn danger" type="button" onClick={() => void confirmDelete(profile)}>
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

/**
 * Put a pack back to the order the install started with.
 *
 * Only shown once something has actually diverged: before that it would restore a pack
 * to what it already is, which is a button that does nothing dressed as a safety net.
 */
function RestoreOriginal({
  baseline,
  profiles,
  onRestore,
}: {
  baseline: Baseline;
  profiles: Profile[];
  onRestore: (profile: Profile) => void;
}) {
  const { confirm, dialog } = useConfirm();

  async function confirmRestore(profile: Profile) {
    const drift = diffProfiles(baseline.activeOrder, profile.activeOrder);
    const ok = await confirm({
      title: `Restore "${profile.name}" to the original order?`,
      body: (
        <>
          <p>
            This replaces the pack's current arrangement with the {baseline.activeOrder.length} mods recorded
            on {baseline.capturedAt.slice(0, 10)}.
          </p>
          <p>
            Discards: {drift.added.length} added, {drift.removed.length} removed
            {drift.reordered ? ", and the current ordering" : ""}.
          </p>
          <p className="muted">Undoable from the Doctor tab afterwards.</p>
        </>
      ),
      confirmLabel: "Restore",
    });
    if (ok) onRestore({ ...profile, activeOrder: [...baseline.activeOrder] });
  }
  const drifted = profiles.filter((p) => {
    const drift = diffProfiles(baseline.activeOrder, p.activeOrder);
    return drift.added.length > 0 || drift.removed.length > 0 || drift.reordered;
  });
  if (!drifted.length) return null;

  return (
    <div className="restore">
      {dialog}
      <div className="restore-text">
        <b>Original load order</b>
        <small>
          {baseline.activeOrder.length} mods, recorded {baseline.capturedAt.slice(0, 10)} on{" "}
          {baseline.gameVersion}
        </small>
      </div>
      {drifted.map((profile) => {
        const drift = diffProfiles(baseline.activeOrder, profile.activeOrder);
        return (
          <button
            key={profile.id}
            className="btn"
            type="button"
            title={`+${drift.added.length} -${drift.removed.length}${drift.reordered ? " reordered" : ""}`}
            onClick={() => void confirmRestore(profile)}
          >
            Restore {profile.name}
          </button>
        );
      })}
    </div>
  );
}

function nextName(profiles: Profile[], base: string): string {
  const taken = new Set(profiles.map((p) => p.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }
}

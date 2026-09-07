import type { ModEntry, ScanResult } from "../lib/types";
import type { Baseline, Modpack } from "../lib/modpacks";
import {
  diffModpacks,
  duplicateModpack,
  loadBaseline,
  modpackFromScan,
  toModsConfigXml,
} from "../lib/modpacks";
import { download, slug } from "../lib/download";
import { useConfirm, usePrompt } from "./Confirm";

export function Modpacks({
  modpacks,
  activeId,
  scan,
  mods,
  onSelect,
  onCreate,
  onUpdate,
  onRestore,
  onDelete,
}: {
  modpacks: Modpack[];
  activeId: string | null;
  scan: ScanResult;
  mods: ModEntry[];
  onSelect: (id: string) => void;
  onCreate: (modpack: Modpack) => void;
  onUpdate: (modpack: Modpack) => void;
  onRestore: (modpack: Modpack) => void;
  onDelete: (id: string) => void;
}) {
  const byId = new Map(mods.map((m) => [m.packageId, m]));
  const baseline = loadBaseline();
  const { confirm, dialog } = useConfirm();
  const { prompt, dialog: promptDialog } = usePrompt();

  async function confirmRename(modpack: Modpack) {
    const name = await prompt({
      title: "Rename modpack",
      label: "Name",
      initial: modpack.name,
      confirmLabel: "Rename",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return "A modpack needs a name.";
        if (trimmed.length > 60) return "Keep it under 60 characters.";
        // Two modpacks with one name is legal but makes the list unreadable.
        const clash = modpacks.some((p) => p.id !== modpack.id && p.name.trim() === trimmed);
        return clash ? "Another modpack already has that name." : null;
      },
    });
    if (name && name !== modpack.name) onUpdate({ ...modpack, name });
  }

  async function confirmDelete(modpack: Modpack) {
    const ok = await confirm({
      title: `Delete "${modpack.name}"?`,
      body: (
        <>
          <p>
            This modpack holds {modpack.activeOrder.length} mods in a particular order. Deleting it cannot be
            undone, and it is the only copy unless you exported one.
          </p>
          <p className="muted">Nothing on your install changes. Your mods stay exactly where they are.</p>
        </>
      ),
      confirmLabel: "Delete Modpack",
      destructive: true,
    });
    if (ok) onDelete(modpack.id);
  }

  return (
    <>
      {dialog}
      {promptDialog}
      <div className="toolbar">
        <button
          className="btn"
          type="button"
          onClick={() => onCreate(modpackFromScan(scan, nextName(modpacks, "New modpack")))}
        >
          New modpack from current setup
        </button>
        <button
          className="btn"
          type="button"
          onClick={() =>
            onCreate({
              ...modpackFromScan(scan, nextName(modpacks, "Minimal")),
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
          New minimal modpack
        </button>
      </div>

      {baseline && <RestoreOriginal baseline={baseline} modpacks={modpacks} onRestore={onRestore} />}

      {modpacks.length === 0 && <p className="muted">No modpacks yet.</p>}

      {modpacks.map((modpack) => {
        const drift = diffModpacks(scan.activeOrder, modpack.activeOrder);
        const clean = !drift.added.length && !drift.removed.length && !drift.reordered;
        return (
          <div key={modpack.id} className={`modpack${modpack.id === activeId ? " current" : ""}`}>
            <div className="modpack-head">
              <h3 className="modpack-name">{modpack.name}</h3>
              <span className="modpack-count">{modpack.activeOrder.length} mods</span>
              {modpack.id === activeId && <span className="tag official">editing</span>}
            </div>

            <p className="modpack-drift">
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

            <div className="modpack-actions">
              <button className="btn" type="button" onClick={() => onSelect(modpack.id)}>
                Edit
              </button>
              <button className="btn" type="button" onClick={() => void confirmRename(modpack)}>
                Rename
              </button>
              <button
                className="btn"
                type="button"
                onClick={() =>
                  onCreate(duplicateModpack(modpack, nextName(modpacks, `${modpack.name} copy`)))
                }
              >
                Duplicate
              </button>
              <button
                className="btn"
                type="button"
                onClick={() =>
                  download(
                    `ModsConfig-${slug(modpack.name)}.xml`,
                    toModsConfigXml(modpack.activeOrder, scan.gameVersion),
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
                  download(`${slug(modpack.name)}.rimdoc.json`, JSON.stringify(modpack, null, 2))
                }
              >
                Export modpack
              </button>
              <button className="btn danger" type="button" onClick={() => void confirmDelete(modpack)}>
                Delete
              </button>
            </div>
          </div>
        );
      })}

      <p className="section-title">Applying a modpack</p>
      <p className="note">
        <b>Apply to game</b> in the header writes this pack's load order into ModsConfig.xml, backing up what
        was there. Exporting the file is for sharing a pack or applying it somewhere else.
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
  modpacks,
  onRestore,
}: {
  baseline: Baseline;
  modpacks: Modpack[];
  onRestore: (modpack: Modpack) => void;
}) {
  const { confirm, dialog } = useConfirm();
  async function confirmRestore(modpack: Modpack) {
    const drift = diffModpacks(baseline.activeOrder, modpack.activeOrder);
    const ok = await confirm({
      title: `Restore "${modpack.name}" to the original order?`,
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
    if (ok) onRestore({ ...modpack, activeOrder: [...baseline.activeOrder] });
  }
  const drifted = modpacks.filter((p) => {
    const drift = diffModpacks(baseline.activeOrder, p.activeOrder);
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
      {drifted.map((modpack) => {
        const drift = diffModpacks(baseline.activeOrder, modpack.activeOrder);
        return (
          <button
            key={modpack.id}
            className="btn"
            type="button"
            title={`+${drift.added.length} -${drift.removed.length}${drift.reordered ? " reordered" : ""}`}
            onClick={() => void confirmRestore(modpack)}
          >
            Restore {modpack.name}
          </button>
        );
      })}
    </div>
  );
}

function nextName(modpacks: Modpack[], base: string): string {
  const taken = new Set(modpacks.map((p) => p.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }
}

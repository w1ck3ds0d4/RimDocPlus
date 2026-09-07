import { useEffect, useState } from "react";
import type { ScanResult } from "../lib/types";
import type { Modpack } from "../lib/modpacks";
import { compareSave, isRisky, type SaveComparison, type SaveMeta } from "../lib/saves";
import { inShell, listSaves } from "../lib/shell";

/**
 * What each colony was built with, against what the game would load today.
 *
 * A save records its own mod list, and opening it against a different one is a kind of
 * breakage nothing on disk shows: the install is fine, it simply is not the install this
 * colony was made on. RimWorld drops whatever content it cannot resolve, which is how a
 * colony opens with its buildings gone.
 */
export function Saves({ scan, modpack }: { scan: ScanResult; modpack: Modpack }) {
  const [saves, setSaves] = useState<SaveMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!inShell()) return;
    let live = true;
    listSaves().then(
      (found) => live && setSaves(found),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  if (!inShell()) {
    return (
      <p className="muted">
        Reading saves needs the desktop app. A save records the mods it was made with, and comparing that
        against the current load order is how you find out why a colony would open wrong.
      </p>
    );
  }

  if (error) return <p className="prompt-error">{error}</p>;
  if (!saves) return <p className="muted">Reading saves...</p>;
  if (!saves.length) {
    return <p className="muted">No saves yet. RimWorld writes them once a colony has been started.</p>;
  }

  const compared = saves.map((save) => compareSave(save, scan, modpack.activeOrder));
  const risky = compared.filter(isRisky).length;

  return (
    <>
      <p className="note">
        Each save carries its own list of the mods it was made with. Only mods the save expects and the load
        order lacks are a problem: the save still references their content, and RimWorld drops whatever it
        cannot resolve. Mods added since are ordinary and shown for completeness.
      </p>

      <div className="save-list">
        {compared.map((c) => (
          <SaveRow
            key={c.save.path}
            comparison={c}
            open={open === c.save.path}
            onToggle={() => setOpen(open === c.save.path ? null : c.save.path)}
          />
        ))}
      </div>

      <p className="note">
        {risky === 0
          ? `All ${compared.length} saves would open against the current load order.`
          : `${risky} of ${compared.length} saves expect mods the current load order does not have.`}
      </p>
    </>
  );
}

function SaveRow({
  comparison,
  open,
  onToggle,
}: {
  comparison: SaveComparison;
  open: boolean;
  onToggle: () => void;
}) {
  const { save, missing, added, reordered, gameVersionChanged } = comparison;
  const risky = isRisky(comparison);

  return (
    <details className={`save${risky ? " risky" : ""}`} open={open}>
      <summary onClick={(e) => (e.preventDefault(), onToggle())}>
        <i className="sev-dot" />
        <span className="save-name">{save.name}</span>
        <span className="save-summary">
          {risky
            ? `${missing.length} mod${missing.length === 1 ? "" : "s"} missing`
            : `${save.modIds.length} mods, all present`}
        </span>
        <span className="save-when">{save.savedAt?.slice(0, 10) ?? ""}</span>
      </summary>

      <div className="save-body">
        {gameVersionChanged && (
          <p className="warn-line">
            Saved on RimWorld {save.gameVersion}, which is a different cycle from the one installed.
          </p>
        )}

        {missing.length > 0 && (
          <div className="change-group">
            <h4>
              Expected, not loaded <span className="count">{missing.length}</span>
            </h4>
            <div className="chips">
              {missing.map((m) => (
                <span
                  key={m.packageId}
                  className={`relation ${m.installed ? "off" : "missing"}`}
                  title={
                    m.installed
                      ? `${m.packageId} is installed but disabled`
                      : `${m.packageId} is not installed`
                  }
                >
                  {m.name}
                </span>
              ))}
            </div>
            <p className="note">
              Those shown in red are not installed at all. The rest are installed but switched off, which is
              one click away in the load order.
            </p>
          </div>
        )}

        {added.length > 0 && (
          <div className="change-group">
            <h4>
              Added since <span className="count">{added.length}</span>
            </h4>
            <div className="chips">
              {added.slice(0, 20).map((m) => (
                <span key={m.packageId} className="relation" title={m.packageId}>
                  {m.name}
                </span>
              ))}
              {added.length > 20 && <span className="muted">and {added.length - 20} more</span>}
            </div>
          </div>
        )}

        <p className="muted">
          {save.modIds.length} mods when saved
          {reordered > 0 && `, ${reordered} of the shared ones in a different order`}. Order matters far less
          than presence, and RimWorld sorts it at load.
        </p>
      </div>
    </details>
  );
}

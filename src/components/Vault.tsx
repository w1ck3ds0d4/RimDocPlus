import { useEffect, useState } from "react";
import type { ScanResult } from "../lib/types";
import type { Modpack } from "../lib/modpacks";
import { checkPins, clearPins, pinTo, type PinReport } from "../lib/pins";
import { hashMod, inShell, vaultCapture, vaultList, vaultRestore, type VaultEntry } from "../lib/shell";
import { record } from "../lib/history";
import { useConfirm } from "./Confirm";

/**
 * Pinning a modpack to exact builds, and keeping copies of them.
 *
 * A modpack records which mods it uses, which makes it repeatable. It does not record which
 * builds, which is what would make it reproducible, and Steam overwrites a Workshop mod in
 * place. So a setup can stop working without anything about it appearing to change.
 *
 * The two halves need each other: a pin naming a build nobody kept describes something
 * already lost, and a vault full of builds nothing refers to is just disk.
 */
export function Vault({
  scan,
  modpack,
  onChange,
}: {
  scan: ScanResult;
  modpack: Modpack;
  onChange: (next: Modpack) => void;
}) {
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const { confirm, dialog } = useConfirm();
  const shell = inShell();

  useEffect(() => {
    if (!shell) return;
    let live = true;
    void vaultList().then((found) => live && setEntries(found));
    return () => {
      live = false;
    };
  }, [shell]);

  const inPack = scan.mods.filter((m) => modpack.activeOrder.includes(m.packageId));
  const report: PinReport = checkPins(modpack, scan.mods, hashes);
  const held = new Set(entries.map((e) => `${e.packageId}:${e.hash}`));

  /** Hash every mod in the modpack, reporting as it goes: this reads them all. */
  async function measure() {
    setBusy("measure");
    setProgress({ done: 0, total: inPack.length });
    const found: Record<string, string> = {};
    for (const [i, mod] of inPack.entries()) {
      try {
        found[mod.packageId] = await hashMod(mod.folder);
      } catch {
        // A mod that cannot be read is left unmeasured, which reads as unpinned rather
        // than as drift. Guessing here would report a change that may not exist.
      }
      setProgress({ done: i + 1, total: inPack.length });
    }
    setHashes(found);
    setProgress(null);
    setBusy(null);
    return found;
  }

  async function pin() {
    const measured = Object.keys(hashes).length ? hashes : await measure();
    onChange(pinTo(modpack, measured));
    record({
      kind: "modpack",
      summary: `Pinned ${modpack.name} to ${Object.keys(measured).length} exact builds`,
    });
  }

  /** Copy every build in the modpack into the vault, skipping what is already held. */
  async function vaultAll() {
    const ok = await confirm({
      title: `Keep a copy of all ${inPack.length} mods?`,
      body: (
        <>
          <p>
            Copies each mod as it stands into the vault, so a Steam update can be undone rather than only
            regretted.
          </p>
          <p className="muted">
            Builds already held are recognised by their hash and not copied again. Together these mods are{" "}
            {formatBytes(inPack.reduce((sum, m) => sum + m.sizeBytes, 0))}.
          </p>
        </>
      ),
      confirmLabel: "Copy them",
    });
    if (!ok) return;

    setBusy("vault");
    setProgress({ done: 0, total: inPack.length });
    let kept = 0;
    for (const [i, mod] of inPack.entries()) {
      try {
        await vaultCapture(mod.folder, mod.packageId, mod.name);
        kept++;
      } catch {
        /* one unreadable mod must not abandon the rest */
      }
      setProgress({ done: i + 1, total: inPack.length });
    }
    setEntries(await vaultList());
    setProgress(null);
    setBusy(null);
    record({ kind: "modpack", summary: `Vaulted ${kept} mod builds from ${modpack.name}` });
  }

  async function restore(check: (typeof report.checks)[number]) {
    const mod = scan.mods.find((m) => m.packageId === check.packageId);
    if (!mod || !check.pinned) return;
    const ok = await confirm({
      title: `Put ${check.name} back to the pinned build?`,
      body: (
        <p>
          Replaces the copy on disk with the one this modpack was pinned to. What is there now is backed up
          beside it first.
        </p>
      ),
      confirmLabel: "Restore that build",
    });
    if (!ok) return;
    await vaultRestore(check.packageId, check.pinned, mod.folder);
    record({ kind: "repair", summary: `Restored ${check.name} to its pinned build` });
    setHashes(await measure());
  }

  if (!shell) {
    return (
      <p className="muted">
        Pinning and the vault need the desktop app: both read every mod folder, and one copies them.
      </p>
    );
  }

  const drifted = report.checks.filter((c) => c.state === "drifted");
  const measured = Object.keys(hashes).length > 0;

  return (
    <section className="vault">
      {dialog}
      <header className="panel-head">
        <h3>Exact builds</h3>
        {entries.length > 0 && <span className="muted">{entries.length} in the vault</span>}
      </header>

      <p className="muted">
        A modpack records which mods it uses, not which builds of them, and Steam replaces a Workshop mod in
        place. Pinning records exactly what was there; the vault keeps a copy, so a pin refers to something
        that still exists.
      </p>

      <div className="repair-actions">
        <button className="btn" type="button" disabled={!!busy} onClick={() => void measure()}>
          {busy === "measure" ? "Reading..." : "Check against pins"}
        </button>
        <button className="btn primary" type="button" disabled={!!busy} onClick={() => void pin()}>
          Pin to what is installed
        </button>
        <button className="btn" type="button" disabled={!!busy} onClick={() => void vaultAll()}>
          {busy === "vault" ? "Copying..." : "Keep a copy of every mod"}
        </button>
        {modpack.pins && (
          <button
            className="btn"
            type="button"
            disabled={!!busy}
            onClick={() => onChange(clearPins(modpack))}
          >
            Drop pins
          </button>
        )}
      </div>

      {progress && (
        <div className="splash-bar" role="progressbar" aria-valuenow={progress.done}>
          <span
            className="splash-fill"
            style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
          />
        </div>
      )}

      {!modpack.pins && <p className="note">Not pinned. This modpack says which mods, not which builds.</p>}

      {modpack.pins && !measured && (
        <p className="note">
          Pinned to {Object.keys(modpack.pins).length} builds. Check against pins to see whether the install
          still matches.
        </p>
      )}

      {modpack.pins && measured && (
        <>
          <p className={drifted.length ? "warn-line" : ""}>
            {drifted.length === 0
              ? `Every pinned mod is the build this modpack was pinned to.`
              : `${drifted.length} mod${drifted.length === 1 ? " is" : "s are"} not the build this modpack was pinned to.`}
            {report.missing > 0 && ` ${report.missing} pinned mod is no longer installed.`}
          </p>

          {drifted.length > 0 && (
            <ul className="pin-list">
              {drifted.map((check) => (
                <li key={check.packageId}>
                  <span className="pin-name">{check.name}</span>
                  <code className="pin-hash">
                    {check.pinned?.slice(0, 8)} &rarr; {check.current?.slice(0, 8)}
                  </code>
                  <button
                    className="btn small"
                    type="button"
                    disabled={!!busy || !held.has(`${check.packageId}:${check.pinned}`)}
                    title={
                      held.has(`${check.packageId}:${check.pinned}`)
                        ? "Put the pinned build back"
                        : "That build is not in the vault, so there is nothing to put back"
                    }
                    onClick={() => void restore(check)}
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

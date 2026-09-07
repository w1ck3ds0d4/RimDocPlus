import { useState } from "react";
import type { ScanResult } from "../lib/types";
import { toModsConfigXml, type Modpack } from "../lib/modpacks";
import { configDir } from "../lib/repair/repairs";
import { applyModsConfig, inShell, launchGame } from "../lib/shell";
import { useConfirm } from "./Confirm";
import { record } from "../lib/history";

/**
 * Apply a modpack to the game, and start it.
 *
 * Both are shell-only: a browser can neither write ModsConfig.xml nor spawn a process.
 * They render disabled with the reason rather than being hidden, so the browser build
 * still shows what the desktop build adds.
 */
export function GameControls({
  scan,
  modpack,
  onRescan,
  scanning,
}: {
  scan: ScanResult;
  modpack: Modpack;
  /** Retake the scan, so the findings describe the install as it is now. */
  onRescan: () => void;
  scanning: boolean;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();
  const shell = inShell();
  const config = configDir(scan);

  async function apply() {
    const ok = await confirm({
      title: "Write this modpack into the game?",
      body: (
        <>
          <p>
            Replaces ModsConfig.xml with {modpack.activeOrder.length} entries in this modpack's order.
            RimWorld reads that file at launch.
          </p>
          <p className="muted">
            The current file is backed up beside itself first, and close RimWorld before applying or it will
            overwrite this on exit.
          </p>
        </>
      ),
      confirmLabel: "Write ModsConfig.xml",
    });
    if (!ok || !config) return;

    setBusy(true);
    try {
      await applyModsConfig(
        `${config}/ModsConfig.xml`,
        toModsConfigXml(modpack.activeOrder, scan.gameVersion),
      );
      setStatus(`Applied ${modpack.activeOrder.length} mods`);
      record({
        kind: "order",
        summary: `Wrote ${modpack.activeOrder.length} mods into ModsConfig.xml`,
        detail: `From the modpack "${modpack.name}"`,
        targets: [`${config}/ModsConfig.xml`],
      });
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function launch() {
    if (!scan.paths.game) return;
    setBusy(true);
    try {
      await launchGame(scan.paths.game);
      setStatus("RimWorld started");
      record({ kind: "launch", summary: "Started RimWorld", detail: scan.paths.game });
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="game-controls">
      {dialog}
      <button
        className="btn"
        type="button"
        disabled={!shell || busy || !config}
        title={shell ? "Write this modpack into ModsConfig.xml" : "Needs the desktop app"}
        onClick={() => void apply()}
      >
        Apply to game
      </button>
      <button
        className="btn"
        type="button"
        disabled={!shell || scanning}
        title={shell ? "Read the install again" : "Needs the desktop app"}
        onClick={onRescan}
      >
        {scanning ? "Scanning..." : "Rescan"}
      </button>
      <button
        className="btn play"
        type="button"
        disabled={!shell || busy || !scan.paths.game}
        title={shell ? "Start RimWorld" : "Needs the desktop app"}
        onClick={() => void launch()}
      >
        <span aria-hidden="true">&#9654;</span> Play
      </button>
      {status && <span className="game-status">{status}</span>}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { ScanResult } from "../lib/types";
import { diffModpacks, toModsConfigXml, type Modpack, type ModpackDiff } from "../lib/modpacks";
import { configDir } from "../lib/repair/repairs";
import { applyModsConfig, inShell } from "../lib/shell";
import { useConfirm } from "./Confirm";
import { record } from "../lib/history";

/** What is waiting to be written, in the order someone would ask about it. */
function describeDrift(drift: ModpackDiff): string {
  const parts = [
    drift.added.length && `${drift.added.length} to add`,
    drift.removed.length && `${drift.removed.length} to remove`,
    drift.moved && `${drift.moved} to move`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing";
}

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
  onPlay,
}: {
  scan: ScanResult;
  modpack: Modpack;
  /** Retake the scan, so the findings describe the install as it is now. */
  onRescan: () => void;
  scanning: boolean;
  /**
   * Start a run this app is watching.
   *
   * Both buttons do this. Plain Play used to spawn the game and stop caring, so a launch
   * that died ten seconds later left nothing behind: no exit code, no log, no measurement,
   * nothing to look at afterwards. The only difference now is whether the tab that shows
   * the run comes forward.
   */
  onPlay: (opts: { show: boolean }) => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLSpanElement>(null);

  /**
   * Close the menu on a click anywhere else, or on Escape.
   *
   * A menu that only closes by choosing from it sits over the page until something is
   * picked, and the one thing someone wants after opening it by accident is to put it away
   * without starting a game. Listens while it is open and not otherwise, so there is no
   * document-wide handler running for a menu nobody has opened.
   *
   * On pointerdown rather than click: the menu should be gone by the time whatever was
   * clicked underneath reacts.
   */
  useEffect(() => {
    if (!open) return;

    const away = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const { confirm, dialog } = useConfirm();
  const shell = inShell();
  const config = configDir(scan);

  // Against the scan rather than the baseline: the question is whether the game has this
  // order, and the scan is what the game has.
  const drift = diffModpacks(scan.activeOrder, modpack.activeOrder);
  const pending = drift.added.length + drift.removed.length + drift.moved;

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
      // The scan is what the count is measured against, so without this the button stays
      // green over a game that already has the order.
      onRescan();
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

  return (
    <div className="game-controls">
      {dialog}
      {/*
        Green with a count while the modpack and the game disagree, and refused when they
        do not. Everything in this app edits a working copy, so "is any of it in the game
        yet" is the question this button answers, and it was answering it with nothing:
        pressed on an unchanged order it rewrote the same file and reported success.
      */}
      <button
        className={pending > 0 ? "btn go" : "btn"}
        type="button"
        disabled={!shell || busy || !config || pending === 0}
        title={
          !shell
            ? "Needs the desktop app"
            : pending === 0
              ? "The game already has this load order"
              : `Write this modpack into ModsConfig.xml: ${describeDrift(drift)}`
        }
        onClick={() => void apply()}
      >
        Apply to game
        {pending > 0 && <span className="tier">{pending}</span>}
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
      <span className="split" ref={menu}>
        <button
          className="btn play"
          type="button"
          disabled={!shell || busy || !scan.paths.game}
          title={
            shell
              ? "Start RimWorld. The run is watched either way, so there is something to read if it dies."
              : "Needs the desktop app"
          }
          onClick={() => onPlay({ show: false })}
        >
          <span aria-hidden="true">&#9654;</span> Play
        </button>
        <button
          className="btn play split-caret"
          type="button"
          disabled={!shell || busy || !scan.paths.game}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="How to start the game"
          title="How to start the game"
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden="true">&#9662;</span>
        </button>
        {open && (
          <div className="split-menu" role="menu">
            <button
              className="split-item"
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPlay({ show: false });
              }}
            >
              <b>Play</b>
              {/*
                Both entries start a watched run. Saying this one "leaves it to you" was
                true until Play started watching too, and then it was the app describing
                behaviour it no longer had.
              */}
              <small>Starts the game and leaves you where you are.</small>
            </button>
            <button
              className="split-item"
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPlay({ show: true });
              }}
            >
              <b>Play and watch</b>
              <small>Opens the console with it, so the log is in front of you as it is written.</small>
            </button>
          </div>
        )}
      </span>
      {status && <span className="game-status">{status}</span>}
    </div>
  );
}

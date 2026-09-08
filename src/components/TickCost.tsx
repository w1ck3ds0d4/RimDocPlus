import { useEffect, useState } from "react";
import type { ScanResult } from "../lib/types";
import type { Modpack } from "../lib/modpacks";
import {
  parseTickReport,
  probeStatus,
  tickCaveat,
  tickCostRows,
  type TickReport,
} from "../lib/analysis/tickCost";
import { formatMs } from "../lib/format";
import {
  inShell,
  installProbeMod,
  probeModState,
  readProbeReport,
  removeProbeMod,
  type ProbeModState,
} from "../lib/shell";
import { record } from "../lib/history";
import { useConfirm } from "./Confirm";
import { ToggleMod } from "./ToggleMod";

/**
 * What each mod costs per tick, measured from inside the running game.
 *
 * The only part of RimDoc+ that needs code in the game's own process. Load time and memory
 * can be read from outside; simulation time cannot be attributed to a mod from out there at
 * all, which is why this exists and why it is opt in.
 */
export function TickCost({
  scan,
  modpack,
  onModpack,
}: {
  scan: ScanResult;
  modpack: Modpack | null;
  /** Adds the probe to the load order, which is the only thing that makes it run. */
  onModpack?: (next: Modpack, label: string) => void;
}) {
  const [state, setState] = useState<ProbeModState | null>(null);
  const [report, setReport] = useState<TickReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  const game = scan.paths.game ?? null;
  // In the load order is the only thing that makes it run: installed and inactive looks
  // identical to installed and working from here, and said nothing about the difference.
  const enabled = !!state && !!modpack && modpack.activeOrder.includes(state.packageId);

  async function refresh() {
    if (!inShell() || !game) return;
    try {
      setState(await probeModState(game));
      setReport(parseTickReport(await readProbeReport()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // Polled while installed, because the mod rewrites its report every five seconds and a
    // panel showing a frozen number is worse than one showing none. Stopped when the panel
    // goes away, so nothing reads a file for a tab nobody is looking at.
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game]);

  async function install() {
    if (!game) return;
    setBusy(true);
    setError(null);
    try {
      await installProbeMod(game);
      record({ kind: "modpack", summary: "Installed the RimDoc+ probe into the game" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!game) return;
    const ok = await confirm({
      title: "Take the probe out of the game?",
      body: (
        <p>
          Deletes it from your Mods folder. Your load order still names it until you apply a modpack again,
          and RimWorld will say it is missing until you do.
        </p>
      ),
      confirmLabel: "Remove it",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await removeProbeMod(game);
      record({ kind: "modpack", summary: "Removed the RimDoc+ probe from the game" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!inShell() || !game) return null;

  const rows = report ? tickCostRows(report) : [];
  const status = probeStatus({
    installed: state?.installed ?? false,
    current: state?.current ?? true,
    enabled,
    ticksPlayed: report?.ticksPlayed ?? null,
    patchedMethods: report?.patchedMethods ?? 0,
  });

  return (
    <section className="tick-cost">
      {dialog}
      {/*
        The lead sentence belongs to the heading, not beside it. A coverage line sat to the
        right of the title, ran off the panel, and repeated what the status line below already
        said. The full argument for why this exists at all is on hover.
      */}
      <header className="panel-head">
        <h3>What each mod costs per tick</h3>
      </header>

      {/*
        What the buttons are about. Moving the whole explanation into the heading's tooltip
        left three buttons saying "it" with nothing on screen naming what "it" was. The
        argument for why this is the only way stays on hover; the subject does not.
      */}
      <p
        className="muted"
        title="Load time and memory can be read from outside the process. Simulation time cannot be attributed to a mod from out there at all, which is why this is the one part of RimDoc+ that needs code running in the game."
      >
        Simulation time can only be measured from inside the game, so RimDoc+ installs a small mod there to do
        it. It times ticking and changes nothing else.
      </p>

      {/* One state, from one place. Never the load order's answer and the report's at once. */}
      <p className="probe-status" data-ready={rows.length > 0 ? "yes" : "no"}>
        {status}
      </p>

      <div className="repair-actions">
        {!state?.installed && (
          <button className="btn go" type="button" disabled={busy} onClick={() => void install()}>
            {busy ? "Installing..." : "Install it in the game"}
          </button>
        )}
        {state?.installed && !state.current && (
          <button
            className="btn go"
            type="button"
            disabled={busy}
            title="Overwrites the copy in your Mods folder with the one this build ships"
            onClick={() => void install()}
          >
            Update it in the game
          </button>
        )}
        {state?.installed && !enabled && onModpack && modpack && (
          <button
            className="btn go"
            type="button"
            title="Adds it to the end of your load order. Apply to game, in the header, writes that out."
            onClick={() => {
              onModpack({ ...modpack, activeOrder: [...modpack.activeOrder, state.packageId] }, "probe");
            }}
          >
            Add it to the load order
          </button>
        )}
        {/* Last, because it undoes the rest and should not sit between two things that do. */}
        {state?.installed && (
          <button
            className="btn danger"
            type="button"
            disabled={busy}
            title={`Deletes it from ${state.path}`}
            onClick={() => void remove()}
          >
            Delete it from the game
          </button>
        )}
        {error && <span className="prompt-error">{error}</span>}
      </div>

      {rows.length > 0 && (
        <table className="tick-table">
          <thead>
            <tr>
              <th>Mod</th>
              <th className="n">Total</th>
              <th className="n">Share</th>
              <th className="n">Per 1,000 calls</th>
              <th className="n">Calls</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 25).map((row) => (
              <tr key={row.packageId + row.assembly}>
                <td>
                  {row.mod}
                  <small className="muted"> {row.assembly}</small>
                </td>
                <td className="n">{formatMs(row.ms)}</td>
                <td className="n">{Math.round(row.share * 100)}%</td>
                <td className="n">{row.perThousand.toFixed(2)} ms</td>
                <td className="n">{row.calls.toLocaleString()}</td>
                {/*
                  The point of a row saying what a mod costs is deciding whether to keep it,
                  and that decision was three tabs away from the number behind it.
                */}
                <td className="n">
                  {(() => {
                    const entry = scan.mods.find(
                      (m) => m.packageId.toLowerCase() === row.packageId.toLowerCase(),
                    );
                    return entry ? <ToggleMod mod={entry} /> : null;
                  })()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {rows.length > 0 && <p className="note">{tickCaveat()}</p>}
    </section>
  );
}

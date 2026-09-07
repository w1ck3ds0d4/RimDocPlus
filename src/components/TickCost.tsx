import { useEffect, useState } from "react";
import type { ScanResult } from "../lib/types";
import type { Modpack } from "../lib/modpacks";
import { parseTickReport, tickCostRows, tickCoverage, type TickReport } from "../lib/analysis/tickCost";
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

  return (
    <section className="tick-cost">
      {dialog}
      <header className="panel-head">
        <h3>What each mod costs per tick</h3>
        {report && <span className="muted">{tickCoverage(report)}</span>}
      </header>

      <p className="muted">
        Everything else here is measured from outside the game, which is why load time and memory are known
        and simulation time is not. This installs a small mod that times the ticking from inside and writes
        what it saw. It measures and changes nothing else.
      </p>

      <div className="repair-actions">
        {!state?.installed && (
          <button className="btn go" type="button" disabled={busy} onClick={() => void install()}>
            {busy ? "Installing..." : "Install the probe"}
          </button>
        )}
        {state?.installed && !state.current && (
          <button className="btn go" type="button" disabled={busy} onClick={() => void install()}>
            Update it
          </button>
        )}
        {state?.installed && (
          <button className="btn danger" type="button" disabled={busy} onClick={() => void remove()}>
            Remove it
          </button>
        )}
        {state?.installed && !enabled && onModpack && modpack && (
          <button
            className="btn go"
            type="button"
            title="Adds it to the end of the load order. Apply to game in the header writes that out."
            onClick={() => {
              onModpack({ ...modpack, activeOrder: [...modpack.activeOrder, state.packageId] }, "probe");
            }}
          >
            Enable it
          </button>
        )}
        {state?.installed && (
          <span className="repair-note">
            {enabled
              ? "Enabled. Apply to game, then load a colony."
              : "Installed but not in the load order, so it does not run yet."}
          </span>
        )}
        {error && <span className="prompt-error">{error}</span>}
      </div>

      {report && rows.length === 0 && (
        <p className="note">
          The probe is running and has timed nothing yet. Nothing ticks at the main menu: load a colony and
          the numbers start.
        </p>
      )}

      {rows.length > 0 && (
        <table className="tick-table">
          <thead>
            <tr>
              <th>Mod</th>
              <th className="n">Total</th>
              <th className="n">Share</th>
              <th className="n">Per 1,000 calls</th>
              <th className="n">Calls</th>
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

import { useState } from "react";
import type { ScanResult } from "../lib/types";
import type { Modpack } from "../lib/modpacks";
import type { ProbeReport } from "../lib/analysis/harmony";
import { inShell, probePatches } from "../lib/shell";

/**
 * The Harmony check: does what each mod patches still exist?
 *
 * Behind a button rather than folded into the scan, because it runs an external program
 * over a thousand assemblies and takes a few seconds. A check that slow should be asked
 * for, and one that is asked for should say what it is going to do first.
 *
 * Only the mods in the modpack are read. Everything ever downloaded is not what loads.
 */
export function PatchProbe({
  scan,
  modpack,
  report,
  onReport,
}: {
  scan: ScanResult;
  modpack: Modpack;
  report: ProbeReport | null;
  onReport: (report: ProbeReport | null) => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = scan.mods.filter((mod) => modpack.activeOrder.includes(mod.packageId) && mod.hasAssemblies);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      onReport(await probePatches(active.map((mod) => mod.folder)));
    } catch (e) {
      onReport(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  if (active.length === 0) return null;

  const checked = report ? report.patches.filter((p) => p.verdict !== "runtime-only").length : 0;
  const broken = report ? report.patches.filter((p) => p.verdict === "missing-method").length : 0;

  return (
    <div className="setting setting-row">
      <span className="setting-text">
        <b>Check Harmony patches</b>
        <small>
          {report
            ? `Read ${report.assembliesRead} assemblies. ${checked} patches checked, ${broken} with nothing left to patch.`
            : `Reads the ${active.length} mods that ship code and checks each patch target still exists in ${scan.gameCycle}. A few seconds, and nothing in a mod runs.`}
        </small>
        {error && <span className="prompt-error">{error}</span>}
      </span>
      <button
        className="btn go"
        type="button"
        disabled={running || !inShell()}
        title={inShell() ? undefined : "Needs the desktop app"}
        onClick={() => void run()}
      >
        {running ? "Reading..." : report ? "Check again" : "Check"}
      </button>
    </div>
  );
}

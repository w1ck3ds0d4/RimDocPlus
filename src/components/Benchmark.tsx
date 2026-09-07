import { useState } from "react";
import { clearRuns, compareRuns, formatMeasure, type RunMeasurement } from "../lib/benchmark";

/**
 * Two runs of the game, side by side.
 *
 * Everything compared here is measured from outside the process: the startup phases the game
 * writes to its own log, wall clock, peak working set, and the faults the log analysis finds.
 *
 * There is no frame rate and no tick rate, on purpose. Attributing simulation time to a
 * particular mod means timing methods inside the running game, which needs code in the game,
 * and a number invented in its absence would read exactly like a measured one.
 */
export function Benchmark({ runs, onClear }: { runs: RunMeasurement[]; onClear: () => void }) {
  const [a, setA] = useState(1);
  const [b, setB] = useState(0);

  if (runs.length < 2) {
    return (
      <section className="benchmark">
        <header className="panel-head">
          <h3>Measured runs</h3>
        </header>
        <p className="muted">
          One run recorded. Run the game again, on a different modpack, and the two can be compared.
        </p>
        <RunRow run={runs[0]} />
      </section>
    );
  }

  const left = runs[Math.min(a, runs.length - 1)];
  const right = runs[Math.min(b, runs.length - 1)];
  const rows = compareRuns(left, right);

  return (
    <section className="benchmark">
      <header className="panel-head">
        <h3>Measured runs</h3>
        <button className="btn small" type="button" onClick={() => (clearRuns(), onClear())}>
          Clear
        </button>
      </header>

      <div className="bench-pick">
        <Picker label="Against" runs={runs} value={a} onChange={setA} />
        <Picker label="Compare" runs={runs} value={b} onChange={setB} />
      </div>

      <table className="bench-table">
        <thead>
          <tr>
            <th>Measure</th>
            <th>{left.modpack}</th>
            <th>{right.modpack}</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td className="num">{formatMeasure(row.a, row.format)}</td>
              <td className="num">{formatMeasure(row.b, row.format)}</td>
              <td className={`num ${row.deltaPct > 0 ? "worse" : row.deltaPct < 0 ? "better" : ""}`}>
                {row.deltaPct === 0 ? "same" : `${row.deltaPct > 0 ? "+" : ""}${row.deltaPct}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="note">
        Load time is the sum of the startup phases the game reports, so it measures what the game did rather
        than how long you waited. Nothing here is a frame rate: measuring what a mod costs per tick needs code
        running inside the game, and a number made up in its place would look exactly like a measured one.
      </p>
    </section>
  );
}

function Picker({
  label,
  runs,
  value,
  onChange,
}: {
  label: string;
  runs: RunMeasurement[];
  value: number;
  onChange: (i: number) => void;
}) {
  return (
    <label className="bench-picker">
      <small>{label}</small>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {runs.map((run, i) => (
          <option key={run.at} value={i}>
            {run.modpack} &middot; {run.mods} mods &middot; {run.at.slice(0, 16).replace("T", " ")}
          </option>
        ))}
      </select>
    </label>
  );
}

function RunRow({ run }: { run: RunMeasurement }) {
  return (
    <dl className="stats">
      <div className="stat">
        <dt>Load time</dt>
        <dd>{formatMeasure(run.loadMs, "ms")}</dd>
      </div>
      <div className="stat">
        <dt>Peak memory</dt>
        <dd>{formatMeasure(run.peakMemoryMb, "mb")}</dd>
      </div>
      <div className="stat">
        <dt>Faults</dt>
        <dd>{run.faults}</dd>
      </div>
      <div className="stat">
        <dt>Mods</dt>
        <dd>{run.mods}</dd>
      </div>
    </dl>
  );
}

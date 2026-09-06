import type { SessionAnalysis } from "../lib/analysis/logParser";
import type { Finding } from "../lib/types";
import { FindingList, SeveritySummary } from "./Findings";

export function SessionReport({
  analysis,
  findings,
  source,
}: {
  analysis: SessionAnalysis;
  findings: Finding[];
  source: string;
}) {
  const { environment: env, timings } = analysis;
  const slowest = timings[0]?.ms ?? 1;

  return (
    <>
      <div className="env">
        <Fact label="Game" value={env.gameVersion} />
        <Fact label="Unity" value={env.unityVersion} />
        <Fact label="GPU" value={env.renderer} />
        <Fact label="VRAM" value={env.vramMb ? `${(env.vramMb / 1024).toFixed(1)} GB` : undefined} />
        <Fact label="Driver" value={env.gpuDriver} />
        <Fact label="Log lines" value={analysis.totalLines.toLocaleString()} />
      </div>

      <SeveritySummary findings={findings} />
      <FindingList findings={findings} empty="Nothing worth reporting in this session." />

      {timings.length > 0 && (
        <>
          <p className="section-title">Startup cost</p>
          <div className="timings">
            {timings.map((t) => (
              <div className="timing" key={`${t.label}:${t.ms}`}>
                <span className="label" title={t.label}>
                  {t.label}
                </span>
                <span className="bar">
                  <i style={{ width: `${Math.max(2, (t.ms / slowest) * 100)}%` }} />
                </span>
                <span className="ms">
                  {t.ms >= 1000 ? `${(t.ms / 1000).toFixed(2)} s` : `${Math.round(t.ms)} ms`}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <p className="section-title">Source</p>
      <p className="source-path">{source}</p>
    </>
  );
}

function Fact({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div>
      <small>{label}</small>
      <b>{value}</b>
    </div>
  );
}

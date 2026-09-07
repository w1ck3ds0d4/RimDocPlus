import type { SessionAnalysis } from "../lib/analysis/logParser";
import type { Finding } from "../lib/types";
import { useState } from "react";
import { FindingList, SeveritySummary, useSeverityFilter } from "./Findings";
import { useRepairApi } from "./Repair";
import { buildReport, describeReport } from "../lib/shareLog";
import { download } from "../lib/download";

/**
 * The session, and a report of it written for someone else to read.
 *
 * Sharing a log usually means pasting tens of thousands of lines of Unity noise into a forum.
 * The parts that matter have already been found by the time anyone is looking at this tab,
 * so what leaves is the environment, the clustered faults with their attribution, and the
 * mod list, which is what anyone helping actually needs.
 */
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
  const filter = useSeverityFilter(findings);
  const slowest = timings[0]?.ms ?? 1;
  const api = useRepairApi();
  const [copied, setCopied] = useState(false);

  const report = api ? buildReport(analysis, findings, api.scan, source) : "";
  const size = describeReport(report);

  return (
    <>
      {report && (
        <div className="share">
          <div>
            <b>Share this session</b>
            <span className="muted">
              {size.lines} lines, {(size.bytes / 1024).toFixed(1)} KB: the environment, the faults with what
              they were blamed on, and the active mod list. Not the raw log, which is mostly Unity noise.
              Nothing leaves the machine on its own.
            </span>
          </div>
          <div className="repair-actions">
            <button
              className="btn"
              type="button"
              onClick={() =>
                navigator.clipboard?.writeText(report).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              {copied ? "Copied" : "Copy report"}
            </button>
            <button className="btn" type="button" onClick={() => download("rimdoc-session.txt", report)}>
              Save as file
            </button>
          </div>
        </div>
      )}

      <div className="env">
        <Fact label="Game" value={env.gameVersion} />
        <Fact label="Unity" value={env.unityVersion} />
        <Fact label="GPU" value={env.renderer} />
        <Fact label="VRAM" value={env.vramMb ? `${(env.vramMb / 1024).toFixed(1)} GB` : undefined} />
        <Fact label="Driver" value={env.gpuDriver} />
        <Fact label="Log lines" value={analysis.totalLines.toLocaleString()} />
      </div>

      <SeveritySummary findings={findings} active={filter.active} onToggle={filter.toggle} />
      <FindingList findings={filter.filtered} empty="Nothing worth reporting in this session." />

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

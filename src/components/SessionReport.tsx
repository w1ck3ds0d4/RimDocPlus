import type { SessionAnalysis } from "../lib/analysis/logParser";
import type { Finding } from "../lib/types";
import { useState } from "react";
import { FindingList, SeveritySummary, useSeverityFilter } from "./Findings";
import { useRepairApi } from "./Repair";
import { buildReport, describeReport } from "../lib/shareLog";
import { download } from "../lib/download";
import { formatMs } from "../lib/format";
import { fetchSharedLog, inShell } from "../lib/shell";

/**
 * The session, and a report of it written for someone else to read.
 *
 * Sharing a log usually means pasting tens of thousands of lines of Unity noise into a forum.
 * The parts that matter have already been found by the time anyone is looking at this tab,
 * so what leaves is the environment, the clustered faults with their attribution, and the
 * mod list, which is what anyone helping actually needs.
 */
export type LogSource = "current" | "previous" | "pasted" | "link";

const SOURCES: { value: LogSource; label: string; note: string }[] = [
  { value: "current", label: "This run", note: "Player.log, as it stands now" },
  {
    value: "previous",
    label: "Previous run",
    note: "Player-prev.log. After a crash this is the run that crashed",
  },
  { value: "pasted", label: "Pasted", note: "The log RimWorld's debug window copies out" },
  { value: "link", label: "From a link", note: "A gist link, which is what Share logs gives you" },
];

/**
 * Which log the Session tab reads.
 *
 * Three sources rather than one, because the live Player.log is often the wrong file.
 * RimWorld truncates it on launch and keeps what was there as Player-prev.log, so by the
 * time anyone opens this app after a crash the run they want to read has already been
 * moved aside. And the log RimWorld's own debug window copies out carries the mod list and
 * the Harmony patches that Player.log alone does not, which is worth being able to read
 * whether or not it was ever uploaded anywhere.
 *
 * Rendered beside the report rather than inside it, so a source with nothing to show still
 * offers the way back to one that has.
 */
export function LogSourcePicker({
  value,
  onChange,
  pasted,
  onPasted,
  onFetched,
}: {
  value: LogSource;
  onChange: (next: LogSource) => void;
  pasted: string;
  onPasted: (next: string) => void;
  onFetched: (log: { path: string; text: string } | null) => void;
}) {
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchIt() {
    setFetching(true);
    setError(null);
    try {
      onFetched(await fetchSharedLog(url));
    } catch (e) {
      onFetched(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  }

  return (
    <div className="log-source">
      <div className="log-source-tabs">
        {SOURCES.map((source) => (
          <button
            key={source.value}
            className={`btn small ${value === source.value ? "primary" : ""}`}
            type="button"
            title={source.note}
            onClick={() => onChange(source.value)}
          >
            {source.label}
          </button>
        ))}
        <span className="repair-note">{SOURCES.find((s) => s.value === value)?.note}</span>
      </div>
      {value === "pasted" && (
        <textarea
          className="log-paste"
          value={pasted}
          spellCheck={false}
          placeholder="Paste a RimWorld log here. In the game's debug window, Copy to clipboard puts the whole thing on your clipboard, mod list included."
          onChange={(e) => onPasted(e.target.value)}
        />
      )}
      {value === "link" && (
        <div className="log-link">
          <input
            className="log-link-url"
            type="url"
            value={url}
            spellCheck={false}
            placeholder="https://gist.github.com/..."
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && url.trim() && void fetchIt()}
          />
          <button
            className="btn primary"
            type="button"
            disabled={fetching || !url.trim() || !inShell()}
            title={inShell() ? undefined : "Needs the desktop app"}
            onClick={() => void fetchIt()}
          >
            {fetching ? "Fetching..." : "Fetch"}
          </button>
          <span className="repair-note">
            The only request RimDoc+ makes, and only when you press this. It fetches from gist.github.com and
            nowhere else.
          </span>
          {error && <span className="prompt-error">{error}</span>}
        </div>
      )}
    </div>
  );
}

export function SessionReport({
  analysis,
  findings,
  source,
  staticFindings,
}: {
  analysis: SessionAnalysis;
  findings: Finding[];
  source: string;
  /** What the scan found, so the report can carry the few of those a helper asks for. */
  staticFindings?: Finding[];
}) {
  const { environment: env, timings } = analysis;
  const filter = useSeverityFilter(findings);
  const slowest = timings[0]?.ms ?? 1;
  const api = useRepairApi();
  const [copied, setCopied] = useState(false);

  const report = api ? buildReport(analysis, findings, api.scan, source, staticFindings) : "";
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
                <span className="ms">{formatMs(t.ms)}</span>
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

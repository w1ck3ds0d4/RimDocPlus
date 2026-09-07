import { useEffect, useRef, useState } from "react";
import type { Finding, ScanResult } from "../lib/types";
import type { Modpack } from "../lib/modpacks";
import { configDir, toPowerShell, toRollbackPowerShell, type FileAction } from "../lib/repair/repairs";
import {
  allFileActions,
  resolveDecision,
  runTriage,
  triageSteps,
  type TriageResult,
  type TriageStep,
} from "../lib/repair/triage";
import type { WorkshopCache } from "../lib/types";
import { download } from "../lib/download";
import { inShell, rollback, runFileActions, targetsOf, watchRepair, type RunReport } from "../lib/shell";
import { RepairConsole, lineOf, type ConsoleLine } from "./RepairConsole";
import { record } from "../lib/history";

const AUTO_KEY = "rimdoc.triage.auto";

function loadAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Triage: assess everything, treat what can be treated safely, escalate the rest.
 *
 * With Auto off, anything ambiguous is put to the player as a modal question with the
 * app's preferred answer marked. With Auto on, the app answers those itself using the
 * same reasoning, and the console records what it decided and why.
 */
export function Triage({
  findings,
  scan,
  modpack,
  workshop,
  applyModpack,
  onApplied,
}: {
  findings: Finding[];
  scan: ScanResult;
  modpack: Modpack;
  workshop?: WorkshopCache | null;
  applyModpack: (modpack: Modpack, label: string) => void;
  /** Called once a run has changed files on disk, so the scan can be retaken. */
  onApplied?: () => void;
}) {
  const [result, setResult] = useState<TriageResult | null>(null);
  const [steps, setSteps] = useState<TriageStep[]>([]);
  const [auto, setAuto] = useState(loadAuto);
  const [queue, setQueue] = useState<TriageResult["decisions"]>([]);

  function setAutoMode(next: boolean) {
    setAuto(next);
    try {
      localStorage.setItem(AUTO_KEY, next ? "1" : "0");
    } catch {
      /* private window; the toggle still works for this session */
    }
  }

  function run() {
    const triage = runTriage(findings, { scan, modpack }, { auto, workshop });
    if (triage.applied.length) {
      applyModpack(
        triage.modpack,
        `triage (${triage.applied.length} fix${triage.applied.length === 1 ? "" : "es"})`,
      );
    }
    setSteps(triageSteps(triage, scan, modpack.name));
    setResult(triage);
    // With Auto off, anything ambiguous is asked rather than filed away in a report.
    setQueue(auto ? [] : triage.decisions);
  }

  /** Answer one decision, re-planned against the modpack as it stands right now. */
  function answer(finding: Finding, choiceIndex: number) {
    const resolved = resolveDecision(finding, choiceIndex, {
      scan,
      modpack: result?.modpack ?? modpack,
      workshop,
    });
    if (resolved?.plan.kind === "modpack") {
      applyModpack(resolved.plan.modpack, "decision");
      setResult((r) =>
        r
          ? {
              ...r,
              modpack: resolved.plan.kind === "modpack" ? resolved.plan.modpack : r.modpack,
              decisions: r.decisions.filter((d) => d.finding.id !== finding.id),
              applied: [...r.applied, { finding, summary: resolved.label }],
            }
          : r,
      );
    } else if (resolved?.plan.kind === "files") {
      const plan = resolved.plan;
      setResult((r) =>
        r
          ? {
              ...r,
              decisions: r.decisions.filter((d) => d.finding.id !== finding.id),
              files: [...r.files, { finding, actions: plan.actions, summary: plan.summary }],
            }
          : r,
      );
    }
    setQueue((q) => q.slice(1));
  }

  return (
    <>
      <div className="triage-bar">
        <label className={`auto-toggle${auto ? " on" : ""}`}>
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAutoMode(e.target.checked)}
            aria-label="Auto mode"
          />
          <span className="switch" aria-hidden="true">
            <i />
          </span>
          <span className="auto-text">
            <b>Auto</b>
          </span>
        </label>
        <button className={`triage-btn${findings.length === 0 ? " clean" : ""}`} type="button" onClick={run}>
          <span className="cross" aria-hidden="true">
            <svg width="30" height="30" viewBox="0 0 16 16" focusable="false">
              <rect x="6.1" y="0.6" width="3.8" height="14.8" rx="1.2" fill="#ffffff" />
              <rect x="0.6" y="6.1" width="14.8" height="3.8" rx="1.2" fill="#ffffff" />
            </svg>
          </span>
          <span className="triage-label">
            <b>{findings.length === 0 ? "Nothing to triage" : "Perform triage"}</b>
          </span>
          <span className="triage-count">{findings.length}</span>
        </button>
      </div>

      {queue.length > 0 && (
        <DecisionModal
          decision={queue[0]}
          remaining={queue.length}
          onChoose={(index) => answer(queue[0].finding, index)}
          onSkip={() => setQueue((q) => q.slice(1))}
        />
      )}
      {steps.length > 0 && <TriageConsole steps={steps} />}
      {result && (
        <TriageReport result={result} scan={scan} onApplied={onApplied} onDismiss={() => setResult(null)} />
      )}
    </>
  );
}

/**
 * The run, line by line.
 *
 * Lines are revealed on a stagger so the transcript can be read as it lands rather than
 * appearing whole. The work itself is already finished by then: this is a log of what
 * happened, not a progress bar pretending to measure something.
 */
function TriageConsole({ steps }: { steps: TriageStep[] }) {
  const [shown, setShown] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setShown(0);
    // Long transcripts speed up so a big staged list never outstays its welcome.
    const tick = steps.length > 24 ? 22 : 55;
    const timer = setInterval(() => {
      setShown((n) => {
        if (n >= steps.length) {
          clearInterval(timer);
          return n;
        }
        return n + 1;
      });
    }, tick);
    return () => clearInterval(timer);
  }, [steps]);

  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [shown]);

  const running = shown < steps.length;

  return (
    <div className="console">
      <div className="console-bar">
        <span className="dot r" />
        <span className="dot y" />
        <span className="dot g" />
        <span className="console-title">triage</span>
        {running && <span className="console-status">running</span>}
      </div>
      <div className="console-body" ref={bodyRef}>
        {steps.slice(0, shown).map((step, i) => (
          <div className={`line ${step.tone}`} key={i}>
            {step.tone === "cmd" ? (
              <>
                <span className="prompt">$</span>
                <span className="text">{step.text}</span>
              </>
            ) : (
              <>
                <span className="label">{step.label}</span>
                <span className="text">{step.text}</span>
              </>
            )}
          </div>
        ))}
        {running && <span className="caret-blink" aria-hidden="true" />}
      </div>
    </div>
  );
}

function TriageReport({
  result,
  scan,
  onApplied,
  onDismiss,
}: {
  result: TriageResult;
  scan: ScanResult;
  onApplied?: () => void;
  onDismiss: () => void;
}) {
  const actions = allFileActions(result);
  const resolved = result.before - result.after;
  // A report describes a plan until the plan runs, and a record of what happened after.
  const [applied, setApplied] = useState(false);

  return (
    <div className="triage-report">
      <div className="triage-head">
        <h2>{headline(result, resolved)}</h2>
        <button className="btn" type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>

      <Section
        title="Applied to the modpack"
        count={result.applied.length}
        tone="ok"
        empty="No automatic repairs were needed."
      >
        {result.applied.map(({ finding, summary }) => (
          <li key={finding.id}>
            <b>{finding.title}</b>
            <span>{summary}</span>
          </li>
        ))}
      </Section>

      <Section
        title="Decided automatically"
        count={result.autoDecided.length}
        tone="ok"
        empty="Nothing needed deciding."
      >
        {result.autoDecided.map((decision) => (
          <li key={decision.finding.id}>
            <b>{decision.choice}</b>
            <span>{decision.reasons.join(". ")}</span>
            {decision.caveats.length > 0 && (
              <span className="against">Against: {decision.caveats.join(". ")}</span>
            )}
          </li>
        ))}
      </Section>

      <Section
        title="Needs your decision"
        count={result.decisions.length}
        tone="warn"
        empty="Nothing ambiguous."
      >
        {result.decisions.map(({ finding, plan }) => (
          <li key={finding.id}>
            <b>{finding.title}</b>
            <span>{plan.choices.map((c) => c.label).join("  |  ")}</span>
          </li>
        ))}
      </Section>

      {/* What this section is called depends on who can carry it out, and on whether it
          already has. In the desktop app these run directly, and calling them "needs a
          script" while a button beside them had just applied all 730 was simply wrong. */}
      <Section
        title={applied ? "Applied to your files" : inShell() ? "Changes to your files" : "Needs a script"}
        count={actions.length}
        tone={applied ? "ok" : "warn"}
        empty="Nothing on disk to change."
      >
        {applied && (
          <li className="triage-applied">
            Carried out. The figures below are what the plan set out to do, not the state of the install now:
            rescan or reopen the Doctor for that.
          </li>
        )}
        {result.files.map(({ finding, actions: own, summary }) => (
          <li key={finding.id}>
            <b>
              {finding.title} <span className="muted">({own.length})</span>
            </b>
            <span>{summary}</span>
          </li>
        ))}
        {actions.length > 0 && (
          <li className="triage-cta">
            <ApplyActions
              actions={actions}
              config={configDir(scan)}
              onApplied={() => {
                setApplied(true);
                onApplied?.();
              }}
            />
            <button
              className="btn"
              type="button"
              onClick={() => download("rimdoc-triage.ps1", toPowerShell(actions, configDir(scan)))}
            >
              Download script
            </button>
            <button
              className="btn"
              type="button"
              title="Restores every file the repair script backed up"
              onClick={() => download("rimdoc-rollback.ps1", toRollbackPowerShell(actions))}
            >
              Download rollback
            </button>
            <span className="repair-note">
              {inShell()
                ? "Everything is copied to .rimdocbak first, and undoing restores the whole run. The script is there if you would rather read it before it runs."
                : "A browser cannot write to disk, so these wait for the script. It backs everything up first, and the rollback undoes the whole run."}
            </span>
          </li>
        )}
      </Section>

      <Section title="Needs you" count={result.external.length} tone="info" empty="Nothing outside the app.">
        {result.external.map(({ finding, summary, url }) => (
          <li key={finding.id}>
            <b>{finding.title}</b>
            <span>{summary}</span>
            {url && (
              <a href={url} target="_blank" rel="noreferrer noopener">
                Open
              </a>
            )}
          </li>
        ))}
      </Section>

      <Section
        title="No repair yet"
        count={result.unresolved.length}
        tone="dim"
        empty="Everything found has a repair."
      >
        {result.unresolved.map((finding) => (
          <li key={finding.id}>
            <b>{finding.title}</b>
            <span className="muted">{finding.rule}</span>
          </li>
        ))}
      </Section>

      <Section title="Informational" count={result.notes.length} tone="dim" empty="No notes.">
        {result.notes.slice(0, 10).map((note) => (
          <li key={note.id}>
            <b>{note.title}</b>
            <span className="muted">{note.rule}</span>
          </li>
        ))}
        {result.notes.length > 10 && (
          <li>
            <span className="muted">and {result.notes.length - 10} more</span>
          </li>
        )}
      </Section>

      <p className="triage-foot">
        Triage applies what is provably safe and stages what is not. It does not guarantee the game runs:
        problems that only appear once the game is executing need the supervised launch and the headless boot
        check, neither of which is built yet.
      </p>
    </div>
  );
}

/** Say what actually happened, rather than reporting only the modpack-level repairs. */
function headline(result: TriageResult, resolved: number): string {
  if (resolved > 0) return `${resolved} of ${result.before} issues resolved`;
  if (result.autoDecided.length > 0 || result.files.length > 0) {
    const staged = allFileActions(result).length;
    return `Decided and staged ${staged} action${staged === 1 ? "" : "s"}, nothing left to change here`;
  }
  if (result.before === 0) return "Nothing to triage";
  return "Nothing could be applied automatically";
}

/**
 * Run a plan, or explain why it cannot run here.
 *
 * In the shell this is the whole repair: apply, then undo, with the outcome reported
 * against what was actually written. In a browser the button says what is missing rather
 * than being hidden, because a disabled control with a reason is more use than an absence.
 */
/**
 * Run a repair plan, with the transcript on screen while it happens.
 *
 * Events arrive one per action and a texture pass is 730 of them, so they are buffered and
 * flushed on a timer. Setting state per event would re-render the list 730 times and make
 * the console the slowest part of the run it is reporting.
 */
function ApplyActions({
  actions,
  config,
  onApplied,
}: {
  actions: FileAction[];
  config: string | null;
  onApplied?: () => void;
}) {
  const [state, setState] = useState<"idle" | "running" | "done" | "undone">("idle");
  const [report, setReport] = useState<RunReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const pending = useRef<ConsoleLine[]>([]);
  const flusher = useRef<number | null>(null);

  const startFlushing = () => {
    if (flusher.current !== null) return;
    flusher.current = window.setInterval(() => {
      if (pending.current.length === 0) return;
      const batch = pending.current;
      pending.current = [];
      setLines((current) => [...current, ...batch]);
    }, 90);
  };

  const stopFlushing = () => {
    if (flusher.current !== null) {
      clearInterval(flusher.current);
      flusher.current = null;
    }
    if (pending.current.length > 0) {
      const batch = pending.current;
      pending.current = [];
      setLines((current) => [...current, ...batch]);
    }
  };

  useEffect(() => stopFlushing, []);

  const push = (line: ConsoleLine) => pending.current.push(line);

  async function run(kind: "apply" | "undo") {
    const applying = kind === "apply";
    setState("running");
    setError(null);
    setReport(null);
    setLines([
      {
        tone: "cmd",
        text: applying
          ? `rimdoc apply --actions ${actions.length}`
          : `rimdoc rollback --targets ${targetsOf(actions).length}`,
      },
    ]);
    setProgress({ done: 0, total: applying ? actions.length : targetsOf(actions).length });
    setConsoleOpen(true);
    startFlushing();

    const off = await watchRepair({
      onBackup: (dir) =>
        push({
          tone: "info",
          label: "backup",
          text: dir ? `saving original version of ${dir}` : "saving original version",
        }),
      onStart: (total) => {
        push({ tone: "info", label: "start", text: `${total} action${total === 1 ? "" : "s"} to carry out` });
        setProgress((p) => ({ ...p, total }));
      },
      onProgress: (p) => {
        push(lineOf(p));
        setProgress({ done: p.index, total: p.total });
      },
    });

    try {
      const result = applying ? await runFileActions(actions, config) : await rollback(targetsOf(actions));
      off();
      stopFlushing();
      setReport(result);
      setState(applying ? "done" : "undone");
      setLines((current) => [
        ...current,
        {
          tone: result.failed > 0 ? "warn" : "done",
          label: "done",
          text: `${result.applied} ${applying ? "applied" : "restored"}, ${result.skipped} skipped${
            result.failed > 0 ? `, ${result.failed} failed` : ""
          }`,
        },
      ]);
      record(
        applying
          ? {
              kind: "repair",
              summary: `Applied ${result.applied} file change${result.applied === 1 ? "" : "s"}`,
              detail: `${result.skipped} skipped${result.failed > 0 ? `, ${result.failed} failed` : ""}. Backups in ${result.backup_dir}.`,
              targets: targetsOf(actions),
            }
          : {
              kind: "rollback",
              summary: `Restored ${result.applied} file${result.applied === 1 ? "" : "s"}`,
              detail: result.skipped > 0 ? `${result.skipped} had no backup to restore` : undefined,
              targets: targetsOf(actions),
            },
      );
      // The install on disk is no longer what the app was told it was, so whoever owns the
      // scan is asked to take it again rather than the numbers quietly going stale.
      onApplied?.();
    } catch (e) {
      off();
      stopFlushing();
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      setState(applying ? "idle" : "done");
      setLines((current) => [...current, { tone: "warn", label: "error", text: message }]);
    }
  }

  if (!inShell()) {
    return (
      <button className="btn" type="button" disabled title="Needs the desktop app">
        Apply {actions.length} directly
      </button>
    );
  }

  return (
    <>
      {state !== "done" && state !== "undone" && (
        <button
          className="btn primary"
          type="button"
          disabled={state === "running"}
          onClick={() => void run("apply")}
        >
          {state === "running" ? "Applying..." : `Apply ${actions.length} directly`}
        </button>
      )}
      {(state === "done" || state === "undone") && (
        <button className="btn" type="button" onClick={() => void run("undo")} disabled={state === "undone"}>
          {state === "undone" ? "Undone" : "Undo this run"}
        </button>
      )}
      {report && !consoleOpen && (
        <button className="btn" type="button" onClick={() => setConsoleOpen(true)}>
          Show transcript
        </button>
      )}
      {report && (
        <span className="repair-note">
          {report.applied} applied, {report.skipped} skipped
          {report.failed > 0 ? `, ${report.failed} failed` : ""}. Backups in {report.backup_dir}.
        </span>
      )}
      {error && !consoleOpen && <span className="prompt-error">{error}</span>}
      {consoleOpen && (
        <RepairConsole
          lines={lines}
          done={progress.done}
          total={progress.total}
          report={report}
          error={error}
          onClose={() => setConsoleOpen(false)}
        />
      )}
    </>
  );
}

function Section({
  title,
  count,
  tone,
  empty,
  children,
}: {
  title: string;
  count: number;
  tone: string;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`triage-section ${tone}`}>
      <p className="triage-section-title">
        {title}
        <span className="n">{count}</span>
      </p>
      {count === 0 ? <p className="muted triage-empty">{empty}</p> : <ul>{children}</ul>}
    </div>
  );
}

/**
 * One decision, asked properly.
 *
 * The recommendation is marked rather than preselected, and the reasoning sits under it,
 * including whatever argues against it. A question that hides why it is being asked is
 * just a slower version of deciding for someone.
 */
function DecisionModal({
  decision,
  remaining,
  onChoose,
  onSkip,
}: {
  decision: TriageResult["decisions"][number];
  remaining: number;
  onChoose: (index: number) => void;
  onSkip: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSkip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSkip]);

  const recommended = decision.plan.choices.find((c) => c.recommended);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onSkip}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="decision-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="decision-title">{decision.finding.title}</h2>
          {remaining > 1 && <span className="modal-count">{remaining} to decide</span>}
        </div>

        <p className="modal-body">{decision.plan.summary}</p>

        <div className="modal-choices">
          {decision.plan.choices.map((choice, index) => (
            <button
              key={choice.label}
              className={`btn modal-choice${choice.recommended ? " primary" : ""}`}
              type="button"
              title={choice.detail}
              onClick={() => onChoose(index)}
            >
              <span>{choice.label}</span>
              {choice.recommended && <span className="pick">Recommended</span>}
            </button>
          ))}
        </div>

        {recommended?.rationale && (
          <div className="modal-why">
            {recommended.rationale.reasons.map((r) => (
              <p key={r} className="why-for">
                + {r}
              </p>
            ))}
            {recommended.rationale.caveats.map((c) => (
              <p key={c} className="why-against">
                - {c}
              </p>
            ))}
          </div>
        )}

        <div className="modal-foot">
          <button className="btn" type="button" onClick={onSkip}>
            Skip for now
          </button>
          <span className="repair-note">Escape also skips. Nothing is applied until you choose.</span>
        </div>
      </div>
    </div>
  );
}

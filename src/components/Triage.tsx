import { ApplyActions } from "./ApplyActions";
import { useEffect, useRef, useState } from "react";
import type { Finding, ScanResult } from "../lib/types";
import type { Modpack } from "../lib/modpacks";
import { configDir, toPowerShell, toRollbackPowerShell } from "../lib/repair/repairs";
import {
  allFileActions,
  splitBySteam,
  resolveDecision,
  runTriage,
  triageSteps,
  type TriageResult,
  type TriageStep,
} from "../lib/repair/triage";
import type { WorkshopCache } from "../lib/types";
import { download } from "../lib/download";
import { inShell } from "../lib/shell";

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
  const [busy, setBusy] = useState(false);

  function setAutoMode(next: boolean) {
    setAuto(next);
    try {
      localStorage.setItem(AUTO_KEY, next ? "1" : "0");
    } catch {
      /* private window; the toggle still works for this session */
    }
  }

  /**
   * Plan the pass, after letting the button paint that it is working.
   *
   * runTriage is synchronous and plans every repair, which on a list carrying several
   * hundred texture actions is long enough to see. Called straight from the click handler it
   * blocks the frame, so the button never gets to change and the window simply stops for a
   * moment. Yielding once lets the busy state land first.
   */
  function run() {
    if (busy) return;
    setBusy(true);
    setTimeout(() => {
      try {
        plan();
      } finally {
        setBusy(false);
      }
    }, 0);
  }

  function plan() {
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
        <button
          className={`triage-btn${findings.length === 0 ? " clean" : ""}${busy ? " busy" : ""}`}
          type="button"
          disabled={busy}
          onClick={run}
        >
          <span className="cross" aria-hidden="true">
            <svg width="30" height="30" viewBox="0 0 16 16" focusable="false">
              <rect x="6.1" y="0.6" width="3.8" height="14.8" rx="1.2" fill="#ffffff" />
              <rect x="0.6" y="6.1" width="14.8" height="3.8" rx="1.2" fill="#ffffff" />
            </svg>
          </span>
          <span className="triage-label">
            <b>{busy ? "Working..." : findings.length === 0 ? "Nothing to triage" : "Perform triage"}</b>
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
      {/*
        The report first, the transcript under it. The console runs to forty lines on a big
        install, so what to do next was below the fold while a scrolling log of how the app
        got there was the whole screen.
      */}
      {result && (
        <TriageReport
          result={result}
          scan={scan}
          onApplied={onApplied}
          onDecide={() => setQueue(result.decisions)}
          onDismiss={() => setResult(null)}
        />
      )}
      {steps.length > 0 && <TriageConsole steps={steps} />}
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
  onDecide,
  onDismiss,
}: {
  result: TriageResult;
  scan: ScanResult;
  onApplied?: () => void;
  /**
   * Ask the decisions this report is holding.
   *
   * They were already asked one at a time with Auto off, and simply filed away with it on,
   * which left the report listing questions with no way to answer them. This hands them
   * back to the same queue the modal reads, so there is one asking mechanism rather than
   * two that could disagree.
   */
  onDecide: () => void;
  onDismiss: () => void;
}) {
  const actions = allFileActions(result);
  const split = splitBySteam(result);
  const resolved = result.before - result.after;
  // A report describes a plan until the plan runs, and a record of what happened after.
  const [applied, setApplied] = useState(false);

  return (
    <div className="triage-report">
      <div className="triage-head">
        <h2>{headline(result, resolved)}</h2>
        <p className="triage-next">{nextStep(result, applied)}</p>
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

      {result.decisions.length > 0 && (
        <div className="repair-actions triage-decide">
          <button
            className="btn go"
            type="button"
            title="Asks each one in turn. Nothing is written to disk by answering."
            onClick={onDecide}
          >
            Decide {result.decisions.length} thing{result.decisions.length === 1 ? "" : "s"} now
          </button>
          <span className="repair-note">
            Answering moves each one into the file changes below, which you then apply.
          </span>
        </div>
      )}

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
              workshop={scan.paths.workshop ?? null}
              now={split.now}
              deferred={split.deferred}
              deferredFor={split.deferredFor}
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
        {orderedNotes(result.notes)
          .slice(0, 10)
          .map((note) => (
            <li key={note.id}>
              <b>{note.title}</b>
              {note.stale ? (
                <>
                  <span className="f-settled">settled</span>
                  <span className="muted">{note.stale}</span>
                </>
              ) : (
                <span className="muted">{note.rule}</span>
              )}
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
/**
 * The one thing to do next, in a sentence.
 *
 * A report that lists seven buckets and offers four buttons is a description of a situation,
 * not an instruction. This says which of them to touch, because after a run the question is
 * never "what did you find" but "so what do I do".
 */
function nextStep(result: TriageResult, applied: boolean): string {
  const actions = allFileActions(result).length;
  if (applied) return "Done. Rescan to see the install as it is now.";
  if (actions > 0) {
    return `Apply the ${actions} file change${actions === 1 ? "" : "s"} below. Everything is backed up first, and the run can be undone.`;
  }
  if (result.decisions.length > 0) {
    return `Answer the ${result.decisions.length} question${result.decisions.length === 1 ? "" : "s"} below, then apply what they stage.`;
  }
  if (result.external.length > 0) {
    return "Nothing here can be applied for you. The remaining items need Steam, Windows or the mod's author.";
  }
  if (result.applied.length > 0)
    return "The load order was changed. Apply to game in the header to write it.";
  return "Nothing to do.";
}

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
 * Notes with the settled ones first.
 *
 * A finding the scan has settled is the answer to "did my repair work", and only ten notes
 * are shown. Left in place it fell below the cut on an install with twenty, so the count
 * moved and nothing said why.
 */
function orderedNotes(notes: Finding[]): Finding[] {
  return [...notes].sort((a, b) => Number(!!b.stale) - Number(!!a.stale));
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

import { useEffect, useRef, useState } from "react";
import type { Finding, ScanResult } from "../lib/types";
import type { Profile } from "../lib/profiles";
import { configDir, toPowerShell } from "../lib/repair/repairs";
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
  profile,
  workshop,
  applyProfile,
}: {
  findings: Finding[];
  scan: ScanResult;
  profile: Profile;
  workshop?: WorkshopCache | null;
  applyProfile: (profile: Profile, label: string) => void;
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
    const triage = runTriage(findings, { scan, profile }, { auto, workshop });
    if (triage.applied.length) {
      applyProfile(
        triage.profile,
        `triage (${triage.applied.length} fix${triage.applied.length === 1 ? "" : "es"})`,
      );
    }
    setSteps(triageSteps(triage, scan, profile.name));
    setResult(triage);
    // With Auto off, anything ambiguous is asked rather than filed away in a report.
    setQueue(auto ? [] : triage.decisions);
  }

  /** Answer one decision, re-planned against the pack as it stands right now. */
  function answer(finding: Finding, choiceIndex: number) {
    const resolved = resolveDecision(finding, choiceIndex, {
      scan,
      profile: result?.profile ?? profile,
      workshop,
    });
    if (resolved?.plan.kind === "pack") {
      applyProfile(resolved.plan.profile, "decision");
      setResult((r) =>
        r
          ? {
              ...r,
              profile: resolved.plan.kind === "pack" ? resolved.plan.profile : r.profile,
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
            <small>{auto ? "decides for you" : "asks you"}</small>
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
      {result && <TriageReport result={result} scan={scan} onDismiss={() => setResult(null)} />}
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
  onDismiss,
}: {
  result: TriageResult;
  scan: ScanResult;
  onDismiss: () => void;
}) {
  const actions = allFileActions(result);
  const resolved = result.before - result.after;

  return (
    <div className="triage-report">
      <div className="triage-head">
        <h2>
          {resolved > 0
            ? `${resolved} of ${result.before} issues resolved`
            : "Nothing to apply automatically"}
        </h2>
        <button className="btn" type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>

      <Section
        title="Applied to the pack"
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

      <Section title="Needs a script" count={actions.length} tone="warn" empty="Nothing on disk to change.">
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
            <button
              className="btn primary"
              type="button"
              onClick={() => download("rimdoc-triage.ps1", toPowerShell(actions, configDir(scan)))}
            >
              Download all {actions.length} as one script
            </button>
            <span className="repair-note">Saves an original-version backup before touching anything.</span>
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

      <p className="triage-foot">
        Triage applies what is provably safe and stages what is not. It does not guarantee the game runs:
        problems that only appear once the game is executing need the supervised launch and the headless boot
        check, neither of which is built yet.
      </p>
    </div>
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

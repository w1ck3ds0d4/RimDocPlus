import { createContext, useContext, useMemo, useState } from "react";
import type { Finding, ScanResult, WorkshopCache } from "../lib/types";
import type { Modpack } from "../lib/modpacks";
import {
  configDir,
  needsSteamClosed,
  planRepair,
  toPowerShell,
  toRollbackPowerShell,
  type FileAction,
  type RepairPlan,
} from "../lib/repair/repairs";
import { download } from "../lib/download";
import { ApplyActions } from "./ApplyActions";
import { Subscribe, workshopIdOf } from "./Subscribe";

export interface RepairApi {
  scan: ScanResult;
  modpack: Modpack;
  workshop?: WorkshopCache | null;
  /** Commit a repaired modpack. The caller records the previous one so this can be undone. */
  applyModpack: (modpack: Modpack, label: string) => void;
}

const RepairContext = createContext<RepairApi | null>(null);

/**
 * The scan and modpack every finding is being judged against.
 *
 * Exposed so a component deep in a findings list can reach them without four layers of prop
 * drilling for something the provider already wraps the whole app with.
 */
export function useRepairApi(): RepairApi | null {
  return useContext(RepairContext);
}

export function RepairProvider({ value, children }: { value: RepairApi; children: React.ReactNode }) {
  return <RepairContext.Provider value={value}>{children}</RepairContext.Provider>;
}

/**
 * What the number on a repair button means, for the tooltip.
 *
 * "T1" told a reader nothing on its own. The full model is in docs/SPEC.md; this is the one
 * sentence per tier that answers the question the badge raises.
 */
const TIER_MEANING: Record<number, string> = {
  1: "Tier 1: metadata and load order. Reversible, and nothing that loads changes.",
  2: "Tier 2: XML patch repair. Diffed before it is applied.",
  3: "Tier 3: missing or oversized content. Changes what the game loads.",
  4: "Tier 4: assembly level. Never silent, always explained, undone in one click.",
};

/**
 * The repair control for one finding.
 *
 * A repair is always explained before it can be run, per the safety model: the button
 * opens the plan, and only the plan carries the action. Nothing is applied by the click
 * that reveals what it would do.
 */
export function RepairAction({ finding }: { finding: Finding }) {
  const api = useContext(RepairContext);
  const [open, setOpen] = useState(false);

  // Planned once per finding rather than once per render. Planning walks every installed
  // mod to build its lookup maps, and there is one of these per finding row, so a filter
  // toggle on the Doctor tab rebuilt a few hundred maps over a 253-mod install before
  // anything had actually changed. Above the early return, because hooks cannot be
  // conditional, and keyed on the fields rather than on the context object: that object is
  // built fresh by the provider on every render, so keying on it would never hit.
  const plan = useMemo(
    () =>
      api && finding.fix
        ? planRepair({ scan: api.scan, modpack: api.modpack, workshop: api.workshop, finding })
        : null,
    [api?.scan, api?.modpack, api?.workshop, finding],
  );

  if (!api || !finding.fix) return null;

  if (!plan) {
    return (
      <button className="btn" type="button" disabled title="No automatic repair for this one yet">
        {finding.fix.label}
        <span className="tier" title={TIER_MEANING[finding.fix.tier]}>
          T{finding.fix.tier}
        </span>
      </button>
    );
  }

  return (
    <div className="repair">
      <button className="btn primary" type="button" onClick={() => setOpen((v) => !v)}>
        {finding.fix.label}
        <span className="tier" title={TIER_MEANING[finding.fix.tier]}>
          T{finding.fix.tier}
        </span>
        <span className="caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && <RepairPanel plan={plan} api={api} onDone={() => setOpen(false)} title={finding.title} />}
    </div>
  );
}

function RepairPanel({
  plan,
  api,
  onDone,
  title,
}: {
  plan: RepairPlan;
  api: RepairApi;
  onDone: () => void;
  /** The finding's own title, so a held-back repair can say which one it was. */
  title: string;
}) {
  const [chosen, setChosen] = useState<RepairPlan | null>(null);
  const active = chosen ?? plan;

  return (
    <div className="repair-panel">
      <p className="repair-summary">{active.summary}</p>

      {active.kind === "modpack" && (
        <div className="repair-actions">
          <button
            className="btn primary"
            type="button"
            onClick={() => {
              api.applyModpack(active.modpack, "repair");
              onDone();
            }}
          >
            Apply to modpack
          </button>
          <span className="repair-note">Instant and undoable. Nothing on disk changes.</span>
        </div>
      )}

      {active.kind === "files" && (
        <FilePlan
          actions={active.actions}
          config={configDir(api.scan)}
          workshop={api.scan.paths.workshop ?? null}
          title={title}
        />
      )}

      {active.kind === "external" && (
        <div className="repair-actions">
          {/*
            Only offered when the game directory is known, since that is where the Steamworks
            library is read from. Without it there is still the link.
          */}
          {api.scan.paths.game && workshopIdOf(active.url) && (
            <Subscribe gameDir={api.scan.paths.game} workshopId={workshopIdOf(active.url)!} />
          )}
          {active.url && (
            <a className="btn" href={active.url} target="_blank" rel="noreferrer noopener">
              Open the page
            </a>
          )}
          {!workshopIdOf(active.url) && (
            <span className="repair-note">RimDoc+ cannot do this one for you.</span>
          )}
        </div>
      )}

      {active.kind === "choice" && (
        <div className="repair-actions">
          {active.choices.map((choice) => (
            <button
              key={choice.label}
              className="btn"
              type="button"
              title={choice.detail}
              onClick={() => setChosen(choice.plan())}
            >
              {choice.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * File repairs cannot run from a browser, so the plan is shown in full and handed over as
 * a script. Every path is listed before anything is generated, because this is the only
 * class of repair that touches the player's install.
 */
/**
 * One repair's file changes: what they are, and every way to carry them out.
 *
 * The same apply the Doctor's triage uses, rather than a second implementation of it. This
 * panel used to offer only a script to download, so a single repair was the one place in the
 * app that could not just do the thing, and the Steam-aware path did not exist here at all.
 */
function FilePlan({
  actions,
  config,
  workshop,
  title,
  onApplied,
}: {
  actions: FileAction[];
  config: string | null;
  workshop: string | null;
  title: string;
  onApplied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const script = toPowerShell(actions, config);
  // A repair moves whole: if any part of it needs Steam closed, all of it waits. The pieces
  // are paired, and half of this one leaves a mod deleted that Steam still thinks it has.
  const held = needsSteamClosed(actions);

  return (
    <>
      <ol className="repair-files">
        {actions.slice(0, 12).map((action, i) => (
          <li key={i}>
            <span className={`op ${action.op}`}>{opLabel(action)}</span>
            <code>{"path" in action ? action.path : `${action.directory}/${action.pattern}`}</code>
          </li>
        ))}
        {actions.length > 12 && <li className="muted">and {actions.length - 12} more</li>}
      </ol>
      <div className="repair-actions">
        <ApplyActions
          actions={actions}
          now={held ? [] : actions}
          deferred={held ? actions : []}
          deferredFor={held ? [title] : []}
          config={config}
          workshop={workshop}
          onApplied={onApplied}
        />
        <button className="btn" type="button" onClick={() => download("rimdoc-repair.ps1", script)}>
          Download .ps1
        </button>
        <button
          className="btn"
          type="button"
          title="Restores every file this repair backed up"
          onClick={() => download("rimdoc-rollback.ps1", toRollbackPowerShell(actions))}
        >
          Download rollback
        </button>
        <button
          className="btn"
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(script).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? "Copied" : "Copy script"}
        </button>
        <span className="repair-note">
          Saves an original-version backup before touching anything. Writing this directly arrives with the
          desktop shell.
        </span>
      </div>
    </>
  );
}

function opLabel(action: FileAction): string {
  if (action.op === "add-supported-version") return `stamp ${action.cycle}`;
  if (action.op === "downscale-png") return `${action.maxPx}px`;
  if (action.op === "write") return "write";
  return "remove";
}

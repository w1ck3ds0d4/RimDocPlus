import type { Finding, ScanResult, WorkshopCache } from "../types";
import type { Modpack } from "../modpacks";
import { runStaticRules } from "../analysis/rules.ts";
import {
  estimateDurationMs,
  formatDuration,
  needsSteamClosed,
  planRepair,
  type FileAction,
  type RepairPlan,
} from "./repairs.ts";

export interface TriageResult {
  /** The pack after every safe automatic repair. Not yet committed. */
  modpack: Modpack;
  applied: { finding: Finding; summary: string }[];
  /** Repairs that need a human decision before they can be planned. */
  decisions: { finding: Finding; plan: Extract<RepairPlan, { kind: "choice" }> }[];
  /** Choices Auto resolved on the app's own judgement, with the reasoning it used. */
  autoDecided: {
    finding: Finding;
    choice: string;
    reasons: string[];
    caveats: string[];
  }[];
  /** Everything that has to touch disk, gathered into one script. */
  files: { finding: Finding; actions: FileAction[]; summary: string }[];
  external: { finding: Finding; summary: string; url?: string }[];
  /** Findings with no repair implemented yet. */
  unresolved: Finding[];
  /**
   * Findings that propose no repair because none is wanted: notes rather than faults.
   * Bucketed rather than dropped, so every finding is accounted for and a summary cannot
   * quietly describe a fraction of them.
   */
  notes: Finding[];
  before: number;
  after: number;
  /** Wall-clock the analysis and repair planning actually took. */
  elapsedMs: number;
}

/** One line of the triage console. */
export interface TriageStep {
  tone: "cmd" | "info" | "ok" | "warn" | "work" | "done";
  label?: string;
  text: string;
}

/**
 * One pass over every finding, sorting each into what can be done about it.
 *
 * The automatic repairs are chained: each is planned against the result of the one
 * before, so the batch cannot contain two conflicting edits to the same load order. The
 * rest is staged rather than guessed at, because the difference between a repair that is
 * safe to run unattended and one that is not is the whole point of the tier system.
 */
export interface TriageOptions {
  /**
   * Resolve choices on the app's own judgement instead of asking.
   *
   * Auto takes any option a repair can defend, including ones that resolve to deleting a
   * folder, because a file plan is still only staged: it becomes a script the player
   * reads and runs. That download is the confirmation step, so Auto is not acting
   * unattended on disk, it is deciding what to put in front of them.
   */
  auto?: boolean;
  workshop?: WorkshopCache | null;
}

export function runTriage(
  findings: Finding[],
  ctx: { scan: ScanResult; modpack: Modpack },
  options: TriageOptions = {},
): TriageResult {
  const result: TriageResult = {
    modpack: ctx.modpack,
    applied: [],
    decisions: [],
    autoDecided: [],
    files: [],
    external: [],
    unresolved: [],
    notes: [],
    // Both ends come from re-running the rules, so the count means the same thing on each
    // side. Taking `before` from the input length instead broke the moment findings that
    // the rules cannot re-derive, such as anything read out of a log, were passed in.
    before: countRemaining(ctx.scan, ctx.modpack),
    after: 0,
    elapsedMs: 0,
  };
  const startedAt = performance.now();

  for (const finding of findings) {
    // Already dealt with, per the current scan. Repairing it would find nothing to do, and
    // counting it as outstanding work would overstate what is left.
    if (finding.stale) {
      result.notes.push(finding);
      continue;
    }

    const plan = planRepair({
      scan: ctx.scan,
      modpack: result.modpack,
      workshop: options.workshop,
      finding,
    });

    if (!plan) {
      // A finding proposing no fix is a note; one proposing a fix nothing implements is
      // a gap. Collapsing them lost twelve of fifteen findings from the accounting.
      (finding.fix ? result.unresolved : result.notes).push(finding);
      continue;
    }

    switch (plan.kind) {
      case "modpack":
        // Only deterministic repairs run unattended. A pack repair the rule marked as
        // needing judgement is staged as a decision instead.
        if (finding.fix?.auto) {
          result.modpack = plan.modpack;
          result.applied.push({ finding, summary: plan.summary });
        } else {
          result.unresolved.push(finding);
        }
        break;
      case "choice": {
        // A single option the app does not recommend is something offered, not something
        // asked. Twelve patch-override findings each became a "decision" reading
        // "(1 options)", which buried the handful of real ones and made a report of things
        // to look at read as a queue of things to answer.
        if (plan.choices.length === 1 && !plan.choices[0].recommended) {
          result.notes.push(finding);
          break;
        }
        const resolved = options.auto ? autoResolve(plan) : null;
        if (!resolved) {
          result.decisions.push({ finding, plan });
          break;
        }
        result.autoDecided.push({
          finding,
          choice: resolved.choice.label,
          reasons: resolved.choice.rationale?.reasons ?? [],
          caveats: resolved.choice.rationale?.caveats ?? [],
        });
        if (resolved.plan.kind === "modpack") {
          result.modpack = resolved.plan.modpack;
          result.applied.push({ finding, summary: resolved.plan.summary });
        } else if (resolved.plan.kind === "files") {
          result.files.push({
            finding,
            actions: resolved.plan.actions,
            summary: resolved.plan.summary,
          });
        }
        break;
      }
      case "files":
        result.files.push({ finding, actions: plan.actions, summary: plan.summary });
        break;
      case "external":
        result.external.push({ finding, summary: plan.summary, url: plan.url });
        break;
    }
  }

  result.after = countRemaining(ctx.scan, result.modpack);
  result.elapsedMs = performance.now() - startedAt;
  return result;
}

/**
 * The option Auto takes, or null when the repair could not defend any of them.
 *
 * A repair that names no recommendation has nothing to automate, so that case still goes
 * to the player rather than being settled by picking whichever option came first.
 */
function autoResolve(
  plan: Extract<RepairPlan, { kind: "choice" }>,
): { choice: (typeof plan.choices)[number]; plan: RepairPlan } | null {
  const choice = plan.choices.find((c) => c.recommended);
  return choice ? { choice, plan: choice.plan() } : null;
}

/**
 * Re-plan one choice against the pack as it stands now.
 *
 * The plan captured when triage ran was built against the pack at that moment. Answering
 * two decisions in a row would otherwise apply the second against a stale pack and quietly
 * undo the first, so an answer is re-planned rather than replayed.
 */
export function resolveDecision(
  finding: Finding,
  choiceIndex: number,
  ctx: { scan: ScanResult; modpack: Modpack; workshop?: WorkshopCache | null },
): { plan: RepairPlan; label: string } | null {
  const fresh = planRepair({ ...ctx, finding });
  if (fresh?.kind !== "choice") return null;
  const choice = fresh.choices[choiceIndex];
  return choice ? { plan: choice.plan(), label: choice.label } : null;
}

/** Re-run the rules against the repaired pack, which is the only honest "after" number. */
function countRemaining(scan: ScanResult, modpack: Modpack): number {
  const position = new Map(modpack.activeOrder.map((id, i) => [id, i]));
  return runStaticRules({
    ...scan,
    activeOrder: modpack.activeOrder,
    mods: scan.mods.map((mod) => ({
      ...mod,
      active: position.has(mod.packageId),
      loadIndex: position.get(mod.packageId) ?? null,
    })),
  }).length;
}

/**
 * Every file action triage gathered, in one script's worth of work.
 *
 * Findings overlap: the footprint rule and the oversized rule name many of the same
 * textures. Deduplicating by target keeps the script from acting on one file twice.
 */
/**
 * Split a run into what can go now and what has to wait for Steam to close.
 *
 * Whole repairs move together, never individual actions. One repair pairs an edit Steam can
 * refuse with deleting a mod folder, and running half of that pair leaves the mod gone with
 * Steam still believing it has it. Everything else is independent, so holding back the
 * critical mod-list restore because an unrelated Workshop retry needs Steam closed would be
 * refusing to do the useful thing over the inconvenient one.
 */
export function splitBySteam(result: TriageResult): {
  now: FileAction[];
  deferred: FileAction[];
  deferredFor: string[];
} {
  const held = result.files.filter((f) => needsSteamClosed(f.actions));
  const free = result.files.filter((f) => !needsSteamClosed(f.actions));
  return {
    now: dedupe(free.flatMap((f) => f.actions)),
    deferred: dedupe(held.flatMap((f) => f.actions)),
    deferredFor: held.map((f) => f.finding.title),
  };
}

function dedupe(actions: FileAction[]): FileAction[] {
  const seen = new Set<string>();
  const out: FileAction[] = [];
  for (const action of actions) {
    const key = "path" in action ? `${action.op}:${action.path}` : `${action.op}:${action.directory}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }
  return out;
}

export function allFileActions(result: TriageResult): FileAction[] {
  return dedupe(result.files.flatMap((f) => f.actions));
}

/**
 * The console transcript for a triage run.
 *
 * Every number here is measured or derived from the plan: the elapsed time is real, and
 * the duration attached to the file work comes from a throughput model calibrated against
 * timed runs on a real install rather than a guess.
 */
export function triageSteps(result: TriageResult, scan: ScanResult, packName: string): TriageStep[] {
  const steps: TriageStep[] = [
    { tone: "cmd", text: `rimdoc triage --pack "${packName}"` },
    {
      tone: "info",
      label: "scan",
      text: `${scan.mods.length} mods on disk, ${result.modpack.activeOrder.length} in load order`,
    },
    {
      tone: "info",
      label: "analyse",
      text: `${result.before} finding${result.before === 1 ? "" : "s"} in ${Math.max(1, Math.round(result.elapsedMs))}ms`,
    },
  ];

  if (result.applied.length) {
    steps.push({ tone: "info", label: "repair", text: "applying automatic repairs" });
    for (const { finding, summary } of result.applied) {
      steps.push({ tone: "ok", label: "fixed", text: `${finding.title} - ${summary}` });
    }
  } else {
    steps.push({ tone: "info", label: "repair", text: "no modpack change needed" });
  }

  for (const decision of result.autoDecided) {
    steps.push({
      tone: decision.caveats.length ? "warn" : "ok",
      label: "auto",
      text:
        `${decision.choice}: ${decision.reasons.join(". ")}` +
        (decision.caveats.length ? ` (contested: ${decision.caveats[0]})` : ""),
    });
  }

  for (const { finding, plan } of result.decisions) {
    steps.push({
      tone: "warn",
      label: "decide",
      text: `${finding.title} (${plan.choices.length} options)`,
    });
  }

  const actions = allFileActions(result);
  if (actions.length) {
    for (const file of result.files) {
      steps.push({
        tone: "work",
        label: "stage",
        text: `${file.finding.title} - ${file.actions.length} action${file.actions.length === 1 ? "" : "s"}`,
      });
    }
    steps.push({
      tone: "work",
      label: "script",
      text:
        `${actions.length} action${actions.length === 1 ? "" : "s"} written to a script, est. ` +
        `${formatDuration(estimateDurationMs(actions))} to run. A browser cannot write to disk, so ` +
        "these wait for the script or the desktop shell.",
    });
  }

  for (const { finding } of result.external) {
    steps.push({ tone: "info", label: "manual", text: finding.title });
  }

  for (const finding of result.unresolved) {
    steps.push({ tone: "warn", label: "skip", text: `${finding.title} (no repair implemented)` });
  }

  // Notes are listed rather than summed, because "12 informational" tells a reader
  // nothing about whether any of them is worth their attention.
  for (const note of result.notes.slice(0, 8)) {
    steps.push({ tone: "info", label: "note", text: note.title });
  }
  if (result.notes.length > 8) {
    steps.push({ tone: "info", label: "note", text: `and ${result.notes.length - 8} more` });
  }

  // Report every finding against where it went. "Nothing was auto-fixable" was both
  // wrong and unhelpful when most of the list was notes and the rest had been staged.
  const fixedNow = result.before - result.after;
  const stagedFindings = new Set(result.files.map((f) => f.finding.id)).size;
  const needsYou = result.decisions.length + result.external.length;
  const parts = [
    fixedNow > 0 ? `${fixedNow} fixed` : null,
    result.autoDecided.length > 0 ? `${result.autoDecided.length} decided automatically` : null,
    stagedFindings > 0 ? `${stagedFindings} staged for the script` : null,
    needsYou > 0 ? `${needsYou} needs you` : null,
    result.unresolved.length > 0 ? `${result.unresolved.length} with no repair yet` : null,
    result.notes.length > 0 ? `${result.notes.length} informational` : null,
  ].filter(Boolean);

  steps.push({
    tone: "done",
    label: "done",
    text: `${result.before} finding${result.before === 1 ? "" : "s"}: ${
      parts.length ? parts.join(", ") : "nothing to do"
    }`,
  });

  return steps;
}

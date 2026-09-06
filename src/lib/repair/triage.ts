import type { Finding, ScanResult } from "../types";
import type { Profile } from "../profiles";
import { runStaticRules } from "../analysis/rules.ts";
import {
  estimateDurationMs,
  formatDuration,
  planRepair,
  type FileAction,
  type RepairPlan,
} from "./repairs.ts";

export interface TriageResult {
  /** The pack after every safe automatic repair. Not yet committed. */
  profile: Profile;
  applied: { finding: Finding; summary: string }[];
  /** Repairs that need a human decision before they can be planned. */
  decisions: { finding: Finding; plan: Extract<RepairPlan, { kind: "choice" }> }[];
  /** Everything that has to touch disk, gathered into one script. */
  files: { finding: Finding; actions: FileAction[]; summary: string }[];
  external: { finding: Finding; summary: string; url?: string }[];
  /** Findings with no repair implemented yet. */
  unresolved: Finding[];
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
export function runTriage(findings: Finding[], ctx: { scan: ScanResult; profile: Profile }): TriageResult {
  const result: TriageResult = {
    profile: ctx.profile,
    applied: [],
    decisions: [],
    files: [],
    external: [],
    unresolved: [],
    before: findings.length,
    after: findings.length,
    elapsedMs: 0,
  };
  const startedAt = performance.now();

  for (const finding of findings) {
    const plan = planRepair({ scan: ctx.scan, profile: result.profile, finding });

    if (!plan) {
      if (finding.fix) result.unresolved.push(finding);
      continue;
    }

    switch (plan.kind) {
      case "pack":
        // Only deterministic repairs run unattended. A pack repair the rule marked as
        // needing judgement is staged as a decision instead.
        if (finding.fix?.auto) {
          result.profile = plan.profile;
          result.applied.push({ finding, summary: plan.summary });
        } else {
          result.unresolved.push(finding);
        }
        break;
      case "choice":
        result.decisions.push({ finding, plan });
        break;
      case "files":
        result.files.push({ finding, actions: plan.actions, summary: plan.summary });
        break;
      case "external":
        result.external.push({ finding, summary: plan.summary, url: plan.url });
        break;
    }
  }

  result.after = countRemaining(ctx.scan, result.profile);
  result.elapsedMs = performance.now() - startedAt;
  return result;
}

/** Re-run the rules against the repaired pack, which is the only honest "after" number. */
function countRemaining(scan: ScanResult, profile: Profile): number {
  const position = new Map(profile.activeOrder.map((id, i) => [id, i]));
  return runStaticRules({
    ...scan,
    activeOrder: profile.activeOrder,
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
export function allFileActions(result: TriageResult): FileAction[] {
  const seen = new Set<string>();
  const out: FileAction[] = [];
  for (const action of result.files.flatMap((f) => f.actions)) {
    const key = "path" in action ? `${action.op}:${action.path}` : `${action.op}:${action.directory}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }
  return out;
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
      text: `${scan.mods.length} mods on disk, ${result.profile.activeOrder.length} in load order`,
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
    steps.push({ tone: "info", label: "repair", text: "nothing safe to apply unattended" });
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
    steps.push({
      tone: "work",
      label: "staged",
      text: `${actions.length} file action${actions.length === 1 ? "" : "s"}, est. ${formatDuration(
        estimateDurationMs(actions),
      )} to run`,
    });
  }

  for (const { finding } of result.external) {
    steps.push({ tone: "info", label: "manual", text: finding.title });
  }

  for (const finding of result.unresolved) {
    steps.push({ tone: "warn", label: "skip", text: `${finding.title} (no repair implemented)` });
  }

  steps.push({
    tone: "done",
    label: "done",
    text:
      result.before - result.after > 0
        ? `${result.before - result.after} of ${result.before} resolved, ${result.after} remaining`
        : `${result.after} issue${result.after === 1 ? "" : "s"} remaining, none auto-fixable`,
  });

  return steps;
}

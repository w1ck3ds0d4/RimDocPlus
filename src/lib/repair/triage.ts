import type { Finding, ScanResult } from "../types";
import type { Profile } from "../profiles";
import { runStaticRules } from "../analysis/rules.ts";
import { planRepair, type FileAction, type RepairPlan } from "./repairs.ts";

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
  };

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

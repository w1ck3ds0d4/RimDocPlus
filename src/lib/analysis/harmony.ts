import type { Finding, ModEntry } from "../types";

/**
 * What the patch probe reports, and what it means for a mod list.
 *
 * The probe reads .NET metadata and answers one question per patch class: does the thing
 * this patches still exist? Turning those answers into findings is analysis, so it happens
 * here rather than in the shell, and it is a pure function of the report and the scan.
 */

/** One Harmony patch class, exactly as the probe reported it. */
export interface ProbePatch {
  /** Full path of the assembly it was found in. */
  assembly: string;
  patchClass: string;
  targetType: string | null;
  targetMethod: string | null;
  /** HarmonyPrefix, HarmonyPostfix, HarmonyTranspiler, HarmonyFinalizer. */
  kinds: string[];
  verdict: "ok" | "missing-method" | "missing-method-guarded" | "foreign-type" | "runtime-only";
  detail: string;
  /** Game types that do have a method of this name, when few enough to mean something. */
  movedTo: string[];
}

export interface ProbeReport {
  gameAssemblies: number;
  gameTypes: number;
  assembliesRead: number;
  assembliesUnreadable: string[];
  patches: ProbePatch[];
}

/**
 * The mod an assembly belongs to.
 *
 * By folder prefix, longest first: a mod nested inside another's folder would otherwise be
 * attributed to whichever happened to be checked first. Compared with separators normalised,
 * because the scan reports whatever the platform handed it and the probe reports what it
 * walked, and on Windows those disagree about slashes.
 */
function ownerOf(assembly: string, mods: ModEntry[]): ModEntry | undefined {
  const path = assembly.replace(/\\/g, "/").toLowerCase();
  let best: ModEntry | undefined;
  for (const mod of mods) {
    const folder = mod.folder.replace(/\\/g, "/").toLowerCase();
    if (!path.startsWith(folder + "/")) continue;
    if (!best || mod.folder.length > best.folder.length) best = mod;
  }
  return best;
}

/** `Type.Method`, or whatever half of it the probe could name. */
function targetOf(patch: ProbePatch): string {
  if (patch.targetType && patch.targetMethod) return `${patch.targetType}.${patch.targetMethod}`;
  return patch.targetType ?? patch.targetMethod ?? patch.patchClass;
}

/**
 * Findings from a probe report.
 *
 * One per mod rather than one per patch: a mod with four dead patches is one thing to decide
 * about, and four rows saying the same thing would bury the mod that has one.
 *
 * Only patches that cannot apply become findings. A patch on another mod's type is ordinary,
 * and one whose target is computed at runtime was never checked, so neither is a fault. The
 * coverage note says how many went unchecked, because a count that quietly excludes them
 * would read as a clean bill of health it has not earned.
 */
export function findingsFromProbe(report: ProbeReport, mods: ModEntry[], gameCycle: string): Finding[] {
  const broken = new Map<string, { mod: ModEntry; patches: ProbePatch[] }>();
  const guarded = new Map<string, { mod: ModEntry; patches: ProbePatch[] }>();

  for (const patch of report.patches) {
    if (patch.verdict !== "missing-method" && patch.verdict !== "missing-method-guarded") continue;
    const mod = ownerOf(patch.assembly, mods);
    if (!mod) continue;
    const into = patch.verdict === "missing-method" ? broken : guarded;
    const entry = into.get(mod.packageId) ?? { mod, patches: [] };
    entry.patches.push(patch);
    into.set(mod.packageId, entry);
  }

  const findings: Finding[] = [];

  for (const { mod, patches } of broken.values()) {
    const targets = [...new Set(patches.map(targetOf))];
    const moved = patches.filter((p) => p.movedTo.length > 0);
    findings.push({
      id: `harmony-missing:${mod.packageId}`,
      rule: "harmony-missing-target",
      severity: "error",
      title: `${mod.name} patches ${targets.length} method${targets.length === 1 ? "" : "s"} the game no longer has`,
      detail:
        `Harmony cannot apply a patch to something that is not there, so ${
          targets.length === 1 ? "this patch" : "these patches"
        } will fail when the game loads them. Usually that means the mod needs an update for ${gameCycle}.\n\n` +
        targets.map((t) => `  ${t}`).join("\n") +
        (moved.length > 0
          ? `\n\nSome of it moved rather than went:\n` +
            [...new Set(moved.map((p) => `  ${targetOf(p)} is now on ${p.movedTo.join(", ")}`))].join("\n")
          : ""),
      packageIds: [mod.packageId],
      count: targets.length,
    });
  }

  for (const { mod, patches } of guarded.values()) {
    const targets = [...new Set(patches.map(targetOf))];
    findings.push({
      id: `harmony-guarded:${mod.packageId}`,
      rule: "harmony-guarded-target",
      severity: "info",
      observation: true as const,
      // Not a fault: the mod ships patches for several game versions and picks at runtime.
      // Reported because it looks identical to breakage from outside, and someone reading a
      // list of dead targets deserves to know which ones the mod already knows about.
      title: `${mod.name} carries ${targets.length} patch${targets.length === 1 ? "" : "es"} for another version of the game`,
      detail:
        `${mod.name} declares ${
          targets.length === 1 ? "a patch" : "patches"
        } against ${targets.length === 1 ? "a method" : "methods"} this build does not have, but the patch class decides at runtime whether to apply, so the mod already knows. Nothing to do.\n\n` +
        targets.map((t) => `  ${t}`).join("\n"),
      packageIds: [mod.packageId],
      count: targets.length,
    });
  }

  const unchecked = report.patches.filter((p) => p.verdict === "runtime-only").length;
  if (unchecked > 0) {
    findings.push({
      id: "harmony-coverage",
      rule: "harmony-coverage",
      severity: "info",
      // What the check could and could not see, which is a fact about the check.
      observation: true as const,
      title: `${unchecked} Harmony patches decide their target while the game runs`,
      detail:
        `Read from ${report.assembliesRead} assemblies against ${report.gameTypes} game types. ` +
        `${report.patches.length - unchecked} patches name their target in metadata and were checked. ` +
        `The other ${unchecked} build it in code, through TargetMethod() or harmony.Patch(...), and nothing ` +
        `outside a running game can say whether those still resolve.` +
        (report.assembliesUnreadable.length > 0
          ? `\n\n${report.assembliesUnreadable.length} assemblies could not be read at all.`
          : ""),
      packageIds: [],
      count: unchecked,
    });
  }

  return findings;
}

import type { Finding, ModEntry, ScanResult } from "../types";
import { BOOTSTRAP_PACKAGE_IDS, OFFICIAL_PACKAGE_IDS } from "./about.ts";
import { LOAD_INSTRUCTION } from "./patches.ts";
import { DEFAULT_ANALYSIS, runPerformanceRules, type AnalysisOptions } from "./performance.ts";
import { ruleBundledAssemblies, ruleWorkshopUpdates } from "./packaging.ts";
import { runPatchRules } from "./patches.ts";

/** What one rule did on one run, for the diagnostics panel. */
/** A real newline, spelled so no escaping layer between here and the file can eat it. */
const NEWLINE = String.fromCharCode(10);

export interface RuleRun {
  name: string;
  count: number;
  ms: number;
  /** Set when the rule threw. The run continues; one broken rule must not blank the list. */
  error?: string;
}

/**
 * L1 static analysis: everything we can prove about a mod list without launching the
 * game. Each rule is independent and returns zero or more findings, so rules can be
 * added without touching the others.
 *
 * Rules run isolated and timed. A rule that throws is recorded and skipped rather than
 * taking the whole analysis with it, and a rule that quietly matches nothing shows up as
 * a zero in the panel, which is the failure mode that hides best in a passing test suite.
 */
export function runStaticRulesWithDiagnostics(
  scan: ScanResult,
  options: AnalysisOptions = DEFAULT_ANALYSIS,
): {
  findings: Finding[];
  runs: RuleRun[];
} {
  const byId = new Map<string, ModEntry>();
  for (const mod of scan.mods) {
    // Two folders can declare the same packageId; keep the first and let the duplicate
    // rule report the collision rather than silently dropping it.
    if (!byId.has(mod.packageId)) byId.set(mod.packageId, mod);
  }
  const activeSet = new Set(scan.activeOrder);
  const position = new Map(scan.activeOrder.map((id, i) => [id, i]));
  const active = scan.activeOrder.map((id) => byId.get(id)).filter((m): m is ModEntry => !!m);

  const rules: [string, () => Finding[]][] = [
    ["orphan-active", () => ruleOrphanActive(scan, byId)],
    ["duplicate-package-id", () => ruleDuplicatePackageId(scan)],
    ["dlc-after-mods", () => ruleDlcAfterMods(scan, position)],
    ["bootstrap-position", () => ruleBootstrapPosition(scan, position, byId)],
    ["missing-dependency", () => ruleMissingDependency(active, activeSet, byId)],
    ["inactive-dependency", () => ruleInactiveDependency(active, activeSet, byId)],
    ["incompatible-pair", () => ruleIncompatiblePair(active, activeSet, byId)],
    ["load-order-violation", () => ruleLoadOrder(active, position)],
    ["load-last-position", () => ruleLoadLast(active, position)],
    ["version-mismatch", () => ruleVersionMismatch(active, scan.gameCycle)],
    ["bundled-assemblies", () => ruleBundledAssemblies(active)],
    ["workshop-updates", () => ruleWorkshopUpdates(active, options.workshop ?? null)],
    ["performance", () => runPerformanceRules(scan, options)],
    ["duplicate-defs", () => ruleDuplicateDefs(active)],
    ["patch-override", () => runPatchRules(scan)],
  ];

  const findings: Finding[] = [];
  const runs: RuleRun[] = [];

  for (const [name, run] of rules) {
    const started = performance.now();
    try {
      const produced = run();
      findings.push(...produced);
      runs.push({ name, count: produced.length, ms: performance.now() - started });
    } catch (error) {
      runs.push({
        name,
        count: 0,
        ms: performance.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { findings, runs };
}

export function runStaticRules(scan: ScanResult, options: AnalysisOptions = DEFAULT_ANALYSIS): Finding[] {
  return runStaticRulesWithDiagnostics(scan, options).findings;
}

/** ModsConfig references a mod that is not on disk. The game drops it and errors. */
function ruleOrphanActive(scan: ScanResult, byId: Map<string, ModEntry>): Finding[] {
  const orphans = scan.activeOrder.filter((id) => !byId.has(id));
  if (!orphans.length) return [];
  return [
    {
      id: "orphan-active",
      rule: "orphan-active",
      severity: "critical",
      title: `${orphans.length} enabled mod${orphans.length === 1 ? " is" : "s are"} missing from disk`,
      detail:
        "ModsConfig.xml enables these package ids but no folder provides them. RimWorld drops them " +
        "at load, and any save that used their content reports missing defs.",
      packageIds: orphans,
      count: orphans.length,
      fix: {
        kind: "remove-orphan-entries",
        label: "Remove from load order",
        tier: 1,
        auto: true,
        params: { ids: orphans },
      },
    },
  ];
}

/** Same packageId in two folders. RimWorld keeps one and ignores the rest, silently. */
function ruleDuplicatePackageId(scan: ScanResult): Finding[] {
  const seen = new Map<string, ModEntry[]>();
  for (const mod of scan.mods) {
    const list = seen.get(mod.packageId) ?? [];
    list.push(mod);
    seen.set(mod.packageId, list);
  }
  return [...seen.entries()]
    .filter(([, mods]) => mods.length > 1)
    .map(([packageId, mods]) => ({
      id: `duplicate:${packageId}`,
      rule: "duplicate-package-id",
      severity: "error" as const,
      title: `Duplicate install: ${mods[0].name}`,
      detail:
        `${mods.length} folders declare packageId "${packageId}". RimWorld loads one and ignores the ` +
        `rest, so which copy wins is not something you control:\n` +
        mods.map((m) => `  ${m.source}: ${m.folder}`).join("\n"),
      packageIds: [packageId],
      fix: {
        kind: "pick-duplicate-winner",
        label: "Choose which copy to keep",
        tier: 1,
        auto: false,
        params: { packageId, folders: mods.map((m) => m.folder) },
      },
    }));
}

/** Official content must precede third-party content or DLC defs get patched too late. */
function ruleDlcAfterMods(scan: ScanResult, position: Map<string, number>): Finding[] {
  const firstThirdParty = scan.activeOrder.findIndex(
    (id) => !OFFICIAL_PACKAGE_IDS.includes(id) && !BOOTSTRAP_PACKAGE_IDS.includes(id),
  );
  if (firstThirdParty === -1) return [];
  const late = OFFICIAL_PACKAGE_IDS.filter((id) => (position.get(id) ?? -1) > firstThirdParty);
  if (!late.length) return [];
  return [
    {
      id: "dlc-after-mods",
      rule: "dlc-after-mods",
      severity: "error",
      title: `${late.length} official expansion${late.length === 1 ? "" : "s"} load after third-party mods`,
      detail:
        "Ludeon content has to load before any mod that patches it. Loading an expansion late means " +
        "mods that patch its defs ran before those defs existed, so their patches silently did nothing.",
      packageIds: late,
      count: late.length,
      fix: {
        kind: "hoist-official-content",
        label: "Move expansions to the top",
        tier: 1,
        auto: true,
        params: { ids: late },
      },
    },
  ];
}

/** Prepatcher rewrites assemblies and Harmony patches them, so both precede C# mods. */
function ruleBootstrapPosition(
  scan: ScanResult,
  position: Map<string, number>,
  byId: Map<string, ModEntry>,
): Finding[] {
  const findings: Finding[] = [];
  for (const id of BOOTSTRAP_PACKAGE_IDS) {
    const at = position.get(id);
    if (at === undefined) continue;
    const earlier = scan.activeOrder
      .slice(0, at)
      .filter((other) => !BOOTSTRAP_PACKAGE_IDS.includes(other) && byId.get(other)?.hasAssemblies);
    if (!earlier.length) continue;
    findings.push({
      id: `bootstrap-late:${id}`,
      rule: "bootstrap-position",
      severity: "critical",
      title: `${byId.get(id)?.name ?? id} loads after ${earlier.length} code mod(s)`,
      detail:
        "This has to initialise before any mod shipping compiled C#, otherwise those mods patch " +
        "against an unpatched runtime and fail in ways the log cannot attribute.",
      packageIds: [id, ...earlier],
      fix: {
        kind: "hoist-bootstrap",
        label: "Move to the top of the list",
        tier: 1,
        auto: true,
        params: { id },
      },
    });
  }
  return findings;
}

/**
 * One requirement, and every package id that satisfies it.
 *
 * Authors routinely list several ids for the same dependency, because a mod gets
 * reuploaded or continued under a new author prefix and both versions are in the wild.
 * They signal it by giving the entries the same displayName, which is the author stating
 * outright that these are the same thing. Treating each id as separately mandatory
 * reports a missing dependency for a mod that is installed and working.
 */
interface DependencyGroup {
  label: string;
  options: string[];
}

function dependencyGroups(mod: ModEntry): DependencyGroup[] {
  const groups = new Map<string, DependencyGroup>();
  for (const dep of mod.dependencies) {
    const id = dep.packageId.toLowerCase();
    // With no displayName there is nothing to group on, so the id stands alone.
    const key = dep.displayName?.trim().toLowerCase() || `id:${id}`;
    const existing = groups.get(key);
    if (existing) {
      if (!existing.options.includes(id)) existing.options.push(id);
    } else {
      groups.set(key, { label: dep.displayName?.trim() || id, options: [id] });
    }
  }
  return [...groups.values()];
}

/** Declared dependency is neither enabled nor installed. The usual cause of red walls. */
function ruleMissingDependency(
  active: ModEntry[],
  activeSet: Set<string>,
  byId: Map<string, ModEntry>,
): Finding[] {
  const findings: Finding[] = [];
  for (const mod of active) {
    for (const group of dependencyGroups(mod)) {
      // Any one alternative being present satisfies the whole requirement.
      if (group.options.some((id) => activeSet.has(id) || byId.has(id))) continue;
      findings.push({
        id: `missing-dep:${mod.packageId}:${group.options[0]}`,
        rule: "missing-dependency",
        severity: "critical",
        title: `${mod.name} needs ${group.label}`,
        detail:
          group.options.length > 1
            ? `None of these is installed: ${group.options.join(", ")}. Any one of them satisfies it.`
            : `Required dependency "${group.options[0]}" is neither enabled nor installed.`,
        packageIds: [mod.packageId, ...group.options],
        fix: {
          kind: "install-dependency",
          label: "Find on the Workshop",
          tier: 1,
          auto: false,
          params: { dependency: group.options[0], name: group.label },
        },
      });
    }
  }
  return findings;
}

/** Dependency is on disk but switched off. One click from fixed. */
function ruleInactiveDependency(
  active: ModEntry[],
  activeSet: Set<string>,
  byId: Map<string, ModEntry>,
): Finding[] {
  const findings: Finding[] = [];
  for (const mod of active) {
    for (const group of dependencyGroups(mod)) {
      if (group.options.some((id) => activeSet.has(id))) continue;
      const installed = group.options.find((id) => byId.has(id));
      if (!installed) continue;
      findings.push({
        id: `inactive-dep:${mod.packageId}:${installed}`,
        rule: "inactive-dependency",
        severity: "critical",
        title: `${mod.name} needs ${byId.get(installed)?.name ?? group.label}, which is disabled`,
        detail: "The dependency is installed but not in the active list. Enabling it fixes this.",
        packageIds: [mod.packageId, installed],
        fix: {
          kind: "enable-dependency",
          label: "Enable it",
          tier: 1,
          auto: true,
          params: { dependency: installed },
        },
      });
    }
  }
  return findings;
}

/** Both mods are on and one of them declares they cannot coexist. */
function ruleIncompatiblePair(
  active: ModEntry[],
  activeSet: Set<string>,
  byId: Map<string, ModEntry>,
): Finding[] {
  const findings: Finding[] = [];
  const reported = new Set<string>();
  for (const mod of active) {
    for (const other of mod.incompatibleWith) {
      if (!activeSet.has(other)) continue;
      // The declaration is usually one-sided; report the pair once either way round.
      const key = [mod.packageId, other].sort().join("|");
      if (reported.has(key)) continue;
      reported.add(key);
      findings.push({
        id: `incompatible:${key}`,
        rule: "incompatible-pair",
        severity: "error",
        title: `${mod.name} is incompatible with ${byId.get(other)?.name ?? other}`,
        detail: "Both are enabled. Expect broken content or hard errors wherever they overlap.",
        packageIds: [mod.packageId, other],
        fix: {
          kind: "disable-one-of",
          label: "Disable one of them",
          tier: 1,
          auto: false,
          params: { candidates: [mod.packageId, other] },
        },
      });
    }
  }
  return findings;
}

/**
 * A mod whose every declared def is also declared by another mod.
 *
 * RimWorld keeps one def per name and lets whichever loaded later win, silently, with
 * nothing in the log. Two mods declaring some of the same names is ordinary: an expansion
 * redefining what it expands is the system working, and in the reference install twenty-one
 * active pairs overlap that way, the largest being a tech-level mod redefining ninety-seven
 * of Core's research projects on purpose.
 *
 * Total containment is different. A mod every one of whose defs is also somebody else's
 * contributes nothing the other does not, and one of the two is redundant.
 *
 * With one exception, which the first run of this rule found: containment in Core or a DLC
 * means nothing. Redefining vanilla defs is the most ordinary thing a mod does, and EdB
 * Prepare Carefully redefining twenty-six of Core's is the mod working, not a duplicate of
 * Core. So official content is never the container. What is left is two mods shipping the
 * same content, and exactly one pair in the reference install qualifies: two versions of
 * one mod published as separate Workshop items.
 */
function ruleDuplicateDefs(active: ModEntry[]): Finding[] {
  // Small overlaps are coincidence rather than duplicated content: one mod naming a def the
  // same thing as another says nothing, five say the two ship the same thing.
  const MEANINGFUL = 5;
  const withDefs = active.filter((m) => (m.defNames?.length ?? 0) >= MEANINGFUL);
  const sets = new Map(withDefs.map((m) => [m.packageId, new Set(m.defNames)]));
  const findings: Finding[] = [];
  const reported = new Set<string>();

  for (const mod of withDefs) {
    const own = sets.get(mod.packageId)!;
    for (const other of withDefs) {
      if (other.packageId === mod.packageId) continue;
      // Redefining vanilla is how mods work. Only another mod claiming the same content
      // says one of the two is redundant.
      if (other.source === "official") continue;
      const theirs = sets.get(other.packageId)!;
      // Only ever reported from the contained side, so a pair yields one finding and the
      // mod named first is the one with nothing of its own.
      if (theirs.size < own.size) continue;
      if (![...own].every((name) => theirs.has(name))) continue;
      const key = [mod.packageId, other.packageId].sort().join("|");
      if (reported.has(key)) continue;
      reported.add(key);

      const later = (mod.loadIndex ?? 0) > (other.loadIndex ?? 0) ? mod : other;
      findings.push({
        id: `duplicate-defs:${key}`,
        rule: "duplicate-defs",
        severity: "warning",
        title: `${mod.name} declares nothing ${other.name} does not`,
        detail:
          `All ${own.size} defs ${mod.name} declares are also declared by ${other.name}, which ` +
          `declares ${theirs.size}. RimWorld keeps one def per name and lets whichever mod loads ` +
          `later win, with nothing written to the log, so right now ${later.name} supplies the ` +
          `shared ones and the other mod's copies are discarded.` +
          NEWLINE +
          NEWLINE +
          "Shared:" +
          NEWLINE +
          [...own]
            .sort()
            .slice(0, 15)
            .map((n) => `  ${n}`)
            .join(NEWLINE) +
          (own.size > 15 ? `${NEWLINE}  and ${own.size - 15} more` : ""),
        packageIds: [mod.packageId, other.packageId],
        count: own.size,
        fix: {
          kind: "disable-one-of",
          label: "Disable one of them",
          tier: 1,
          auto: false,
          params: { candidates: [mod.packageId, other.packageId] },
        },
      });
    }
  }
  return findings;
}

/**
 * A mod the author told you to load last, that is not.
 *
 * Read out of the author's own description rather than a list kept here. Nothing in
 * RimWorld's metadata says "load me last": no mod on the 253-mod reference install declares
 * loadBottom, so the instruction only ever exists as a sentence someone wrote, and reading
 * the sentence is the only way to honour it without this app deciding for them which mods
 * are special.
 *
 * The two that say it on that install are a performance mod, "MissileGirl should be the
 * last mod in your mod list", sitting at 151 of 224 with 73 mods after it, and a retexture
 * asking to be loaded by the end, sitting at 50 with 174 after it. Both are the author
 * saying their mod only works from where they put it.
 */
function ruleLoadLast(active: ModEntry[], position: Map<string, number>): Finding[] {
  const asked = active.filter((mod) => mod.description && LOAD_INSTRUCTION.test(mod.description));
  const findings: Finding[] = [];

  for (const mod of asked) {
    const at = position.get(mod.packageId);
    if (at === undefined) continue;
    // Mods after it that were not also told to be last. Two mods both asking to be last is
    // a disagreement between authors, not a mistake by the reader, and blaming whichever
    // lost would be inventing a winner.
    const after = active.filter((other) => {
      const theirs = position.get(other.packageId);
      return theirs !== undefined && theirs > at && !asked.includes(other);
    });
    // A handful behind it is the ordinary noise of a list this long. What the rule is for
    // is a mod sitting in the middle of one.
    if (after.length < 10) continue;

    findings.push({
      id: `load-last:${mod.packageId}`,
      rule: "load-last-position",
      severity: "warning",
      title: `${mod.name} asks to load last, and ${after.length} mods load after it`,
      detail:
        `${mod.name} says so in its own description, which is the only place RimWorld lets an ` +
        `author say it: nothing in the metadata carries "load me last". A mod that patches or ` +
        `retextures what everything else has already set has to run after them to see it, and ` +
        `from position ${at + 1} of ${active.length} it does not.` +
        NEWLINE +
        NEWLINE +
        "The author's words:" +
        NEWLINE +
        "  " +
        quoteInstruction(mod.description ?? ""),
      packageIds: [mod.packageId],
      count: after.length,
      fix: {
        kind: "sink-to-bottom",
        label: "Move it to the end",
        tier: 1,
        auto: false,
        params: { id: mod.packageId },
      },
    });
  }
  return findings;
}

/** The sentence the instruction is in, so the reader can judge it rather than trust it. */
function quoteInstruction(description: string): string {
  const found = LOAD_INSTRUCTION.exec(description);
  if (!found) return "";
  const at = found.index;
  const start = description.lastIndexOf(".", at) + 1;
  const end = description.indexOf(".", at + found[0].length);
  return description.slice(start, end === -1 ? undefined : end + 1).trim();
}

/** loadAfter and loadBefore constraints the current order violates. */
function ruleLoadOrder(active: ModEntry[], position: Map<string, number>): Finding[] {
  const findings: Finding[] = [];
  for (const mod of active) {
    const self = position.get(mod.packageId);
    if (self === undefined) continue;
    for (const other of mod.loadAfter) {
      const at = position.get(other);
      if (at !== undefined && at > self) findings.push(orderFinding(mod, other, "after"));
    }
    for (const other of mod.loadBefore) {
      const at = position.get(other);
      if (at !== undefined && at < self) findings.push(orderFinding(mod, other, "before"));
    }
  }
  return findings;
}

function orderFinding(mod: ModEntry, other: string, direction: "after" | "before"): Finding {
  const tag = direction === "after" ? "loadAfter" : "loadBefore";
  return {
    id: `order:${mod.packageId}:${direction}:${other}`,
    rule: "load-order-violation",
    severity: "warning",
    title: `${mod.name} should load ${direction} ${other}`,
    detail: `The mod declares ${tag} but the current order does the opposite.`,
    packageIds: [mod.packageId, other],
    fix: {
      kind: "reorder",
      label: "Fix the order",
      tier: 1,
      auto: true,
      params: { mod: mod.packageId, other, direction },
    },
  };
}

/**
 * Mod does not advertise the running game version. Usually it works and the author simply
 * never bumped the tag, which is why this is the most common Tier 1 repair by volume.
 */
function ruleVersionMismatch(active: ModEntry[], gameCycle: string): Finding[] {
  const stale = active.filter(
    (m) =>
      m.source !== "official" && m.supportedVersions.length > 0 && !m.supportedVersions.includes(gameCycle),
  );
  if (!stale.length) return [];
  return [
    {
      id: "version-mismatch",
      rule: "version-mismatch",
      severity: "warning",
      title: `${stale.length} mod${stale.length === 1 ? " does" : "s do"} not list ${gameCycle} support`,
      detail:
        "These advertise other game cycles. Most run fine and the author never bumped the tag, but " +
        "any genuinely targeting an older cycle can fail at runtime.",
      packageIds: stale.map((m) => m.packageId),
      count: stale.length,
      fix: {
        kind: "stamp-supported-version",
        label: `Stamp ${gameCycle} into About.xml`,
        tier: 1,
        auto: true,
        params: { ids: stale.map((m) => m.packageId), cycle: gameCycle },
      },
    },
  ];
}

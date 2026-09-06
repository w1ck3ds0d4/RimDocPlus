import type { Finding, ScanResult } from "./types";
import { REPAIR_KINDS } from "./repair/repairs.ts";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Invariants that must hold whatever install this is pointed at.
 *
 * These are not rules about the player's mods; they are assertions about RimDoc+ itself.
 * A rule referencing a repair that was never registered, or two findings sharing an id,
 * are bugs in this codebase that produce no error and no crash. React reports the second
 * one as a console warning nobody reads, which is how it survived a whole session here.
 */
export function runSelfChecks(scan: ScanResult, findings: Finding[]): CheckResult[] {
  return [
    uniqueFindingIds(findings),
    everyFixHasARepair(findings),
    findingsAreLegible(findings),
    modsHaveIdentity(scan),
    loadOrderResolves(scan),
    pathsKnown(scan),
  ];
}

/** Duplicate ids collapse rows in React and silently hide findings. */
function uniqueFindingIds(findings: Finding[]): CheckResult {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const finding of findings) {
    if (seen.has(finding.id)) duplicates.add(finding.id);
    seen.add(finding.id);
  }
  return {
    name: "Finding ids are unique",
    ok: duplicates.size === 0,
    detail: duplicates.size
      ? `${duplicates.size} repeated: ${[...duplicates].slice(0, 3).join(", ")}`
      : `${findings.length} findings, no repeats`,
  };
}

/** A rule naming a repair that does not exist offers a button that can never work. */
function everyFixHasARepair(findings: Finding[]): CheckResult {
  const missing = new Set(
    findings.map((f) => f.fix?.kind).filter((kind): kind is string => !!kind && !REPAIR_KINDS.has(kind)),
  );
  return {
    name: "Every proposed fix has a repair",
    ok: missing.size === 0,
    detail: missing.size ? `unregistered: ${[...missing].join(", ")}` : "all fix kinds registered",
  };
}

/** A finding with no title renders as an empty row. */
function findingsAreLegible(findings: Finding[]): CheckResult {
  const bad = findings.filter((f) => !f.title.trim() || !f.detail.trim());
  return {
    name: "Findings have a title and detail",
    ok: bad.length === 0,
    detail: bad.length ? `${bad.length} incomplete (${bad[0].rule})` : "all readable",
  };
}

/** A mod with no packageId cannot be ordered, and one with no name renders blank. */
function modsHaveIdentity(scan: ScanResult): CheckResult {
  const bad = scan.mods.filter((m) => !m.packageId.trim() || !m.name.trim());
  return {
    name: "Mods have an id and a name",
    ok: bad.length === 0,
    detail: bad.length ? `${bad.length} missing one (${bad[0].folder})` : `${scan.mods.length} checked`,
  };
}

/**
 * Enabled ids that resolve to nothing on disk. Not a bug on its own, since that is what
 * the orphan rule reports, but a sudden jump means the scanner stopped matching.
 */
function loadOrderResolves(scan: ScanResult): CheckResult {
  const known = new Set(scan.mods.map((m) => m.packageId));
  const unresolved = scan.activeOrder.filter((id) => !known.has(id));
  const share = scan.activeOrder.length ? unresolved.length / scan.activeOrder.length : 0;
  return {
    name: "Load order resolves to installed mods",
    ok: share < 0.5,
    detail: `${scan.activeOrder.length - unresolved.length} of ${scan.activeOrder.length} resolve`,
  };
}

/** Without these the file repairs have nowhere to write. */
function pathsKnown(scan: ScanResult): CheckResult {
  const missing = (["game", "saveData"] as const).filter((key) => !scan.paths[key]);
  return {
    name: "Install paths were found",
    ok: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(", ")}` : "game and save data located",
  };
}

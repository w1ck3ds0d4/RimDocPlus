import type { Finding, ScanResult, Severity } from "./types";
import type { SessionAnalysis } from "./analysis/logParser";
import { frameKind } from "./analysis/logParser";

/** Worst first. Someone skimming a pasted report reads the top of it and stops. */
const ORDER: Record<Severity, number> = { critical: 0, error: 1, warning: 2, info: 3 };

/**
 * The frames worth pasting.
 *
 * The first two frames of a RimWorld trace are almost always Verse or RimWorld internals,
 * which belong to any of 253 mods equally. The frames that name something are the Harmony
 * patch annotations and the mod frames, and they are the whole reason a trace is in a bug
 * report at all. Those come first, then engine frames fill the rest.
 */
function usefulFrames(frames: string[], limit: number): string[] {
  const named = frames.filter((f) => {
    const kind = frameKind(f.trim());
    return kind === "patch" || kind === "mod";
  });
  const rest = frames.filter((f) => !named.includes(f));
  return [...named, ...rest].slice(0, limit).map((f) => f.trim());
}

/**
 * A report written for someone else to read.
 *
 * Not the raw log. The raw log is tens of thousands of lines of Unity noise, and the parts
 * that matter have already been found: this is the environment, the clustered faults with
 * their attribution, and the mod list. Anyone helping can act on that, and it is small
 * enough to read.
 *
 * Ordered worst first, and honest about which entries are not work: a reader has no way to
 * tell that a line describes something already fixed, or something that was never a defect,
 * unless the report says so.
 */
export function buildReport(
  analysis: SessionAnalysis,
  findings: Finding[],
  scan: ScanResult,
  source: string,
  /**
   * What the scan found, as opposed to what the log did.
   *
   * "Which of these mods is not updated for this build yet" is the first thing anyone
   * helping asks, and the app already knows. Only the findings that describe the install
   * are taken, since the rest are about a load order the reader cannot see.
   */
  staticFindings: Finding[] = [],
): string {
  const env = analysis.environment;
  const active = scan.mods.filter((m) => m.active);

  const carried = staticFindings.filter((f) => CARRIED_RULES.has(f.rule));
  const all = [...findings, ...carried].sort(
    (a, b) => ORDER[a.severity] - ORDER[b.severity] || (b.count ?? 1) - (a.count ?? 1),
  );

  const counts = all.reduce<Partial<Record<Severity, number>>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const breakdown = (["critical", "error", "warning", "info"] as const)
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(", ");

  const lines: string[] = [
    "RimDoc+ session report",
    "",
    `Game        ${scan.gameVersion}`,
    env.unityVersion ? `Unity       ${env.unityVersion}` : "",
    env.renderer ? `GPU         ${env.renderer}` : "",
    env.vramMb ? `VRAM        ${(env.vramMb / 1024).toFixed(1)} GB` : "",
    env.gpuDriver ? `Driver      ${env.gpuDriver}` : "",
    `Mods        ${active.length} active of ${scan.mods.length} installed`,
    `Log         ${source}`,
    "",
    breakdown ? `Faults (${all.length}): ${breakdown}` : `Faults (${all.length})`,
    "",
  ];

  for (const finding of all) {
    // Said on the line itself rather than in a section below, because a report is pasted
    // and quoted in pieces, and a line that travels alone has to carry its own meaning.
    const note = finding.stale ? " [already fixed]" : finding.observation ? " [not a fault]" : "";
    lines.push(`[${finding.severity}] ${finding.title}${finding.count ? ` (x${finding.count})` : ""}${note}`);
    if (finding.packageIds.length) lines.push(`  blamed: ${finding.packageIds.join(", ")}`);
    for (const frame of usefulFrames(finding.frames ?? [], 2)) lines.push(`  ${frame}`);
    lines.push("");
  }

  lines.push(`Active mods, in load order (${active.length})`, "");
  for (const mod of active) lines.push(`  ${mod.packageId}  ${mod.name}`);

  return lines.filter((l) => l !== "").join("\n") + "\n";
}

/**
 * Scan findings that belong in a report about a run.
 *
 * Deliberately short. Most static findings are about a load order the reader is looking at
 * a list of anyway, and a report that carries everything is a report nobody reads. These
 * are the ones a person helping asks for before anything else.
 */
const CARRIED_RULES = new Set(["version-mismatch", "duplicate-defs", "duplicate-package-id"]);

/**
 * What leaves the machine, spelled out so it can be read before it is sent.
 *
 * The app is offline by default and this is the one feature that is not, so the summary is
 * built from the report itself rather than described in prose that could drift from it.
 */
export function describeReport(report: string): { lines: number; bytes: number; preview: string } {
  return {
    lines: report.split("\n").length,
    bytes: new TextEncoder().encode(report).length,
    preview: report.split("\n").slice(0, 12).join("\n"),
  };
}

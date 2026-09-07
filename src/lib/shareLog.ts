import type { Finding, ScanResult } from "./types";
import type { SessionAnalysis } from "./analysis/logParser";

/**
 * A report written for someone else to read.
 *
 * Not the raw log. The raw log is tens of thousands of lines of Unity noise, and the parts
 * that matter have already been found: this is the environment, the clustered faults with
 * their attribution, and the mod list. Anyone helping can act on that, and it is small
 * enough to read.
 */
export function buildReport(
  analysis: SessionAnalysis,
  findings: Finding[],
  scan: ScanResult,
  source: string,
): string {
  const env = analysis.environment;
  const active = scan.mods.filter((m) => m.active);

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
    `Faults (${findings.length})`,
    "",
  ];

  for (const finding of findings) {
    lines.push(`[${finding.severity}] ${finding.title}${finding.count ? ` (x${finding.count})` : ""}`);
    if (finding.packageIds.length) lines.push(`  blamed: ${finding.packageIds.join(", ")}`);
    // Two frames is enough to recognise a fault; the rest is Mono plumbing.
    for (const frame of (finding.frames ?? []).slice(0, 2)) lines.push(`  ${frame.trim()}`);
    lines.push("");
  }

  lines.push(`Active mods, in load order (${active.length})`, "");
  for (const mod of active) lines.push(`  ${mod.packageId}  ${mod.name}`);

  return lines.filter((l) => l !== "").join("\n") + "\n";
}

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

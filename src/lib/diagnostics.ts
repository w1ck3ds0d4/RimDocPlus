import type { ScanResult, WorkshopCache } from "./types";
import { runPatchRulesWithIntents } from "./analysis/patches";
import { loadBaseline, type Profile } from "./profiles";

export interface Stat {
  label: string;
  value: string;
  /**
   * A count that should not be zero. Set when a zero means a parser or matcher silently
   * stopped working rather than the install genuinely having none of something.
   */
  suspiciousWhenZero?: boolean;
}

export interface StatGroup {
  title: string;
  stats: Stat[];
}

/**
 * Numbers that should be non-zero on any real install.
 *
 * The failure this exists to catch is a parser or matcher that quietly matches nothing:
 * it throws no error, breaks no test that only asserts "no crash", and produces a clean
 * empty result that looks like good news. A regex whose word boundaries had become
 * literal backspace characters cost an hour precisely because it failed this way, so
 * every count that must not be zero is now shown as a count rather than assumed.
 */
export function buildDiagnostics(
  scan: ScanResult,
  workshop: WorkshopCache | null,
  profiles: Profile[],
  session: { path: string; text: string } | null,
): StatGroup[] {
  const active = scan.mods.filter((m) => m.active);
  const withPatches = active.filter((m) => m.patches?.length);
  const patchOps = active.reduce((n, m) => n + (m.patches?.length ?? 0), 0);
  const textures = active.reduce((n, m) => n + (m.textures?.count ?? 0), 0);
  const oversized = active.reduce((n, m) => n + (m.textures?.oversized.length ?? 0), 0);
  const baseline = loadBaseline();

  // Counted from the overrides actually reported, not from a sample. Sampling loadAfter
  // pairs looked reasonable and was useless: those are all "declared" by definition, so
  // the other three could only ever read zero however well the classifier worked.
  const { findings: overrides, intents } = runPatchRulesWithIntents(scan);

  return [
    {
      title: "Scan",
      stats: [
        { label: "Mods on disk", value: String(scan.mods.length), suspiciousWhenZero: true },
        { label: "Active", value: String(active.length), suspiciousWhenZero: true },
        { label: "In load order", value: String(scan.activeOrder.length) },
        { label: "Game", value: `${scan.gameVersion} (cycle ${scan.gameCycle})` },
        { label: "Scanned", value: scan.scannedAt.slice(0, 19).replace("T", " ") },
      ],
    },
    {
      title: "Parsing",
      stats: [
        {
          label: "With a description",
          value: `${scan.mods.filter((m) => m.description).length} of ${scan.mods.length}`,
          suspiciousWhenZero: true,
        },
        {
          label: "With an update date",
          value: String(scan.mods.filter((m) => m.updatedAt).length),
          suspiciousWhenZero: true,
        },
        {
          label: "Declaring dependencies",
          value: String(scan.mods.filter((m) => m.dependencies.length).length),
          suspiciousWhenZero: true,
        },
        {
          label: "Declaring load order",
          value: String(scan.mods.filter((m) => m.loadAfter.length || m.loadBefore.length).length),
          suspiciousWhenZero: true,
        },
        { label: "Named by folder fallback", value: String(namedByFolder(scan)) },
      ],
    },
    {
      title: "Patches",
      stats: [
        { label: "Mods shipping patches", value: String(withPatches.length), suspiciousWhenZero: true },
        { label: "Xpath operations", value: String(patchOps), suspiciousWhenZero: true },
        { label: "Overrides reported", value: String(overrides.length) },
        { label: "Intent: declared", value: String(intents.declared) },
        { label: "Intent: documented", value: String(intents.documented) },
        { label: "Intent: content", value: String(intents.content) },
        { label: "Intent: assumed", value: String(intents.assumed) },
      ],
    },
    {
      title: "Textures",
      stats: [
        { label: "Read", value: String(textures), suspiciousWhenZero: true },
        { label: "At 1024px or larger", value: String(oversized) },
        {
          label: "Decoded footprint",
          value: `${(active.reduce((n, m) => n + (m.textures?.estimatedVramBytes ?? 0), 0) / 1024 ** 3).toFixed(2)} GB`,
        },
        { label: "Walks truncated", value: String(active.filter((m) => m.textures?.truncated).length) },
      ],
    },
    {
      title: "Workshop",
      stats: workshop
        ? [
            {
              label: "Cached items",
              value: String(Object.keys(workshop.items).length),
              suspiciousWhenZero: true,
            },
            { label: "Fetched", value: workshop.fetchedAt.slice(0, 10) },
            {
              label: "Matched to installed mods",
              value: String(scan.mods.filter((m) => m.steamId && workshop.items[m.steamId]).length),
              suspiciousWhenZero: true,
            },
          ]
        : [{ label: "Cache", value: "not fetched" }],
    },
    {
      title: "Session log",
      stats: session
        ? [
            { label: "Source", value: session.path },
            { label: "Bytes", value: session.text.length.toLocaleString(), suspiciousWhenZero: true },
          ]
        : [{ label: "Log", value: "none loaded" }],
    },
    {
      title: "Storage",
      stats: [
        { label: "Packs", value: String(profiles.length), suspiciousWhenZero: true },
        {
          label: "Baseline",
          value: baseline
            ? `${baseline.activeOrder.length} mods, ${baseline.capturedAt.slice(0, 10)}`
            : "none",
        },
      ],
    },
  ];
}

/** Mods whose name came from the folder because About.xml carried none. */
function namedByFolder(scan: ScanResult): number {
  return scan.mods.filter((m) => m.source === "official").length;
}

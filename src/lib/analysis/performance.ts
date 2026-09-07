import type { Finding, ModEntry, OversizedTexture, ScanResult, WorkshopCache } from "../types";

const GB = 1024 ** 3;

/** Above this, a mod list's texture footprint starts costing more than it buys. */
const FOOTPRINT_WARN_GB = 4;
const FOOTPRINT_HIGH_GB = 8;

/** RimWorld draws at roughly 64px per tile, so this is generous even for large buildings. */
export const DOWNSCALE_TARGET_PX = 512;

/** What the oversize rule fires on unless the player has chosen otherwise. */
export const DEFAULT_OVERSIZE_PX = 1024;

export interface AnalysisOptions {
  /**
   * Workshop metadata, when the player has fetched it.
   *
   * Optional because the app works offline by default, and every rule reading it reports
   * nothing rather than guessing when it is absent.
   */
  workshop?: WorkshopCache | null;
  /**
   * A texture is worth resizing at or above this in either dimension.
   *
   * A setting rather than a constant because the honest answer depends on how the player
   * plays. The scan records every texture above the downscale target, so moving this
   * re-decides which of them count without needing another walk of the disk.
   */
  oversizePx: number;
}

export const DEFAULT_ANALYSIS: AnalysisOptions = { oversizePx: DEFAULT_OVERSIZE_PX };

/**
 * Performance rules.
 *
 * These are measurements, not opinions: every number here is computed from the files on
 * disk. Nothing claims a frame-rate figure, because attributing frame time needs the
 * in-game companion mod that does not exist yet.
 */
export function runPerformanceRules(
  scan: ScanResult,
  options: AnalysisOptions = DEFAULT_ANALYSIS,
): Finding[] {
  const active = scan.mods.filter((m) => m.active && m.textures);
  return [...ruleTextureFootprint(active), ...ruleOversizedTextures(active, options.oversizePx)];
}

/**
 * The recorded textures a downscale would actually act on at this threshold.
 *
 * The scan records everything above the downscale target, since anything at or below it
 * cannot be made smaller. Which of those count as oversized is the player's call, so every
 * consumer filters through here rather than trusting the length of the recorded list.
 */
export function oversizedAt(mod: ModEntry, thresholdPx: number): OversizedTexture[] {
  return (mod.textures?.oversized ?? []).filter((t) => t.width >= thresholdPx || t.height >= thresholdPx);
}

/** Every mod with something a downscale could act on at this threshold. */
function withOversized(active: ModEntry[], thresholdPx: number): ModEntry[] {
  return active.filter((m) => oversizedAt(m, thresholdPx).length > 0);
}

/**
 * Total decoded texture cost.
 *
 * Unity uploads textures decoded, so PNG compression buys nothing at runtime: a 2048px
 * texture costs 16 MB resident whether it compresses to 4 KB or 4 MB. This is an upper
 * bound rather than live usage, since RimWorld atlases and unloads, but it is the number
 * that decides how much work the atlas builder has and how close the card runs to full.
 *
 * It carries no repair. It is a measurement of how much art the list has, and resizing the
 * few textures that are too big barely moves it: on a 224-mod install the whole oversize
 * pass took it from 16.8 GB to 15.5 GB, because most of the cost is thousands of textures
 * already at or under the target. Offering a fix here promised something it could not
 * deliver, and duplicated the oversize rule's own plan over the same files.
 */
function ruleTextureFootprint(active: ModEntry[]): Finding[] {
  const bytes = active.reduce((sum, m) => sum + (m.textures?.estimatedVramBytes ?? 0), 0);
  const gb = bytes / GB;
  if (gb < FOOTPRINT_WARN_GB) return [];

  const worst = [...active]
    .sort((a, b) => (b.textures?.estimatedVramBytes ?? 0) - (a.textures?.estimatedVramBytes ?? 0))
    .slice(0, 10);

  return [
    {
      id: "texture-footprint",
      rule: "texture-footprint",
      severity: gb >= FOOTPRINT_HIGH_GB ? "warning" : "info",
      title: `${gb.toFixed(1)} GB of decoded texture data across ${active.length} mods`,
      detail:
        "Textures are uploaded decoded, so on-disk compression buys nothing at runtime. This is the " +
        "upper bound if everything were resident at once, not live usage, but it drives how much work " +
        "the atlas builder does at load and how close the card runs to full.\n\n" +
        "There is no repair for this one. Most of the total is thousands of textures already at a " +
        "sensible size, so it comes down chiefly by running fewer mods, not by resizing.\n\n" +
        "Heaviest mods:\n" +
        worst
          .map((m) => `  ${((m.textures?.estimatedVramBytes ?? 0) / GB).toFixed(2)} GB  ${m.name}`)
          .join("\n"),
      packageIds: worst.map((m) => m.packageId),
    },
  ];
}

/**
 * Individual textures far larger than anything the camera can show. These are the cheapest
 * wins in the whole tool: halving a dimension quarters the cost, and at RimWorld's zoom
 * the difference is usually invisible.
 */
function ruleOversizedTextures(active: ModEntry[], thresholdPx: number): Finding[] {
  const offenders = active
    .filter((m) => oversizedAt(m, thresholdPx).length > 0)
    .sort((a, b) => oversizedAt(b, thresholdPx).length - oversizedAt(a, thresholdPx).length)
    .slice(0, 12);
  if (!offenders.length) return [];

  const total = active.reduce((sum, m) => sum + oversizedAt(m, thresholdPx).length, 0);
  const truncated = active.some((m) => m.textures?.truncated);
  const biggest = oversizedAt(offenders[0], thresholdPx)[0];

  return [
    {
      id: "oversized-textures",
      rule: "oversized-textures",
      severity: "info",
      title: `${total}${truncated ? "+" : ""} textures at ${thresholdPx}px or larger`,
      detail:
        `The largest is ${biggest.width}x${biggest.height}. RimWorld draws at roughly 64px per tile, ` +
        `so anything past ${DOWNSCALE_TARGET_PX}px is detail the camera never resolves. Halving a ` +
        "dimension quarters what it costs.\n\n" +
        `The ${thresholdPx}px threshold is yours to set, in Settings.\n\n` +
        "Most affected:\n" +
        offenders.map((m) => `  ${oversizedAt(m, thresholdPx).length}  ${m.name}`).join("\n"),
      packageIds: offenders.map((m) => m.packageId),
      count: total,
      fix: {
        kind: "downscale-textures",
        label: `Downscale to ${DOWNSCALE_TARGET_PX}px`,
        tier: 3,
        auto: false,
        // The repair is told the threshold rather than re-deriving it, so a plan can never
        // cover a different set of files than the finding that proposed it.
        params: {
          ids: withOversized(active, thresholdPx).map((m) => m.packageId),
          target: String(DOWNSCALE_TARGET_PX),
          threshold: String(thresholdPx),
        },
      },
    },
  ];
}

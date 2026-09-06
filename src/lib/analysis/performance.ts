import type { Finding, ModEntry, ScanResult } from "../types";

const GB = 1024 ** 3;

/** Above this, a mod list's texture footprint starts costing more than it buys. */
const FOOTPRINT_WARN_GB = 4;
const FOOTPRINT_HIGH_GB = 8;

/** RimWorld draws at roughly 64px per tile, so this is generous even for large buildings. */
export const DOWNSCALE_TARGET_PX = 512;

/**
 * Performance rules.
 *
 * These are measurements, not opinions: every number here is computed from the files on
 * disk. Nothing claims a frame-rate figure, because attributing frame time needs the
 * in-game companion mod that does not exist yet.
 */
export function runPerformanceRules(scan: ScanResult): Finding[] {
  const active = scan.mods.filter((m) => m.active && m.textures);
  return [...ruleTextureFootprint(active), ...ruleOversizedTextures(active)];
}

/** Every mod with something a downscale could act on. */
function withOversized(active: ModEntry[]): ModEntry[] {
  return active.filter((m) => (m.textures?.oversized.length ?? 0) > 0);
}

/**
 * Total decoded texture cost.
 *
 * Unity uploads textures decoded, so PNG compression buys nothing at runtime: a 2048px
 * texture costs 16 MB resident whether it compresses to 4 KB or 4 MB. This is an upper
 * bound rather than live usage, since RimWorld atlases and unloads, but it is the number
 * that decides how much work the atlas builder has and how close the card runs to full.
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
        "Heaviest mods:\n" +
        worst
          .map((m) => `  ${((m.textures?.estimatedVramBytes ?? 0) / GB).toFixed(2)} GB  ${m.name}`)
          .join("\n"),
      packageIds: worst.map((m) => m.packageId),
      fix: {
        kind: "downscale-textures",
        label: `Downscale to ${DOWNSCALE_TARGET_PX}px`,
        tier: 3,
        auto: false,
        // The list above is what a reader can take in; the repair covers every mod with
        // something to resize, so triage is not silently limited to the top of a table.
        params: {
          ids: withOversized(active).map((m) => m.packageId),
          target: String(DOWNSCALE_TARGET_PX),
        },
      },
    },
  ];
}

/**
 * Individual textures far larger than anything the camera can show. These are the cheapest
 * wins in the whole tool: halving a dimension quarters the cost, and at RimWorld's zoom
 * the difference is usually invisible.
 */
function ruleOversizedTextures(active: ModEntry[]): Finding[] {
  const offenders = active
    .filter((m) => (m.textures?.oversized.length ?? 0) > 0)
    .sort((a, b) => (b.textures?.oversized.length ?? 0) - (a.textures?.oversized.length ?? 0))
    .slice(0, 12);
  if (!offenders.length) return [];

  const total = active.reduce((sum, m) => sum + (m.textures?.oversized.length ?? 0), 0);
  const truncated = active.some((m) => m.textures?.truncated);
  const biggest = offenders[0].textures!.oversized[0];

  return [
    {
      id: "oversized-textures",
      rule: "oversized-textures",
      severity: "info",
      title: `${total}${truncated ? "+" : ""} textures at 1024px or larger`,
      detail:
        `The largest is ${biggest.width}x${biggest.height}. RimWorld draws at roughly 64px per tile, ` +
        `so anything past ${DOWNSCALE_TARGET_PX}px is detail the camera never resolves. Halving a ` +
        "dimension quarters what it costs.\n\n" +
        "Most affected:\n" +
        offenders.map((m) => `  ${m.textures!.oversized.length}  ${m.name}`).join("\n"),
      packageIds: offenders.map((m) => m.packageId),
      count: total,
      fix: {
        kind: "downscale-textures",
        label: `Downscale to ${DOWNSCALE_TARGET_PX}px`,
        tier: 3,
        auto: false,
        params: {
          ids: withOversized(active).map((m) => m.packageId),
          target: String(DOWNSCALE_TARGET_PX),
        },
      },
    },
  ];
}

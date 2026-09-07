/** Where a mod's files came from. Drives update behaviour and vault provenance. */
export type ModSource = "official" | "steam" | "local" | "unknown";

export interface ModDependency {
  packageId: string;
  displayName?: string;
}

/** One mod as it exists on disk, independent of whether it is enabled. */
export interface ModEntry {
  packageId: string;
  name: string;
  author?: string;
  /** Absolute folder path the mod was read from. */
  folder: string;
  source: ModSource;
  /** Workshop file id, when the mod came from Steam. */
  steamId?: string;
  supportedVersions: string[];
  /** Author's own description from About.xml, trimmed. */
  description?: string;
  /** Folder mtime as an ISO string: a proxy for when the mod was last updated. */
  updatedAt?: string;
  /** Absolute path to the mod's banner image, when it ships one. */
  previewPath?: string;
  dependencies: ModDependency[];
  incompatibleWith: string[];
  loadAfter: string[];
  loadBefore: string[];
  /** Mod ships compiled C#, so it can Harmony-patch and can fail at runtime. */
  hasAssemblies: boolean;
  /** Mod ships XML PatchOperations, so it can fail at load time. */
  hasPatches: boolean;
  sizeBytes: number;
  /** Texture footprint, when the scan read image headers. */
  textures?: TextureStats;
  /** XML patch operations that target an xpath, when the scan read the Patches folder. */
  patches?: PatchOperation[];
  /**
   * How many PatchOperations the mod ships in total.
   *
   * Separate from `patches.length`, which stops at a cap so the list stays readable. A mod
   * can ship tens of thousands, and reporting the truncated length as the count understated
   * Combat Extended by twenty-eight times.
   */
  patchCount?: number;
  /**
   * Assembly file names this mod ships, lowercased. No paths: the name is what identifies a
   * library, and it is what two mods shipping the same one have in common.
   */
  assemblies?: string[];
  /** Set from ModsConfig.xml, not from the mod folder. */
  active: boolean;
  loadIndex: number | null;
}

/** Public Workshop metadata for one mod, from Steam's anonymous details endpoint. */
export interface WorkshopDetails {
  id: string;
  title: string;
  subscriptions: number;
  favorited: number;
  views: number;
  /** Unix seconds. */
  timeUpdated: number;
  timeCreated: number;
  fileSize: number;
  tags: string[];
}

export interface WorkshopCache {
  fetchedAt: string;
  items: Record<string, WorkshopDetails>;
}

/** One xpath-targeting operation from a mod's Patches folder. */
export interface PatchOperation {
  /** PatchOperationReplace, PatchOperationAdd, a mod-defined class, or unknown. */
  op: string;
  /** Normalised xpath the operation targets. */
  xpath: string;
  /** Patch file, relative to the mod folder. */
  file: string;
}

/** One texture large enough to be worth naming. */
export interface OversizedTexture {
  path: string;
  width: number;
  height: number;
}

export interface TextureStats {
  count: number;
  /**
   * Sum of width x height x 4 across every texture read.
   *
   * Unity uploads decoded textures, so on-disk PNG compression buys nothing at runtime:
   * a 2048px texture costs 16 MB of VRAM whether it compresses to 4 KB or 4 MB. This is
   * why the estimate is computed from dimensions and not from file size.
   */
  estimatedVramBytes: number;
  /** Textures at or above the oversize threshold, largest first. */
  oversized: OversizedTexture[];
  /** True when the walk hit its cap, so the numbers are a floor rather than a total. */
  truncated: boolean;
}

export interface ScanPaths {
  game?: string;
  workshop?: string;
  localMods?: string;
  saveData?: string;
  playerLog?: string;
}

export interface ScanResult {
  scannedAt: string;
  /** Version string from ModsConfig.xml, e.g. "1.6.4871 rev590". */
  gameVersion: string;
  /** Major.minor only, e.g. "1.6". This is what About.xml files match against. */
  gameCycle: string;
  paths: ScanPaths;
  mods: ModEntry[];
  /** packageIds in ModsConfig load order, lowercased. May include ids with no folder. */
  activeOrder: string[];
}

export type Severity = "critical" | "error" | "warning" | "info";

/** How much machinery a repair needs, and how much can go wrong. See docs/SPEC.md. */
export type FixTier = 1 | 2 | 3 | 4;

export interface ProposedFix {
  /** Stable identifier for the repair the engine would perform. */
  kind: string;
  label: string;
  tier: FixTier;
  /** True when the repair is deterministic and needs no human judgement. */
  auto: boolean;
  /**
   * Arguments the repair needs, supplied by the rule that raised the finding. Repairs
   * never re-derive their target by parsing a finding id, so a rule can change how it
   * phrases a finding without silently breaking the repair attached to it.
   */
  params?: Record<string, string | string[]>;
}

export interface Finding {
  id: string;
  /**
   * Set when the scan proves this is no longer true of the install.
   *
   * A session finding is read out of a log of a run that already happened, so it describes
   * the install as it was. Where the current scan can settle it, saying so is far better
   * than offering a repair that would do nothing.
   */
  stale?: string;
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Mods implicated, most-responsible first. */
  packageIds: string[];
  fix?: ProposedFix;
  /**
   * Set when this describes the install rather than reporting a fault with it.
   *
   * A repair being offered does not make something wrong. Patch overrides are how content
   * layers in RimWorld, and twelve of them sat at the top of the Doctor looking like twelve
   * things to fix. Carrying the distinction on the finding keeps the two lists honest without
   * either of them guessing from the severity or from what the repair happens to look like.
   */
  observation?: true;
  /** Times this was observed. Log findings collapse duplicates into a count. */
  count?: number;
  /**
   * Stack frames and Harmony patch annotations for a fault read out of a log. Static
   * findings have no trace, since nothing has executed yet.
   */
  frames?: string[];
  /** Line in the source log where this was first seen. */
  firstLine?: number;
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3,
};

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (b.count ?? 1) - (a.count ?? 1),
  );
}

import type { ModDependency, ModEntry, ModSource } from "../types";
import { dependencyList, stripBlocks, tagList, tagText } from "./xml.ts";

/** Container elements whose children shadow the top-level scalar fields we read. */
const NESTED_BLOCKS = [
  "modDependencies",
  "modDependenciesByVersion",
  "incompatibleWith",
  "incompatibleWithByVersion",
  "loadAfter",
  "loadAfterByVersion",
  "loadBefore",
  "loadBeforeByVersion",
  "descriptionsByVersion",
];

/** Package ids shipped by Ludeon. These must load before any third-party content. */
export const OFFICIAL_PACKAGE_IDS = [
  "ludeon.rimworld",
  "ludeon.rimworld.royalty",
  "ludeon.rimworld.ideology",
  "ludeon.rimworld.biotech",
  "ludeon.rimworld.anomaly",
  "ludeon.rimworld.odyssey",
];

/** Load-order bootstrappers. These rewrite or patch other assemblies, so they go first. */
export const BOOTSTRAP_PACKAGE_IDS = ["zetrith.prepatcher", "brrainz.harmony"];

export interface AboutInput {
  xml: string;
  folder: string;
  source: ModSource;
  steamId?: string;
  hasAssemblies: boolean;
  hasPatches: boolean;
  sizeBytes: number;
  updatedAt?: string;
}

/**
 * Build a ModEntry from an About.xml. RimWorld compares packageIds case-insensitively,
 * so everything id-shaped is lowercased here once and compared raw everywhere else.
 */
export function parseAbout(input: AboutInput): ModEntry | null {
  const { xml } = input;
  // Identity fields come from the document with dependency blocks removed, so a nested
  // packageId can never be mistaken for the mod's own.
  const own = stripBlocks(xml, NESTED_BLOCKS);
  const packageId = tagText(own, "packageId")?.toLowerCase();
  // A mod with no packageId cannot be referenced or ordered, so it is not usable.
  if (!packageId) return null;

  const lower = (ids: string[]) => ids.map((s) => s.toLowerCase());

  return {
    packageId,
    // Ludeon's own About.xml files carry no name tag, and the game falls back to the
    // folder name for them. A Workshop folder is named after its numeric file id, which
    // is no use as a label, so that case falls through to the package id instead.
    name: tagText(own, "name") ?? folderName(input.folder) ?? packageId,
    author: tagText(own, "author") ?? (tagList(own, "authors").join(", ") || undefined),
    folder: input.folder,
    source: OFFICIAL_PACKAGE_IDS.includes(packageId) ? "official" : input.source,
    steamId: input.steamId,
    supportedVersions: tagList(xml, "supportedVersions"),
    // Descriptions run to essays; enough to tell mods apart, not enough to bloat the scan.
    description: trimDescription(tagText(own, "description")),
    updatedAt: input.updatedAt,
    // The two dependency blocks routinely list the same mod, so a raw concat would make
    // every rule that walks dependencies fire twice for one relationship.
    dependencies: dedupeById([
      ...dependencyList(xml, "modDependencies"),
      ...dependencyList(xml, "modDependenciesByVersion"),
    ]),
    incompatibleWith: lower(tagList(xml, "incompatibleWith")),
    // force* is the hard form of the same constraint and Ludeon's Core uses it, so both
    // spellings have to feed the ordering rules or official content sorts wrong.
    loadAfter: lower([...tagList(xml, "loadAfter"), ...tagList(xml, "forceLoadAfter")]),
    loadBefore: lower([...tagList(xml, "loadBefore"), ...tagList(xml, "forceLoadBefore")]),
    hasAssemblies: input.hasAssemblies,
    hasPatches: input.hasPatches,
    sizeBytes: input.sizeBytes,
    active: false,
    loadIndex: null,
  };
}

/** First entry per packageId wins, so the richer displayName from the primary block survives. */
function dedupeById(deps: ModDependency[]): ModDependency[] {
  const seen = new Map<string, ModDependency>();
  for (const dep of deps) {
    const key = dep.packageId.toLowerCase();
    if (!seen.has(key)) seen.set(key, dep);
  }
  return [...seen.values()];
}

/** Collapse the markup and whitespace authors put in descriptions, then cap the length. */
function trimDescription(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = raw
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > 600 ? `${text.slice(0, 600).trimEnd()}...` : text;
}

/** Last path segment, unless it is a Steam Workshop file id, which labels nothing. */
function folderName(folder: string): string | undefined {
  const segment = folder.split(/[\\/]/).filter(Boolean).pop();
  return segment && !/^\d+$/.test(segment) ? segment : undefined;
}

/** Active mod list from ModsConfig.xml, in load order. */
export function parseModsConfig(xml: string): { gameVersion: string; activeOrder: string[] } {
  return {
    gameVersion: tagText(xml, "version") ?? "unknown",
    activeOrder: tagList(xml, "activeMods").map((s) => s.toLowerCase()),
  };
}

/** "1.6.4871 rev590" -> "1.6". About.xml supportedVersions are major.minor only. */
export function gameCycleOf(gameVersion: string): string {
  const m = /^(\d+\.\d+)/.exec(gameVersion.trim());
  return m ? m[1] : "unknown";
}

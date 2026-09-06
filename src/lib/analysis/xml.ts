/**
 * Deliberately tolerant XML readers.
 *
 * A meaningful share of Workshop About.xml files are malformed: stray ampersands, a BOM
 * in the middle of the file, unclosed tags, inconsistent casing. A strict DOMParser
 * rejects the whole document and we lose a mod we could otherwise have read. These
 * extractors pull the few fields we care about and ignore everything else, which also
 * keeps the parsing layer runnable under node for tests.
 */

export interface XmlDependency {
  packageId: string;
  displayName?: string;
}

/** Build the open/close pair for a tag, tolerating attributes and stray whitespace. */
function tagPattern(tag: string): RegExp {
  return new RegExp(String.raw`<${tag}(?:\s[^>]*)?>([\s\S]*?)<\/${tag}\s*>`, "i");
}

const LI_PATTERN = /<li(?:\s[^>]*)?>([\s\S]*?)<\/li\s*>/gi;

/**
 * Remove whole `<tag>...</tag>` blocks.
 *
 * Scalar fields have to be read from a document with the container blocks stripped out.
 * A dependency entry nests its own `<packageId>`, so a mod whose About.xml declares
 * `<modDependencies>` above its own `<packageId>` would otherwise report its dependency's
 * id as its identity, and every mod depending on Harmony would collapse into one entry.
 */
export function stripBlocks(xml: string, tags: string[]): string {
  return tags.reduce(
    (acc, tag) => acc.replace(new RegExp(String.raw`<${tag}(?:\s[^>]*)?>[\s\S]*?<\/${tag}\s*>`, "gi"), ""),
    xml,
  );
}

/** First text value of `tag`, trimmed. Case-insensitive on the tag name. */
export function tagText(xml: string, tag: string): string | undefined {
  const m = tagPattern(tag).exec(xml);
  if (!m) return undefined;
  const value = decodeEntities(m[1]).trim();
  return value.length ? value : undefined;
}

/** `<li>` values inside the first `<tag>` block. Returns [] when the tag is absent. */
export function tagList(xml: string, tag: string): string[] {
  const block = tagPattern(tag).exec(xml);
  if (!block) return [];
  return [...block[1].matchAll(LI_PATTERN)].map((m) => decodeEntities(m[1]).trim()).filter(Boolean);
}

/**
 * Dependency blocks carry a nested packageId, so a flat `<li>` read would return the whole
 * child element. Pull the packageId out and keep the display name when present.
 */
export function dependencyList(xml: string, tag: string): XmlDependency[] {
  const block = tagPattern(tag).exec(xml);
  if (!block) return [];
  return [...block[1].matchAll(LI_PATTERN)]
    .map((m): XmlDependency | null => {
      const packageId = tagText(m[1], "packageId");
      if (!packageId) return null;
      return { packageId, displayName: tagText(m[1], "displayName") };
    })
    .filter((d): d is XmlDependency => d !== null);
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/﻿/g, "");
}

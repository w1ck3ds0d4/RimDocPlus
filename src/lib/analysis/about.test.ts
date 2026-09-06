import { describe, expect, it } from "vitest";
import { gameCycleOf, parseAbout, parseModsConfig } from "./about";
import { stripBlocks, tagList, tagText } from "./xml";

const base = {
  folder: "C:/mods/example",
  source: "steam" as const,
  hasAssemblies: false,
  hasPatches: false,
  sizeBytes: 0,
};

describe("tolerant xml reading", () => {
  it("reads a tag that carries attributes", () => {
    expect(tagText('<name Class="X">Hospitality</name>', "name")).toBe("Hospitality");
  });

  it("survives a stray ampersand that would fail a strict parser", () => {
    expect(tagText("<author>Bob & Jim</author>", "author")).toBe("Bob & Jim");
  });

  it("returns undefined rather than throwing on an unclosed tag", () => {
    expect(tagText("<name>Broken", "name")).toBeUndefined();
  });

  it("decodes entities and CDATA", () => {
    expect(tagText("<name><![CDATA[A &amp; B]]></name>", "name")).toBe("A & B");
  });

  it("strips whole blocks", () => {
    const xml = "<a>1</a><deps><li>x</li></deps><b>2</b>";
    expect(stripBlocks(xml, ["deps"])).toBe("<a>1</a><b>2</b>");
  });

  it("reads list items", () => {
    expect(
      tagList("<supportedVersions><li>1.5</li><li>1.6</li></supportedVersions>", "supportedVersions"),
    ).toEqual(["1.5", "1.6"]);
  });
});

describe("parseAbout", () => {
  it("takes the mod's own packageId, not a dependency's", () => {
    // This ordering is what made 24 unrelated mods collapse into brrainz.harmony.
    const xml = `
      <ModMetaData>
        <modDependencies>
          <li><packageId>brrainz.harmony</packageId><displayName>Harmony</displayName></li>
        </modDependencies>
        <packageId>Author.SmartSpeed</packageId>
        <name>Smart Speed</name>
      </ModMetaData>`;
    const mod = parseAbout({ ...base, xml })!;
    expect(mod.packageId).toBe("author.smartspeed");
    expect(mod.name).toBe("Smart Speed");
    expect(mod.dependencies).toEqual([{ packageId: "brrainz.harmony", displayName: "Harmony" }]);
  });

  it("lowercases every id so comparisons match RimWorld's own", () => {
    const xml = `
      <ModMetaData>
        <packageId>Orion.Hospitality</packageId>
        <name>Hospitality</name>
        <loadAfter><li>Ludeon.RimWorld</li></loadAfter>
        <incompatibleWith><li>Some.Other</li></incompatibleWith>
      </ModMetaData>`;
    const mod = parseAbout({ ...base, xml })!;
    expect(mod.packageId).toBe("orion.hospitality");
    expect(mod.loadAfter).toEqual(["ludeon.rimworld"]);
    expect(mod.incompatibleWith).toEqual(["some.other"]);
  });

  it("marks Ludeon content as official regardless of the folder it was found in", () => {
    const xml =
      "<ModMetaData><packageId>Ludeon.RimWorld.Odyssey</packageId><name>Odyssey</name></ModMetaData>";
    expect(parseAbout({ ...base, xml })!.source).toBe("official");
  });

  it("rejects a mod with no packageId, since it cannot be ordered", () => {
    expect(parseAbout({ ...base, xml: "<ModMetaData><name>Nameless</name></ModMetaData>" })).toBeNull();
  });

  it("lists a dependency once even when both dependency blocks declare it", () => {
    const xml = `
      <ModMetaData>
        <packageId>a.b</packageId>
        <modDependencies>
          <li><packageId>Oskar.VEF</packageId><displayName>Vanilla Expanded Framework</displayName></li>
        </modDependencies>
        <modDependenciesByVersion>
          <li><packageId>oskar.vef</packageId></li>
        </modDependenciesByVersion>
      </ModMetaData>`;
    const deps = parseAbout({ ...base, xml })!.dependencies;
    expect(deps).toHaveLength(1);
    // The primary block wins, so the human-readable name survives the dedupe.
    expect(deps[0].displayName).toBe("Vanilla Expanded Framework");
  });

  it("names official content after its folder, since Ludeon ships no name tag", () => {
    // Verbatim shape of Data/Core/About/About.xml.
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <ModMetaData>
        <packageId>Ludeon.RimWorld</packageId>
        <author>Ludeon Studios</author>
        <forceLoadBefore>
          <li>Ludeon.RimWorld.Ideology</li>
          <li>Ludeon.RimWorld.Royalty</li>
        </forceLoadBefore>
      </ModMetaData>`;
    const mod = parseAbout({ ...base, xml, folder: "C:/RimWorld/Data/Core" })!;
    expect(mod.name).toBe("Core");
    expect(mod.loadBefore).toEqual(["ludeon.rimworld.ideology", "ludeon.rimworld.royalty"]);
  });

  it("falls back to the package id when the folder is a Workshop file id", () => {
    const xml = "<ModMetaData><packageId>a.b</packageId></ModMetaData>";
    expect(parseAbout({ ...base, xml, folder: "C:/workshop/294100/3509486825" })!.name).toBe("a.b");
  });

  it("merges forceLoadAfter into loadAfter", () => {
    const xml = `
      <ModMetaData>
        <packageId>a.b</packageId>
        <loadAfter><li>One.Mod</li></loadAfter>
        <forceLoadAfter><li>Two.Mod</li></forceLoadAfter>
      </ModMetaData>`;
    expect(parseAbout({ ...base, xml })!.loadAfter).toEqual(["one.mod", "two.mod"]);
  });

  it("falls back to the authors list when there is no author tag", () => {
    const xml = `
      <ModMetaData>
        <packageId>a.b</packageId>
        <authors><li>Ann</li><li>Bo</li></authors>
      </ModMetaData>`;
    expect(parseAbout({ ...base, xml })!.author).toBe("Ann, Bo");
  });
});

describe("parseModsConfig", () => {
  it("reads version and load order", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <ModsConfigData>
        <version>1.6.4871 rev590</version>
        <activeMods>
          <li>zetrith.prepatcher</li>
          <li>Brrainz.Harmony</li>
        </activeMods>
      </ModsConfigData>`;
    const result = parseModsConfig(xml);
    expect(result.gameVersion).toBe("1.6.4871 rev590");
    expect(result.activeOrder).toEqual(["zetrith.prepatcher", "brrainz.harmony"]);
  });
});

describe("gameCycleOf", () => {
  it("keeps major.minor only, which is what About.xml matches on", () => {
    expect(gameCycleOf("1.6.4871 rev590")).toBe("1.6");
    expect(gameCycleOf("garbage")).toBe("unknown");
  });
});

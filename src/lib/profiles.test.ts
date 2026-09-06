import { describe, expect, it } from "vitest";
import type { ModEntry } from "./types";
import { diffProfiles, moveMod, setEnabled, sortLoadOrder, toModsConfigXml, toggleMod } from "./profiles";

function mod(packageId: string, over: Partial<ModEntry> = {}): ModEntry {
  return {
    packageId,
    name: packageId,
    folder: `C:/mods/${packageId}`,
    source: "steam",
    supportedVersions: ["1.6"],
    dependencies: [],
    incompatibleWith: [],
    loadAfter: [],
    loadBefore: [],
    hasAssemblies: false,
    hasPatches: false,
    sizeBytes: 0,
    active: true,
    loadIndex: null,
    ...over,
  };
}

function profile(activeOrder: string[]) {
  return {
    id: "p1",
    name: "Test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    gameCycle: "1.6",
    activeOrder,
  };
}

describe("toggleMod", () => {
  it("disables by removing the id", () => {
    const next = toggleMod(profile(["a.one", "b.two"]), "a.one", [mod("a.one"), mod("b.two")]);
    expect(next.activeOrder).toEqual(["b.two"]);
  });

  it("enables a mod after the dependency it declares", () => {
    const mods = [mod("core.lib"), mod("b.two"), mod("a.dependent", { loadAfter: ["core.lib"] })];
    const next = toggleMod(profile(["core.lib", "b.two"]), "a.dependent", mods);
    expect(next.activeOrder.indexOf("a.dependent")).toBeGreaterThan(next.activeOrder.indexOf("core.lib"));
  });

  it("enables Harmony into the bootstrap band, not the end of the list", () => {
    const mods = [mod("brrainz.harmony"), mod("some.mod")];
    const next = toggleMod(profile(["some.mod"]), "brrainz.harmony", mods);
    expect(next.activeOrder).toEqual(["brrainz.harmony", "some.mod"]);
  });

  it("enables an expansion ahead of third-party content", () => {
    const mods = [mod("ludeon.rimworld.odyssey"), mod("some.mod")];
    const next = toggleMod(profile(["some.mod"]), "ludeon.rimworld.odyssey", mods);
    expect(next.activeOrder).toEqual(["ludeon.rimworld.odyssey", "some.mod"]);
  });

  it("bumps updatedAt so the pack list can order by recency", () => {
    const before = profile(["a.one"]);
    expect(toggleMod(before, "a.one", [mod("a.one")]).updatedAt).not.toBe(before.updatedAt);
  });
});

describe("setEnabled", () => {
  it("applies to many mods at once and ignores no-ops", () => {
    const mods = [mod("a.one"), mod("b.two"), mod("c.three")];
    const next = setEnabled(profile(["a.one"]), ["b.two", "c.three", "a.one"], true, mods);
    expect(next.activeOrder).toHaveLength(3);
  });

  it("disables a batch", () => {
    const mods = [mod("a.one"), mod("b.two")];
    expect(setEnabled(profile(["a.one", "b.two"]), ["a.one", "b.two"], false, mods).activeOrder).toEqual([]);
  });
});

describe("moveMod", () => {
  it("moves within bounds and clamps at the edges", () => {
    expect(moveMod(profile(["a", "b", "c"]), "c", -1).activeOrder).toEqual(["a", "c", "b"]);
    expect(moveMod(profile(["a", "b", "c"]), "a", -5).activeOrder).toEqual(["a", "b", "c"]);
    expect(moveMod(profile(["a", "b", "c"]), "c", 5).activeOrder).toEqual(["a", "b", "c"]);
  });

  it("leaves a profile untouched when the mod is not in it", () => {
    const before = profile(["a", "b"]);
    expect(moveMod(before, "zz", 1)).toBe(before);
  });
});

describe("sortLoadOrder", () => {
  it("puts bootstrappers first, then Ludeon content, then the rest", () => {
    const mods = [
      mod("some.mod"),
      mod("ludeon.rimworld"),
      mod("brrainz.harmony"),
      mod("ludeon.rimworld.odyssey"),
      mod("zetrith.prepatcher"),
    ];
    const sorted = sortLoadOrder(
      ["some.mod", "ludeon.rimworld", "brrainz.harmony", "ludeon.rimworld.odyssey", "zetrith.prepatcher"],
      mods,
    );
    expect(sorted).toEqual([
      "zetrith.prepatcher",
      "brrainz.harmony",
      "ludeon.rimworld",
      "ludeon.rimworld.odyssey",
      "some.mod",
    ]);
  });

  it("honours loadAfter", () => {
    const mods = [mod("a.dependent", { loadAfter: ["b.lib"] }), mod("b.lib")];
    expect(sortLoadOrder(["a.dependent", "b.lib"], mods)).toEqual(["b.lib", "a.dependent"]);
  });

  it("honours loadBefore", () => {
    const mods = [mod("a.early", { loadBefore: ["b.late"] }), mod("b.late")];
    expect(sortLoadOrder(["b.late", "a.early"], mods)).toEqual(["a.early", "b.late"]);
  });

  it("treats a declared dependency as an ordering constraint", () => {
    const mods = [mod("a.dependent", { dependencies: [{ packageId: "B.Lib" }] }), mod("b.lib")];
    expect(sortLoadOrder(["a.dependent", "b.lib"], mods)).toEqual(["b.lib", "a.dependent"]);
  });

  it("keeps unconstrained mods in their existing order, so the diff stays small", () => {
    const mods = [mod("c.three"), mod("a.one"), mod("b.two")];
    expect(sortLoadOrder(["c.three", "a.one", "b.two"], mods)).toEqual(["c.three", "a.one", "b.two"]);
  });

  it("never drops a mod when the constraints form a cycle", () => {
    const mods = [mod("a.one", { loadAfter: ["b.two"] }), mod("b.two", { loadAfter: ["a.one"] })];
    const sorted = sortLoadOrder(["a.one", "b.two"], mods);
    expect(sorted).toHaveLength(2);
    expect(new Set(sorted)).toEqual(new Set(["a.one", "b.two"]));
  });

  it("ignores constraints pointing at mods that are not enabled", () => {
    const mods = [mod("a.one", { loadAfter: ["not.enabled"] })];
    expect(sortLoadOrder(["a.one"], mods)).toEqual(["a.one"]);
  });
});

describe("diffProfiles", () => {
  it("separates additions, removals, and reordering", () => {
    expect(diffProfiles(["a", "b"], ["a", "b", "c"])).toEqual({
      added: ["c"],
      removed: [],
      reordered: false,
    });
    expect(diffProfiles(["a", "b"], ["b", "a"])).toEqual({ added: [], removed: [], reordered: true });
    expect(diffProfiles(["a", "b"], ["a"])).toEqual({ added: [], removed: ["b"], reordered: false });
  });

  it("does not call a list reordered when the only change is a removal", () => {
    expect(diffProfiles(["a", "b", "c"], ["a", "c"]).reordered).toBe(false);
  });
});

describe("toModsConfigXml", () => {
  it("renders the file RimWorld reads on launch", () => {
    const xml = toModsConfigXml(["zetrith.prepatcher", "ludeon.rimworld"], "1.6.4871 rev590");
    expect(xml).toContain("<version>1.6.4871 rev590</version>");
    expect(xml).toContain("<li>zetrith.prepatcher</li>");
    expect(xml.indexOf("zetrith.prepatcher")).toBeLessThan(xml.indexOf("ludeon.rimworld"));
  });
});

import { describe, expect, it } from "vitest";
import type { ModEntry, PatchOperation, ScanResult } from "../types";
import { overrideIntent, runPatchRules } from "./patches";

function mod(packageId: string, patches: PatchOperation[], loadIndex: number): ModEntry {
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
    hasPatches: true,
    sizeBytes: 0,
    active: true,
    loadIndex,
    patches,
  };
}

function op(xpath: string, operation = "PatchOperationReplace"): PatchOperation {
  return { op: operation, xpath, file: "Patches/a.xml" };
}

function scanOf(mods: ModEntry[]): ScanResult {
  return {
    scannedAt: "2026-01-01T00:00:00.000Z",
    gameVersion: "1.6.4871 rev590",
    gameCycle: "1.6",
    paths: {},
    mods,
    activeOrder: mods.map((m) => m.packageId),
  };
}

const TARGET = '/Defs/ThingDef[defName="MealSurvivalPack"]/graphicData/texPath';

describe("runPatchRules", () => {
  it("does not blame the later mod when it only added and the earlier one replaced", () => {
    // The same false collision the DESTRUCTIVE list exists to prevent, arriving from the
    // other direction: the pair only required one touch to be destructive, so a mod that
    // merely adds was told it discarded an earlier mod's replacement, with a repair
    // offering to disable it. Disabling it would have removed content and restored nothing.
    const findings = runPatchRules(
      scanOf([
        mod("a.replacer", [op(TARGET, "PatchOperationReplace")], 0),
        mod("b.adder", [op(TARGET, "PatchOperationAdd")], 1),
      ]),
    );
    expect(findings).toHaveLength(0);
  });

  it("still blames the later mod when it is the one that overwrote", () => {
    const findings = runPatchRules(
      scanOf([
        mod("a.adder", [op(TARGET, "PatchOperationAdd")], 0),
        mod("b.replacer", [op(TARGET, "PatchOperationReplace")], 1),
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain("b.replacer overrides");
  });

  it("does not call two mods inserting at one anchor a collision", () => {
    // PatchOperationInsert adds a sibling beside the node it matched and leaves that node
    // alone, so both insertions apply. Reported as an override, it told someone the earlier
    // mod's change was discarded and offered to disable the later mod to get it back.
    const findings = runPatchRules(
      scanOf([
        mod("a.first", [op(TARGET, "PatchOperationInsert")], 0),
        mod("b.second", [op(TARGET, "PatchOperationInsert")], 1),
      ]),
    );
    expect(findings).toHaveLength(0);
  });

  it("reports two mods overwriting the same node", () => {
    const findings = runPatchRules(
      scanOf([mod("a.first", [op(TARGET)], 0), mod("b.second", [op(TARGET)], 1)]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("patch-override");
    expect(findings[0].detail).toContain(TARGET);
  });

  it("names the later mod as the winner, since patches apply in load order", () => {
    const findings = runPatchRules(scanOf([mod("a.early", [op(TARGET)], 0), mod("z.late", [op(TARGET)], 5)]));
    expect(findings[0].packageIds[0]).toBe("z.late");
    expect(findings[0].title).toMatch(/^z\.late overrides/);
  });

  it("treats every overlap as a note, because overriding is how content layers", () => {
    const paths = Array.from({ length: 30 }, (_, i) => op(`/Defs/ThingDef[defName="X${i}"]/label`));
    const findings = runPatchRules(scanOf([mod("a.one", paths, 0), mod("b.two", paths, 1)]));
    expect(findings[0].severity).toBe("info");
    expect(findings[0].count).toBe(30);
  });

  it("ignores two mods that both only add to the same node", () => {
    const add = op(TARGET, "PatchOperationAdd");
    expect(runPatchRules(scanOf([mod("a.one", [add], 0), mod("b.two", [add], 1)]))).toHaveLength(0);
  });

  it("still reports when only one side overwrites", () => {
    const findings = runPatchRules(
      scanOf([
        mod("a.one", [op(TARGET, "PatchOperationAdd")], 0),
        mod("b.two", [op(TARGET, "PatchOperationReplace")], 1),
      ]),
    );
    expect(findings).toHaveLength(1);
  });

  it("does not report a mod colliding with itself", () => {
    expect(runPatchRules(scanOf([mod("a.one", [op(TARGET), op(TARGET)], 0)]))).toHaveLength(0);
  });

  it("ignores xpaths too broad to mean anything", () => {
    expect(
      runPatchRules(scanOf([mod("a.one", [op("/Defs")], 0), mod("b.two", [op("/Defs")], 1)])),
    ).toHaveLength(0);
  });

  it("collapses many shared paths between one pair into a single counted finding", () => {
    const paths = Array.from({ length: 12 }, (_, i) => op(`/Defs/ThingDef[defName="X${i}"]/label`));
    const findings = runPatchRules(scanOf([mod("a.one", paths, 0), mod("b.two", paths, 1)]));
    expect(findings).toHaveLength(1);
    expect(findings[0].count).toBe(12);
  });

  it("stays quiet when mods patch different nodes", () => {
    const findings = runPatchRules(
      scanOf([
        mod("a.one", [op('/Defs/ThingDef[defName="A"]/label')], 0),
        mod("b.two", [op('/Defs/ThingDef[defName="B"]/label')], 1),
      ]),
    );
    expect(findings).toHaveLength(0);
  });

  it("needs at least two patching mods before it says anything", () => {
    expect(runPatchRules(scanOf([mod("a.one", [op(TARGET)], 0)]))).toHaveLength(0);
  });

  it("offers to disable the winner, and never does it unasked", () => {
    // The override is usually the intended behaviour, so the repair exists to be available
    // rather than to be recommended: it names the later mod, and it is never automatic.
    const findings = runPatchRules(scanOf([mod("a.one", [op(TARGET)], 0), mod("b.two", [op(TARGET)], 1)]));
    expect(findings[0].severity).toBe("info");
    expect(findings[0].fix?.kind).toBe("disable-overriding-mod");
    expect(findings[0].fix?.auto).toBe(false);
    // b.two loads later, so b.two is the one whose version takes effect.
    expect(findings[0].fix?.params).toEqual({ overriding: "b.two", overridden: "a.one" });
  });
});

describe("overrideIntent", () => {
  const earlier = mod("a.base", [], 0);

  function later(over: Partial<ModEntry> = {}) {
    return { ...mod("b.later", [], 1), ...over };
  }

  it("reads a declared loadAfter as the strongest evidence", () => {
    expect(overrideIntent(later({ loadAfter: ["a.base"] }), earlier).kind).toBe("declared");
  });

  it("counts a dependency as a declaration", () => {
    expect(overrideIntent(later({ dependencies: [{ packageId: "A.Base" }] }), earlier).kind).toBe("declared");
  });

  it("honours loadBefore declared by the earlier mod", () => {
    const declared = { ...earlier, loadBefore: ["b.later"] };
    expect(overrideIntent(later(), declared).kind).toBe("declared");
  });

  it("reads a load-order instruction in the description, and quotes it", () => {
    // Rustic Meal Retexture says exactly this.
    const result = overrideIntent(
      later({ description: "A simple patch. Load this mod by the end of your mod list. Safe to remove." }),
      earlier,
    );
    expect(result.kind).toBe("documented");
    expect(result.evidence).toBe("Load this mod by the end of your mod list.");
  });

  it("recognises content mods from how their author describes them", () => {
    const result = overrideIntent(later({ description: "A fantasy reimagining of Biotech" }), earlier);
    expect(result.kind).toBe("content");
    expect(result.evidence).toBe("A fantasy reimagining of Biotech");
  });

  it("falls back to the mod name when the description says nothing", () => {
    expect(overrideIntent(later({ name: "Vanilla Plants Expanded" }), earlier).kind).toBe("content");
  });

  it("does not match content language inside a longer word", () => {
    expect(overrideIntent(later({ name: "Zed", description: "expandedness abounds" }), earlier).kind).toBe(
      "assumed",
    );
  });

  it("prefers a declaration over anything the description says", () => {
    const result = overrideIntent(
      later({ loadAfter: ["a.base"], description: "An overhaul. Load this last." }),
      earlier,
    );
    expect(result.kind).toBe("declared");
  });

  it("assumes intent when nothing at all points either way", () => {
    expect(overrideIntent(later({ name: "Zed", description: "does things" }), earlier).kind).toBe("assumed");
  });
});

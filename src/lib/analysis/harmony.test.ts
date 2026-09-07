import { describe, expect, it } from "vitest";
import type { ModEntry } from "../types";
import { findingsFromProbe, type ProbePatch, type ProbeReport } from "./harmony";

function mod(packageId: string, folder: string, name = packageId): ModEntry {
  return {
    packageId,
    name,
    folder,
    source: "steam",
    supportedVersions: ["1.6"],
    dependencies: [],
    incompatibleWith: [],
    loadAfter: [],
    loadBefore: [],
    hasAssemblies: true,
    hasPatches: false,
    sizeBytes: 0,
    active: true,
    loadIndex: null,
  };
}

function patch(over: Partial<ProbePatch> = {}): ProbePatch {
  return {
    assembly: "C:/ws/111/Assemblies/A.dll",
    patchClass: "A.Patch",
    targetType: "Verse.PawnRenderer",
    targetMethod: "DrawEquipment",
    kinds: ["HarmonyPrefix"],
    verdict: "missing-method",
    detail: "",
    movedTo: [],
    ...over,
  };
}

function report(patches: ProbePatch[]): ProbeReport {
  return {
    gameAssemblies: 106,
    gameTypes: 33019,
    assembliesRead: patches.length,
    assembliesUnreadable: [],
    patches,
  };
}

const mods = [mod("a.one", "C:/ws/111", "Mod One"), mod("b.two", "C:/ws/222", "Mod Two")];

describe("findingsFromProbe", () => {
  it("gathers a mod's dead patches into one finding rather than one each", () => {
    const found = findingsFromProbe(
      report([
        patch({ targetMethod: "DrawEquipment" }),
        patch({ targetMethod: "CarryWeaponOpenly" }),
        patch({ targetMethod: "DrawEquipment", patchClass: "A.Other" }),
      ]),
      mods,
      "1.6",
    );

    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].packageIds).toEqual(["a.one"]);
    // Two distinct targets, not three patches: a mod is one thing to decide about.
    expect(found[0].count).toBe(2);
    expect(found[0].title).toContain("Mod One patches 2 methods");
  });

  it("says where a method went when the probe could tell", () => {
    const found = findingsFromProbe(
      report([patch({ targetMethod: "DrawEquipmentAiming", movedTo: ["Verse.PawnRenderUtility"] })]),
      mods,
      "1.6",
    );
    expect(found[0].detail).toContain("is now on Verse.PawnRenderUtility");
  });

  it("keeps a guarded patch out of the errors", () => {
    // The class has a Harmony Prepare(), so the mod decides at runtime whether to apply it.
    // Calling that broken would be blaming a mod for handling the case correctly.
    const found = findingsFromProbe(report([patch({ verdict: "missing-method-guarded" })]), mods, "1.6");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("info");
    expect(found[0].rule).toBe("harmony-guarded-target");
  });

  it("says nothing about patches that resolve, or that target another mod", () => {
    const found = findingsFromProbe(
      report([patch({ verdict: "ok" }), patch({ verdict: "foreign-type" })]),
      mods,
      "1.6",
    );
    expect(found).toEqual([]);
  });

  it("admits how much it could not check", () => {
    const found = findingsFromProbe(
      report([patch({ verdict: "ok" }), patch({ verdict: "runtime-only" })]),
      mods,
      "1.6",
    );
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe("harmony-coverage");
    expect(found[0].detail).toContain("1 patches name their target in metadata");
  });

  it("attributes a nested mod folder to the nearer mod", () => {
    // Longest prefix wins. Without that, a mod inside another's folder is credited to
    // whichever happened to be looked at first, which is a coin toss.
    const nested = [mod("outer", "C:/ws/111"), mod("inner", "C:/ws/111/Inner")];
    const found = findingsFromProbe(
      report([patch({ assembly: "C:/ws/111/Inner/Assemblies/A.dll" })]),
      nested,
      "1.6",
    );
    expect(found[0].packageIds).toEqual(["inner"]);
  });

  it("matches a path whatever slashes it arrived with", () => {
    const found = findingsFromProbe(
      report([patch({ assembly: "C:\\ws\\111\\Assemblies\\A.dll" })]),
      mods,
      "1.6",
    );
    expect(found[0].packageIds).toEqual(["a.one"]);
  });

  it("ignores an assembly belonging to no installed mod", () => {
    const found = findingsFromProbe(report([patch({ assembly: "C:/elsewhere/A.dll" })]), mods, "1.6");
    expect(found).toEqual([]);
  });
});

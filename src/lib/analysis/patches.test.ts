import { describe, expect, it } from "vitest";
import type { ModEntry, PatchOperation, ScanResult } from "../types";
import { runPatchRules } from "./patches";

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
  it("reports two mods overwriting the same node", () => {
    const findings = runPatchRules(
      scanOf([mod("a.first", [op(TARGET)], 0), mod("b.second", [op(TARGET)], 1)]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("patch-collision");
    expect(findings[0].detail).toContain(TARGET);
  });

  it("names the later mod as the winner, since patches apply in load order", () => {
    const findings = runPatchRules(scanOf([mod("a.early", [op(TARGET)], 0), mod("z.late", [op(TARGET)], 5)]));
    // Most-responsible first: the mod whose version survives.
    expect(findings[0].packageIds[0]).toBe("z.late");
    expect(findings[0].title).toMatch(/^z\.late overwrites/);
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
    // Enough shared targets stops being a curiosity and starts being a problem.
    expect(findings[0].severity).toBe("warning");
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
});

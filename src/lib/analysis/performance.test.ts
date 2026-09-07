import { describe, expect, it } from "vitest";
import { DEFAULT_OVERSIZE_PX, oversizedAt, runPerformanceRules } from "./performance";
import { planRepair } from "../repair/repairs";
import type { ModEntry, OversizedTexture, ScanResult } from "../types";
import type { Modpack } from "../modpacks";

function texture(px: number, i: number): OversizedTexture {
  return { path: `C:/mods/a/Textures/t${i}.png`, width: px, height: px };
}

/** One mod carrying textures at each of the sizes the scan now records. */
function mod(sizes: number[]): ModEntry {
  return {
    packageId: "a.one",
    name: "A",
    folder: "C:/mods/a",
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
    loadIndex: 0,
    textures: {
      count: sizes.length,
      // Comfortably past the 4 GB floor so the footprint rule always reports.
      estimatedVramBytes: 9 * 1024 ** 3,
      oversized: sizes.map(texture),
      truncated: false,
    },
  };
}

function scanOf(mods: ModEntry[]): ScanResult {
  return {
    scannedAt: "2026-01-01T00:00:00.000Z",
    gameVersion: "1.6.4871 rev590",
    gameCycle: "1.6",
    paths: { saveData: "C:/save" },
    mods,
    activeOrder: mods.map((m) => m.packageId),
  };
}

const SIZES = [2048, 1024, 768, 600, 513];

describe("oversizedAt", () => {
  it("counts only what meets the threshold, whatever the scan recorded", () => {
    const m = mod(SIZES);
    expect(oversizedAt(m, 1024).map((t) => t.width)).toEqual([2048, 1024]);
    expect(oversizedAt(m, 768).map((t) => t.width)).toEqual([2048, 1024, 768]);
    expect(oversizedAt(m, 513).map((t) => t.width)).toEqual(SIZES);
  });

  it("matches on either dimension, since one long side is enough to cost", () => {
    const wide: ModEntry = {
      ...mod([]),
      textures: {
        count: 1,
        estimatedVramBytes: 0,
        oversized: [{ path: "p", width: 200, height: 1600 }],
        truncated: false,
      },
    };
    expect(oversizedAt(wide, 1024)).toHaveLength(1);
  });
});

describe("the oversize rule", () => {
  const findingsAt = (px: number) =>
    runPerformanceRules(scanOf([mod(SIZES)]), { oversizePx: px }).find(
      (f) => f.rule === "oversized-textures",
    );

  it("reports and titles itself by the chosen threshold", () => {
    expect(findingsAt(1024)?.title).toBe("2 textures at 1024px or larger");
    expect(findingsAt(513)?.title).toBe("5 textures at 513px or larger");
  });

  it("says nothing when the threshold is above everything recorded", () => {
    expect(findingsAt(4096)).toBeUndefined();
  });

  it("hands the repair the threshold rather than letting it re-derive one", () => {
    expect(findingsAt(768)?.fix?.params?.threshold).toBe("768");
  });

  it("defaults to 1024 so the setting only ever widens what is reported", () => {
    const byDefault = runPerformanceRules(scanOf([mod(SIZES)])).find((f) => f.rule === "oversized-textures");
    expect(byDefault?.title).toBe(`2 textures at ${DEFAULT_OVERSIZE_PX}px or larger`);
  });
});

/**
 * The footprint is a fact about how much art the list has, not a defect. It once carried the
 * oversize rule's own repair, which promised a fix it could not deliver and made the report
 * list the same files twice under two findings.
 */
describe("the footprint rule", () => {
  it("reports the total and offers no repair", () => {
    const finding = runPerformanceRules(scanOf([mod(SIZES)])).find((f) => f.rule === "texture-footprint");
    expect(finding?.title).toContain("GB of decoded texture data");
    expect(finding?.fix).toBeUndefined();
  });
});

describe("the downscale plan", () => {
  const modpack: Modpack = {
    id: "p1",
    name: "Test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    gameCycle: "1.6",
    activeOrder: ["a.one"],
  };

  const actionsAt = (px: number) => {
    const scan = scanOf([mod(SIZES)]);
    const finding = runPerformanceRules(scan, { oversizePx: px }).find(
      (f) => f.rule === "oversized-textures",
    )!;
    const plan = planRepair({ scan, modpack, finding });
    return plan?.kind === "files" ? plan.actions : [];
  };

  it("covers exactly the textures the finding counted, never the whole recorded list", () => {
    expect(actionsAt(1024)).toHaveLength(2);
    expect(actionsAt(768)).toHaveLength(3);
    expect(actionsAt(513)).toHaveLength(5);
  });

  it("resizes to the target rather than to the threshold", () => {
    for (const action of actionsAt(1024)) {
      expect(action.op).toBe("downscale-png");
      if (action.op === "downscale-png") expect(action.maxPx).toBe(512);
    }
  });
});

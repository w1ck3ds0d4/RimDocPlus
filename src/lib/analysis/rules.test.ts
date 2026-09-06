import { describe, expect, it } from "vitest";
import { runStaticRules } from "./rules";
import { analyzeLog, findingsFromLog } from "./logParser";
import type { ModEntry, ScanResult } from "../types";

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

function scanOf(mods: ModEntry[], activeOrder: string[]): ScanResult {
  return {
    scannedAt: "2026-01-01T00:00:00.000Z",
    gameVersion: "1.6.4871 rev590",
    gameCycle: "1.6",
    paths: {},
    mods,
    activeOrder,
  };
}

function rules(scan: ScanResult, rule: string) {
  return runStaticRules(scan).filter((f) => f.rule === rule);
}

describe("orphan-active", () => {
  it("reports enabled ids with no folder on disk", () => {
    const scan = scanOf([mod("a.one")], ["a.one", "b.missing"]);
    const [finding] = rules(scan, "orphan-active");
    expect(finding.packageIds).toEqual(["b.missing"]);
    expect(finding.severity).toBe("critical");
  });

  it("stays quiet when every enabled mod is present", () => {
    expect(rules(scanOf([mod("a.one")], ["a.one"]), "orphan-active")).toHaveLength(0);
  });
});

describe("duplicate-package-id", () => {
  it("reports one finding per colliding id, not per folder", () => {
    const scan = scanOf(
      [mod("orion.hospitality", { folder: "C:/ws/1" }), mod("orion.hospitality", { folder: "C:/ws/2" })],
      ["orion.hospitality"],
    );
    const found = rules(scan, "duplicate-package-id");
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain("C:/ws/2");
  });
});

describe("dlc-after-mods", () => {
  it("flags an expansion loading behind third-party content", () => {
    const scan = scanOf(
      [mod("ludeon.rimworld"), mod("ludeon.rimworld.odyssey"), mod("some.mod")],
      ["ludeon.rimworld", "some.mod", "ludeon.rimworld.odyssey"],
    );
    const [finding] = rules(scan, "dlc-after-mods");
    expect(finding.packageIds).toEqual(["ludeon.rimworld.odyssey"]);
  });

  it("accepts the canonical order", () => {
    const scan = scanOf(
      [mod("ludeon.rimworld"), mod("ludeon.rimworld.odyssey"), mod("some.mod")],
      ["ludeon.rimworld", "ludeon.rimworld.odyssey", "some.mod"],
    );
    expect(rules(scan, "dlc-after-mods")).toHaveLength(0);
  });
});

describe("bootstrap-position", () => {
  it("flags Harmony loading behind a code mod", () => {
    const scan = scanOf(
      [mod("brrainz.harmony"), mod("code.mod", { hasAssemblies: true })],
      ["code.mod", "brrainz.harmony"],
    );
    expect(rules(scan, "bootstrap-position")).toHaveLength(1);
  });

  it("ignores XML-only mods ahead of Harmony, which cannot patch a runtime", () => {
    const scan = scanOf(
      [mod("brrainz.harmony"), mod("xml.mod", { hasPatches: true })],
      ["xml.mod", "brrainz.harmony"],
    );
    expect(rules(scan, "bootstrap-position")).toHaveLength(0);
  });
});

describe("dependencies", () => {
  it("separates a missing dependency from a merely disabled one", () => {
    const installedButOff = scanOf(
      [mod("a.one", { dependencies: [{ packageId: "b.two" }] }), mod("b.two", { active: false })],
      ["a.one"],
    );
    expect(rules(installedButOff, "inactive-dependency")).toHaveLength(1);
    expect(rules(installedButOff, "missing-dependency")).toHaveLength(0);

    const absent = scanOf([mod("a.one", { dependencies: [{ packageId: "b.two" }] })], ["a.one"]);
    expect(rules(absent, "missing-dependency")).toHaveLength(1);
    expect(rules(absent, "inactive-dependency")).toHaveLength(0);
  });
});

describe("incompatible-pair", () => {
  it("reports a one-sided declaration exactly once", () => {
    const scan = scanOf(
      [mod("a.one", { incompatibleWith: ["b.two"] }), mod("b.two", { incompatibleWith: ["a.one"] })],
      ["a.one", "b.two"],
    );
    expect(rules(scan, "incompatible-pair")).toHaveLength(1);
  });

  it("ignores an incompatibility with a mod that is not enabled", () => {
    const scan = scanOf([mod("a.one", { incompatibleWith: ["b.two"] })], ["a.one"]);
    expect(rules(scan, "incompatible-pair")).toHaveLength(0);
  });
});

describe("load-order-violation", () => {
  it("catches loadAfter and loadBefore in both directions", () => {
    const after = scanOf([mod("a.one", { loadAfter: ["b.two"] }), mod("b.two")], ["a.one", "b.two"]);
    expect(rules(after, "load-order-violation")).toHaveLength(1);

    const before = scanOf([mod("a.one", { loadBefore: ["b.two"] }), mod("b.two")], ["b.two", "a.one"]);
    expect(rules(before, "load-order-violation")).toHaveLength(1);
  });
});

describe("version-mismatch", () => {
  it("collapses every stale mod into one finding with a count", () => {
    const scan = scanOf(
      [mod("a.one", { supportedVersions: ["1.5"] }), mod("b.two", { supportedVersions: ["1.4"] })],
      ["a.one", "b.two"],
    );
    const [finding] = rules(scan, "version-mismatch");
    expect(finding.count).toBe(2);
  });

  it("never flags official content", () => {
    const scan = scanOf(
      [mod("ludeon.rimworld", { source: "official", supportedVersions: ["1.5"] })],
      ["ludeon.rimworld"],
    );
    expect(rules(scan, "version-mismatch")).toHaveLength(0);
  });

  it("says nothing about a mod that declares no versions at all", () => {
    expect(
      rules(scanOf([mod("a.one", { supportedVersions: [] })], ["a.one"]), "version-mismatch"),
    ).toHaveLength(0);
  });
});

describe("log analysis", () => {
  const log = [
    "Initialize engine version: 2022.3.35f1 (011206c7a712)",
    "    Renderer: NVIDIA GeForce RTX 4070 Laptop GPU (ID=0x2860)",
    "    VRAM:     7948 MB",
    "RimWorld 1.6.4871 rev591",
    "Fallback handler could not load library C:/x/y.dll",
    "Fallback handler could not load library C:/x/z.dll",
    "Created WorkshopItem for 3092936341 but there is no folder for it.",
    "Tried loading mod with the same packageId multiple times: Orion.Hospitality. Ignoring the duplicates.",
    "Prepatcher: Serializing took 2254.4194ms",
    "Error while instantiating a mod of type MedievalOverhaul.MedievalOverhaulSettings: System.Exception",
    "  at MedievalOverhaul.Settings.Init () [0x00000] in <x>:0",
  ].join("\n");

  it("scrapes the environment header", () => {
    const env = analyzeLog(log).environment;
    expect(env.gameVersion).toBe("1.6.4871 rev591");
    expect(env.vramMb).toBe(7948);
    expect(env.unityVersion).toBe("2022.3.35f1");
  });

  it("drops Unity's fallback-handler noise", () => {
    expect(analyzeLog(log).events.some((e) => e.message.includes("Fallback handler"))).toBe(false);
  });

  it("collapses repeats of the same fault into one counted event", () => {
    const spam = Array(50).fill("Created WorkshopItem for 123 but there is no folder for it.").join("\n");
    const events = analyzeLog(spam).events;
    expect(events).toHaveLength(1);
    expect(events[0].count).toBe(50);
  });

  it("reads startup timings and orders them by cost", () => {
    expect(analyzeLog(log).timings[0]).toEqual({ label: "Prepatcher: Serializing", ms: 2254.4194 });
  });

  it("attributes a stack trace back to the mod that owns the namespace", () => {
    const mods = [mod("dankpyon.medieval.overhaul", { name: "Medieval Overhaul" })];
    const findings = findingsFromLog(analyzeLog(log), mods);
    const initFailure = findings.find((f) => f.rule === "log:mod-init-failure");
    expect(initFailure?.packageIds).toContain("dankpyon.medieval.overhaul");
  });

  it("explains a recognised condition instead of echoing the raw line", () => {
    const findings = findingsFromLog(analyzeLog(log), []);
    const ghost = findings.find((f) => f.rule === "log:ghost-subscription");
    expect(ghost?.title).toBe("Subscribed Workshop items never downloaded");
  });
});

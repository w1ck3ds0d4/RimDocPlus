import { describe, expect, it } from "vitest";
import { runStaticRules } from "./rules";
import { analyzeLog, findingsFromLog, frameKind } from "./logParser";
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

describe("dependency alternatives", () => {
  // MultiFloors declares zetrith.prepatcher and jikulopo.prepatcher, both named
  // "Prepatcher": the same mod under two package ids after a reupload.
  const alternatives = [
    { packageId: "zetrith.prepatcher", displayName: "Prepatcher" },
    { packageId: "jikulopo.prepatcher", displayName: "Prepatcher" },
  ];

  it("is satisfied when any one alternative is installed and enabled", () => {
    const scan = scanOf(
      [mod("a.needs", { dependencies: alternatives }), mod("zetrith.prepatcher")],
      ["zetrith.prepatcher", "a.needs"],
    );
    expect(rules(scan, "missing-dependency")).toHaveLength(0);
    expect(rules(scan, "inactive-dependency")).toHaveLength(0);
  });

  it("reports one finding naming every alternative when none is installed", () => {
    const scan = scanOf([mod("a.needs", { dependencies: alternatives })], ["a.needs"]);
    const found = rules(scan, "missing-dependency");
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain("zetrith.prepatcher");
    expect(found[0].detail).toContain("jikulopo.prepatcher");
  });

  it("points the enable fix at the alternative that is actually on disk", () => {
    const scan = scanOf(
      [mod("a.needs", { dependencies: alternatives }), mod("jikulopo.prepatcher")],
      ["a.needs"],
    );
    const [finding] = rules(scan, "inactive-dependency");
    expect(finding.fix?.params?.dependency).toBe("jikulopo.prepatcher");
  });

  it("keeps genuinely separate dependencies separate", () => {
    const scan = scanOf(
      [
        mod("a.needs", {
          dependencies: [
            { packageId: "one.lib", displayName: "One" },
            { packageId: "two.lib", displayName: "Two" },
          ],
        }),
      ],
      ["a.needs"],
    );
    expect(rules(scan, "missing-dependency")).toHaveLength(2);
  });

  it("does not group entries that carry no display name", () => {
    const scan = scanOf(
      [mod("a.needs", { dependencies: [{ packageId: "one.lib" }, { packageId: "two.lib" }] })],
      ["a.needs"],
    );
    expect(rules(scan, "missing-dependency")).toHaveLength(2);
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
  // Shaped verbatim on a real 1.6 crash log: a [Ref] tag between the message and its
  // trace, a native wrapper frame carrying "Exception" in its own signature, an
  // inner-exception separator, and a HugsLib patch annotation.
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
    "Error while instantiating a mod of type MedievalOverhaul.MedievalOverhaulSettings: System.Reflection.TargetInvocationException: Exception has been thrown",
    "[Ref 707A92AF]",
    "(wrapper managed-to-native) System.Reflection.RuntimeMethodInfo.InternalInvoke(System.Reflection.RuntimeMethodInfo,object,object[],System.Exception&)",
    "  at System.Reflection.Assembly.GetTypes () [0x00000] in <51fded79cd284d4d911c5949aff4cb21>:0 ",
    "  at MedievalOverhaul.Settings.Init () [0x00021] in <61e4173561894da49d210260257b5097>:0 ",
    "   --- End of inner exception stack trace ---",
    "    - POSTFIX UnlimitedHugs.HugsLib: Void HugsLib.Patches.PlayDataLoader_Patch:InitModsHook()",
    "Caught exception while loading play data but there are active mods other than Core. Resetting mods config and trying again.",
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

  it("captures the trace across the [Ref] tag that separates it from the message", () => {
    const init = analyzeLog(log).events.find((e) => e.category === "mod-init-failure")!;
    expect(init.frames).toHaveLength(5);
    expect(init.frames[0]).toMatch(/^\(wrapper managed-to-native\)/);
    expect(init.frames.some((f) => f.startsWith("at MedievalOverhaul."))).toBe(true);
  });

  it("never reports a trace line as its own error", () => {
    // "(wrapper ...System.Exception&)" matches the generic exception matcher on its own,
    // which is what produced phantom "Unhandled exception" rows before frames were consumed.
    const events = analyzeLog(log).events;
    expect(events.filter((e) => e.category === "exception")).toHaveLength(0);
    expect(events.some((e) => e.message.startsWith("(wrapper"))).toBe(false);
    expect(events.some((e) => e.message.startsWith("at "))).toBe(false);
  });

  it("recognises the mod-config reset, which silently wipes a load order", () => {
    const findings = findingsFromLog(analyzeLog(log), []);
    const reset = findings.find((f) => f.rule === "log:playdata-reset");
    expect(reset?.severity).toBe("critical");
    expect(reset?.title).toBe("RimWorld reset your mod list after a load failure");
  });

  describe("the duplicate-load complaint", () => {
    const DUP =
      "Tried loading mod with the same packageId multiple times: Orion.Hospitality. " +
      "Ignoring the duplicates.";

    const dupFinding = (mods: ModEntry[]) =>
      findingsFromLog(analyzeLog(DUP), mods).find((f) => f.rule === "log:duplicate-package-id");

    /**
     * A package id contains dots, and so does the end of the sentence it sits in. Reading it
     * lazily stopped at the first one and produced "orion", which matches no installed mod,
     * so the finding was titled with half an id and its repair could never find a target.
     */
    it("reads the whole package id, not up to its first dot", () => {
      expect(dupFinding([])?.title).toBe("Duplicate mod loaded: Orion.Hospitality");
      expect(dupFinding([])?.fix?.params?.packageId).toBe("orion.hospitality");
    });

    it("calls it settled when exactly one copy is installed now", () => {
      const finding = dupFinding([mod("orion.hospitality")]);
      expect(finding?.stale).toContain("orion.hospitality");
    });

    it("still reports it while two copies remain", () => {
      const both = [
        mod("orion.hospitality", { folder: "C:/ws/1" }),
        mod("orion.hospitality", { folder: "C:/ws/2" }),
      ];
      expect(dupFinding(both)?.stale).toBeUndefined();
    });

    /** No copies is not proof of a fix: the id may simply be one this parser misread. */
    it("claims nothing when the id matches no installed mod", () => {
      expect(dupFinding([mod("something.else")])?.stale).toBeUndefined();
    });
  });

  describe("the ghost-subscription complaint", () => {
    const GHOST = "Created WorkshopItem for 3092936341 but there is no folder for it.";

    const ghost = (mods: ModEntry[]) =>
      findingsFromLog(analyzeLog(GHOST), mods).find((f) => f.rule === "log:ghost-subscription");

    it("stands while nothing carrying that file id is installed", () => {
      expect(ghost([mod("other.mod", { steamId: "999" })])?.stale).toBeUndefined();
    });

    /** Resubscribing is meant to make the folder arrive; the scan finding it is the proof. */
    it("is settled once the download has arrived", () => {
      const arrived = [mod("cabbage.rimcities", { name: "RimCities", steamId: "3092936341" })];
      expect(ghost(arrived)?.stale).toContain("RimCities");
    });
  });

  it("attributes a stack trace back to the mod that owns the namespace", () => {
    const mods = [mod("dankpyon.medieval.overhaul", { name: "Medieval Overhaul" })];
    const findings = findingsFromLog(analyzeLog(log), mods);
    const initFailure = findings.find((f) => f.rule === "log:mod-init-failure");
    expect(initFailure?.packageIds).toContain("dankpyon.medieval.overhaul");
  });

  it("attributes via a Harmony patch annotation, which names the mod outright", () => {
    const init = analyzeLog(log).events.find((e) => e.category === "mod-init-failure")!;
    expect(init.namespaces).toContain("HugsLib");

    const mods = [mod("unlimitedhugs.hugslib", { name: "HugsLib" })];
    const findings = findingsFromLog(analyzeLog(log), mods);
    expect(findings.find((f) => f.rule === "log:mod-init-failure")?.packageIds).toContain(
      "unlimitedhugs.hugslib",
    );
  });

  it("ignores engine namespaces when attributing", () => {
    const init = analyzeLog(log).events.find((e) => e.category === "mod-init-failure")!;
    expect(init.namespaces).not.toContain("System");
    expect(init.namespaces).toContain("MedievalOverhaul");
  });

  it("carries the trace and its log position onto the finding", () => {
    const findings = findingsFromLog(analyzeLog(log), []);
    const initFailure = findings.find((f) => f.rule === "log:mod-init-failure")!;
    expect(initFailure.frames).toHaveLength(5);
    expect(initFailure.firstLine).toBe(10);
  });

  it("explains a recognised condition instead of echoing the raw line", () => {
    const findings = findingsFromLog(analyzeLog(log), []);
    const ghost = findings.find((f) => f.rule === "log:ghost-subscription");
    expect(ghost?.title).toBe("Subscribed Workshop items never downloaded");
  });

  it("titles an unrecognised fault with its exception type and location", () => {
    const unknown = [
      "Something went sideways: System.NullReferenceException: Object reference not set",
      "[Ref ABCD1234]",
      "  at SomeMod.Thing.Tick () [0x00000] in <x>:0 ",
    ].join("\n");
    const findings = findingsFromLog(analyzeLog(unknown), []);
    expect(findings[0].title).toBe("NullReferenceException in SomeMod");
  });
});

describe("frameKind", () => {
  it("separates mod frames from engine plumbing", () => {
    expect(frameKind("at MedievalOverhaul.Settings.Init ()")).toBe("mod");
    expect(frameKind("at Verse.LoadedModManager.CreateModClasses ()")).toBe("framework");
    expect(frameKind("at HarmonyLib.PatchClassProcessor.Patch ()")).toBe("framework");
    expect(frameKind("- POSTFIX UnlimitedHugs.HugsLib: Void Hook()")).toBe("patch");
    expect(frameKind("(wrapper managed-to-native) System.Reflection.Assembly.GetTypes()")).toBe("separator");
    expect(frameKind("--- End of inner exception stack trace ---")).toBe("separator");
  });
});

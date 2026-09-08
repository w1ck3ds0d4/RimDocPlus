import { describe, expect, it } from "vitest";
import { runStaticRules } from "./rules";
import { analyzeLog, findingsFromLog, frameKind, patchFrames } from "./logParser";
import type { ModEntry, ScanResult } from "../types";

/** A real newline, built so no escaping layer between here and the file can eat it. */
const NEWLINE = String.fromCharCode(10);

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

describe("ruleLoadLast", () => {
  const asks = (text: string) => ({ description: text });
  const run = (mods: ModEntry[]) =>
    rules(
      scanOf(
        mods,
        mods.map((m) => m.packageId),
      ),
      "load-last-position",
    );
  const filler = (n: number) => Array.from({ length: n }, (_, i) => mod(`filler.${i}`));

  it("reads the instruction out of the author's own words", () => {
    // Both real phrasings from the reference install. The second names the mod and never
    // says "load" at all, which is how the one mod that most needs to be last was missed.
    const first = mod("a.retexture", asks("Load this mod by the end of your mod list."));
    const second = mod("b.perf", {
      ...asks("MissileGirl should be the last mod in your mod list."),
      name: "Missile Girl",
    });
    const found = run([first, second, ...filler(20)]);
    expect(found).toHaveLength(2);
    expect(found[1].title).toBe("Missile Girl asks to load last, and 20 mods load after it");
  });

  it("quotes the sentence, so the reader can judge it rather than trust it", () => {
    const found = run([
      mod("a.one", asks("Adds a thing. Load this mod at the end of your list. Safe mid-save.")),
      ...filler(20),
    ]);
    expect(found[0].detail).toContain("Load this mod at the end of your list.");
  });

  it("says nothing about a mod that is already near the end", () => {
    const found = run([...filler(20), mod("z.last", asks("Load this mod last."))]);
    expect(found).toHaveLength(0);
  });

  it("does not count other mods that were also told to be last", () => {
    // Two authors both claiming the end is a disagreement between them, not a mistake by
    // the reader, and blaming whichever lost would be inventing a winner.
    const found = run([
      mod("a.one", asks("Load this mod last.")),
      ...filler(20),
      mod("y.also", asks("Load this mod last.")),
      mod("z.also", asks("Load this mod last.")),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain("20 mods load after it");
  });

  it("ignores a description that merely mentions loading", () => {
    expect(run([mod("a.one", asks("Loads new textures for meals.")), ...filler(20)])).toHaveLength(0);
    expect(run([mod("a.one", asks("Load order does not matter.")), ...filler(20)])).toHaveLength(0);
  });
});

describe("ruleDuplicateDefs", () => {
  const defs = (n: number, prefix = "D") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const dupes = (mods: ModEntry[]) =>
    rules(
      scanOf(
        mods,
        mods.map((m) => m.packageId),
      ),
      "duplicate-defs",
    );

  it("reports a mod that declares nothing another does not", () => {
    // Two versions of one mod published as separate Workshop items, which is the real case
    // this was written for: RimWorld keeps one def per name and drops the other, silently.
    const found = dupes([
      mod("author.complete", { name: "Complete", defNames: defs(25), loadIndex: 0 }),
      mod("author.missions", { name: "Missions", defNames: defs(20), loadIndex: 1 }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe("Missions declares nothing Complete does not");
    expect(found[0].count).toBe(20);
    // Named from the contained side, and reported once rather than once per direction.
    expect(found[0].packageIds).toEqual(["author.missions", "author.complete"]);
  });

  it("says nothing about mods that merely overlap", () => {
    // Twenty-one active pairs in the reference install share defNames on purpose. An
    // expansion redefining what it expands is the system working.
    const partial = defs(20).slice(0, 19).concat(["OwnThing"]);
    expect(
      dupes([mod("a.big", { defNames: defs(25) }), mod("b.overlapping", { defNames: partial })]),
    ).toHaveLength(0);
  });

  it("says nothing about a mod redefining vanilla, which is how mods work", () => {
    // The rule's first run reported EdB Prepare Carefully as a duplicate of Core for
    // redefining twenty-six of its defs. That is the mod working.
    expect(
      dupes([
        mod("ludeon.rimworld", { name: "Core", source: "official", defNames: defs(4493) }),
        mod("edb.preparecarefully", { defNames: defs(26) }),
      ]),
    ).toHaveLength(0);
  });

  it("ignores an overlap too small to mean anything", () => {
    // Two mods happening to name four defs the same way says nothing about either.
    expect(dupes([mod("a.big", { defNames: defs(25) }), mod("b.tiny", { defNames: defs(4) })])).toHaveLength(
      0,
    );
  });
});

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

  // Verbatim from a real 225-mod session, which is the only place this shape shows up:
  // RimWorld writes where it happened and what was thrown on two lines, tags the pair with
  // its own id, and writes "see ref for original" instead of the trace on every repeat.
  const refLog = [
    "Error in PostExposeData of Verse.BackCompatibilityConverter_Universal",
    "System.NullReferenceException: Object reference not set to an instance of an object",
    "[Ref F049DDD8]",
    "  at Verse.Find.get_FactionManager () [0x00005] in <61e4> :0 ",
    "  at RimWorld.Faction.get_OfPlayerSilentFail () [0x00020] in <61e4> :0 ",
    "Error while determining if VGE_Hunter1482798 should have Need MechEnergy: System.NullReferenceException: Object reference not set to an instance of an object",
    "[Ref 32B12C5D]",
    "  at RimWorld.Pawn_NeedsTracker.ShouldHaveNeed (RimWorld.NeedDef nd) [0x000d1] in <61e4> :0 ",
    "    - PREFIX Orion.Hospitality: Boolean Hospitality.Patches.Pawn_NeedsTracker_Patch+ShouldHaveNeed:Prefix()",
    "Error in PostExposeData of Verse.BackCompatibilityConverter_Universal",
    "System.NullReferenceException: Object reference not set to an instance of an object",
    "[Ref F049DDD8] Duplicate stacktrace, see ref for original",
    "Error while determining if VGE_Astropede1482801 should have Need MechEnergy: System.NullReferenceException: Object reference not set to an instance of an object",
    "[Ref 32B12C5D] Duplicate stacktrace, see ref for original",
  ].join(NEWLINE);

  it("takes RimWorld's word for which faults are the same one", () => {
    // Two faults, four occurrences. Read from the text alone this was five rows: the two
    // header lines and the two exception lines counted separately, and the second VGE pawn
    // splitting off because its message names a different creature.
    const events = analyzeLog(refLog).events;
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.count).sort()).toEqual([2, 2]);
  });

  it("keeps where it happened and what was thrown as one fault", () => {
    const first = analyzeLog(refLog).events[0];
    expect(first.message).toContain("PostExposeData");
    expect(first.message).toContain("NullReferenceException");
    expect(first.exceptionType).toBe("NullReferenceException");
  });

  it("gives a repeat that arrived without a trace the one its original had", () => {
    // The repeats carry "see ref for original" and no frames at all. Grouping them with the
    // original is what puts the blame on all of them: it was on one occurrence in three.
    const vge = analyzeLog(refLog).events.find((e) => e.message.includes("MechEnergy"));
    expect(vge?.count).toBe(2);
    expect(vge?.frames.length).toBeGreaterThan(0);
    expect(vge?.namespaces).toContain("Orion");
  });

  // RimWorld writes some def errors twice, back to back. Seven rejected defs produced
  // fourteen lines, and the headline counted the lines.
  const doubleLogged = [
    "Config error in ND_Weapon_M87Frag: verb 0: has incorrect forcedMiss settings; explosive projectiles and only those should have forced miss enabled",
    "Config error in ND_Weapon_M87Frag: verb 0: has incorrect forcedMiss settings; explosive projectiles and only those should have forced miss enabled",
    "Config error in ND_Weapon_EMPGrenade: verb 0: has incorrect forcedMiss settings; explosive projectiles and only those should have forced miss enabled",
    "Config error in ND_Weapon_EMPGrenade: verb 0: has incorrect forcedMiss settings; explosive projectiles and only those should have forced miss enabled",
  ].join(NEWLINE);

  it("counts the defs a rejection is about, not the lines RimWorld wrote about them", () => {
    const finding = findingsFromLog(analyzeLog(doubleLogged), [])[0];
    expect(finding.title).toMatch(/^2 defs rejected/);
    // The badge counts the same thing the headline does. Two numbers on one row, 2 and 4,
    // asks a question the row does not answer.
    expect(finding.count).toBe(2);
  });

  it("cuts a long reason at a word, so a title does not end mid-word", () => {
    const finding = findingsFromLog(analyzeLog(doubleLogged), [])[0];
    const reason =
      "verb 0: has incorrect forcedMiss settings; explosive projectiles and only those should have forced miss enabled";
    const shown = finding.title.split("rejected: ")[1].replace(/\.\.\.$/, "");
    // Everything shown is the reason's own opening, and it stops where a word does. A hard
    // slice at 70 characters ended it "explosive projectiles and o".
    expect(reason.startsWith(shown)).toBe(true);
    expect(reason[shown.length]).toBe(" ");
  });

  it("names the type or def RimWorld could not find, which is the whole point of the row", () => {
    const missing = [
      "Could not find a type named Milira.CompProperties_MiliraShield",
      "Could not find ThingDef named VFEM_Longsword",
    ].join(NEWLINE);
    const titles = findingsFromLog(analyzeLog(missing), []).map((f) => f.title);
    expect(titles).toContain("Missing type Milira.CompProperties_MiliraShield");
    expect(titles).toContain("Missing ThingDef VFEM_Longsword");
  });

  it("does not call the game closing a fault it could not recover from", () => {
    // Verbatim from the end of a real session, right before Unity's shutdown dump.
    const shutdown = [
      "Exception thrown from thread=1317.",
      "System.Threading.ThreadAbortException: Thread was being aborted.",
      "[Ref 54CF78B3]",
      "  at SmashTools.Performance.DedicatedThread.Execute () [0x0000c] in <x>:0 ",
    ].join(NEWLINE);
    const finding = findingsFromLog(analyzeLog(shutdown), [])[0];
    expect(finding.severity).toBe("info");
    expect(finding.title).toContain("when the game closed");
    // Marked as describing the run rather than reporting a fault, which is what keeps it
    // out of the list of things to do.
    expect(finding.observation).toBe(true);
  });

  it("does not call a type scan's unloaded dependency a crash", () => {
    const probe =
      "FileNotFoundException: Cannot resolve dependency to assembly 'UnityEngine.InputLegacyModule, " +
      "Version=0.0.0.0, Culture=neutral, PublicKeyToken=null' because it has not been preloaded. When " +
      "using the ReflectionOnly APIs, dependent assemblies must be pre-loaded or loaded on demand " +
      "through the ReflectionOnlyAssemblyResolve event.";
    expect(findingsFromLog(analyzeLog(probe), [])[0].severity).toBe("info");
  });

  it("reports a mod saying its own patch did not attach", () => {
    // Matched nothing before: not XML-shaped, no leading "Error", no "Exception" in it.
    const said =
      "Combat Extended :: Failed to find injection point when applying Patch: Harmony_Compat_VanillaEventExpanded";
    const finding = findingsFromLog(analyzeLog(said), [])[0];
    expect(finding.severity).toBe("error");
    expect(finding.title).toBe("Combat Extended could not apply one of its patches");
  });

  it("keeps two Workshop items that never downloaded as two things to fix", () => {
    // Ids are digits, and the fallback fingerprint normalises digits out, so both became
    // one row whose Retry button could only ever act on the first.
    const ghosts = [
      "Created WorkshopItem for 3092936341 but there is no folder for it.",
      "Created WorkshopItem for 753498552 but there is no folder for it.",
      "Created WorkshopItem for 3092936341 but there is no folder for it.",
    ].join(NEWLINE);
    const found = findingsFromLog(analyzeLog(ghosts), []);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.title).sort()).toEqual([
      "Workshop item 3092936341 never downloaded",
      "Workshop item 753498552 never downloaded",
    ]);
  });

  it("does not file a crash as something merely observed", () => {
    // No repair exists for a NullReferenceException, and for a while that was enough to
    // file one under Observations beside the patch overrides. A fault nobody can automate
    // is still a fault.
    const crash = [
      "Error in PostExposeData of Verse.BackCompatibilityConverter_Universal",
      "System.NullReferenceException: Object reference not set to an instance of an object",
      "[Ref F049DDD8]",
      "  at Verse.Find.get_FactionManager () [0x00005] in <x>:0 ",
    ].join(NEWLINE);
    const finding = findingsFromLog(analyzeLog(crash), [])[0];
    expect(finding.severity).toBe("critical");
    expect(finding.fix).toBeUndefined();
    expect(finding.observation).toBeUndefined();
  });

  // Verbatim from a real run that died. The app read this log and reported the same routine
  // def errors it reports for a run someone quit on purpose.
  const crashedRun = [
    "Could not allocate memory: System out of memory!",
    "Trying to allocate: 715653120B with 16 alignment. MemoryLabel: Texture",
    "Allocation happened at: Line:72 in ",
    "Memory overview",
    "[ ALLOC_DEFAULT ] used: 788190644B | peak: 0B | reserved: 838057984B ",
    "  ERROR: SymGetSymFromAddr64, GetLastError: 'Attempt to access invalid address.' (Address: 00007FFEB0CAAE2D)",
    "0x00007FFEB0CAAE2D (UnityPlayer) (function-name not available)",
    "========== END OF STACKTRACE ===========",
    "A crash has been intercepted by the crash handler. For call stack and other details, see the latest crash report generated in:",
  ].join(NEWLINE);

  it("says when a run ended in a crash rather than in someone quitting", () => {
    const titles = findingsFromLog(analyzeLog(crashedRun), []).map((f) => f.title);
    expect(titles).toContain("This run ended in a crash");
  });

  it("names how much memory was wanted and what for", () => {
    // The size is the story. 683 MB for one texture is a different problem from 683 MB for
    // a save file, and each line alone carries only half of it.
    const found = findingsFromLog(analyzeLog(crashedRun), []).find((f) => f.title.includes("Out of memory"));
    expect(found?.title).toBe("Out of memory asking for 683 MB of texture");
    expect(found?.severity).toBe("critical");
  });

  it("does not turn a native stack dump into findings", () => {
    // Hundreds of module and address lines follow a crash. None of them is a fault.
    const found = findingsFromLog(analyzeLog(crashedRun), []);
    expect(found).toHaveLength(2);
  });

  it("reads the fault classes RimWorld reports in plain words", () => {
    // Five shapes, all present in a real session, none of which matched anything before:
    // a texture nothing ships, a key two mods both claim, a mod reading a DefOf before the
    // game filled it in, two things claiming one saved id, and a mesh built from nothing.
    const plain = [
      "Could not load Texture2D at 'Things/UI/Icons/Ammo_9M133M' in any active mod or in base resources.",
      "Tried to use an uninitialized DefOf of type DamageDefOf. DefOfs are initialized right after all defs all loaded.",
      "Cannot register MVCF.VerbWithComps MVCF.VerbWithComps, (id=Thing_VAEA_Apparel_MiniTurretPack825121_4_0_Managed in loaded object directory. Id already used by MVCF.VerbWithComps",
      "Failed setting triangles. Some indices are referencing out of bounds vertices. IndexCount: 36, VertexCount: 0",
    ].join(NEWLINE);
    const titles = findingsFromLog(analyzeLog(plain), []).map((f) => f.title);
    expect(titles).toContain("Missing texture Things/UI/Icons/Ammo_9M133M");
    expect(titles).toContain("A mod read DamageDefOf before the game filled it in");
    expect(titles).toContain(
      "Two things claim the saved id Thing_VAEA_Apparel_MiniTurretPack825121_4_0_Managed",
    );
    expect(titles).toContain("A mesh was built from indices pointing past its own vertices");
  });

  it("reports one key clash however many ways round the game writes it", () => {
    const clash = [
      "Key binding conflict: MainTab_History and MainTab_AM_LevelSchedule are both bound to F9.",
      "Key binding conflict: MainTab_AM_LevelSchedule and MainTab_History are both bound to F9.",
    ].join(NEWLINE);
    const found = findingsFromLog(analyzeLog(clash), []);
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe("MainTab_History and MainTab_AM_LevelSchedule both use F9");
    // No badge. It happened once, and RimWorld restating it is not a second conflict.
    expect(found[0].count).toBeUndefined();
  });

  it("gathers every type loading an asset off the main thread into one row", () => {
    // Twenty of these in a real session, one per type. Twenty warnings saying the same
    // thing about work only the mod authors can do is a tab nobody reads.
    const many = [
      "Type HediffComp_TurretGun probably needs a StaticConstructorOnStartup attribute, because it has a field ForcedTargetLineMat of type Material. All assets must be loaded in the main thread.",
      "Type OreHighlightRenderer probably needs a StaticConstructorOnStartup attribute, because it has a field sharedStripeTexture of type Texture2D. All assets must be loaded in the main thread.",
    ].join(NEWLINE);
    const found = findingsFromLog(analyzeLog(many), []);
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe("2 types load an asset off the main thread");
    expect(found[0].detail).toContain("HediffComp_TurretGun");
    expect(found[0].detail).toContain("OreHighlightRenderer");
  });

  it("blames the patch that could have caused it before the one that could not", () => {
    // Verbatim shape from a real crash. A prefix runs before the method body, so it can
    // have set up what the body choked on. A postfix runs after the body returned, so a
    // fault thrown inside the body is not its doing. Both are still named.
    const trace = [
      "Error while determining if VGE_Hunter1 should have Need MechEnergy: System.NullReferenceException: x",
      "[Ref 32B12C5D]",
      "  at RimWorld.Pawn_NeedsTracker.ShouldHaveNeed (RimWorld.NeedDef nd) [0x000d1] in <x>:0 ",
      "    - PREFIX Orion.Hospitality: Boolean Hospitality.Patches.Pawn_NeedsTracker_Patch:Prefix()",
      "    - POSTFIX rimworld.b4ttl3m3ds.simplebabycarry: Void b4ttl3m3ds.simplebabycarry.Core:Postfix()",
      "  at RimWorld.Pawn_NeedsTracker.AddOrRemoveNeedsAsAppropriate () [0x0001b] in <x>:0 ",
      "    - PREFIX OskarPotocki.VEF: Void VEF.AestheticScaling.Patch:Prefix()",
    ].join(NEWLINE);
    const ns = analyzeLog(trace).events[0].namespaces;
    // Nearest prefix, then the further prefix, then the postfix. Nothing is dropped.
    expect(ns.indexOf("Orion")).toBeLessThan(ns.indexOf("VEF"));
    expect(ns.indexOf("VEF")).toBeLessThan(ns.indexOf("simplebabycarry"));
    expect(ns).toContain("simplebabycarry");
  });

  it("puts a mod's own frame above any patch annotation", () => {
    // Its code ran and the fault came out of it, which beats having been on the way.
    const trace = [
      "System.InvalidOperationException: Collection was modified",
      "[Ref ABCD0001]",
      "  at System.Collections.Generic.HashSet`1+Enumerator[T].MoveNext () [0x00013] in <x>:0 ",
      "    - POSTFIX Some.Bystander: Void Bystander.Patch:Postfix()",
      "  at AllowTool.HaulUrgentlyCacheHandler.GetMapHaulables (Verse.Map map) [0x0006e] in <y>:0 ",
    ].join(NEWLINE);
    const ns = analyzeLog(trace).events[0].namespaces;
    expect(ns[0]).toBe("AllowTool");
    expect(ns).toContain("Bystander");
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
    expect(reset?.stale).toBeUndefined();
  });

  it("gathers one mod's failing patches into a single row", () => {
    // RimWorld reports each failure twice, as a stack trace under a marker naming the mod
    // and again as a summary line carrying the name inline. Both shapes, and every defName,
    // used to become their own row: on a real install one mod produced twenty-one of them,
    // each saying the same generic sentence and nothing else.
    const log = [
      "[Some Mod - Start of stack trace]",
      'Verse.PatchOperationReplace(xpath="Defs/ThingDef[defName=\"A\"]/tools"): Failed to find a node with the given xpath',
      "[End of stack trace]",
      "Source file: C:/mods/Some/Patches/A.xml",
      "[Some Mod - Start of stack trace]",
      'Verse.PatchOperationReplace(xpath="Defs/ThingDef[defName=\"B\"]/tools"): Failed to find a node with the given xpath',
      "[End of stack trace]",
      "Source file: C:/mods/Some/Patches/B.xml",
      "[Some Mod] Patch operation Verse.PatchOperationSequence(count=4) failed",
    ].join(NEWLINE);

    const events = analyzeLog(log).events.filter((e) => e.category === "xml-patch-failure");
    expect(events).toHaveLength(1);
    expect(events[0].patch?.owner).toBe("Some Mod");
    expect(events[0].count).toBe(3);
    // What it was actually looking for, which is the part worth reading.
    expect(events[0].patch?.xpaths).toEqual([
      'Defs/ThingDef[defName="A"]/tools',
      'Defs/ThingDef[defName="B"]/tools',
    ]);
    expect(events[0].patch?.files).toEqual(["C:/mods/Some/Patches/A.xml", "C:/mods/Some/Patches/B.xml"]);
  });

  it("keeps two mods' failing patches apart", () => {
    const log = [
      "[Mod One - Start of stack trace]",
      'Verse.PatchOperationReplace(xpath="Defs/A"): Failed to find a node with the given xpath',
      "[End of stack trace]",
      "[Mod Two - Start of stack trace]",
      'Verse.PatchOperationReplace(xpath="Defs/B"): Failed to find a node with the given xpath',
      "[End of stack trace]",
    ].join(NEWLINE);

    const events = analyzeLog(log).events.filter((e) => e.category === "xml-patch-failure");
    expect(events.map((e) => e.patch?.owner).sort()).toEqual(["Mod One", "Mod Two"]);
  });

  it("settles the reset once the load order holds mods again", () => {
    // The log is a record of a run that has finished, so repairing the file cannot stop it
    // saying this. Only the current order can, and it is what the repair writes.
    const restored = findingsFromLog(analyzeLog(log), [], ["ludeon.rimworld", "some.mod"]).find(
      (f) => f.rule === "log:playdata-reset",
    );
    expect(restored?.stale).toContain("restored after the log was written");

    // Core alone is the reset still standing: claiming otherwise would hide a real fault.
    const still = findingsFromLog(analyzeLog(log), [], ["ludeon.rimworld"]).find(
      (f) => f.rule === "log:playdata-reset",
    );
    expect(still?.stale).toBeUndefined();
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

  /**
   * A patched method reports the patch in the stack rather than the original, so the frames
   * name every mod whose code was on the way to the fault. Which is a different question
   * from which mod threw: a fault inside a postfix belongs to whoever wrote the postfix.
   */
  describe("patches named in a trace", () => {
    const frames = [
      "at Verse.Thing.SpawnSetup (Verse.Map map) [0x00000]",
      "- POSTFIX UnlimitedHugs.HugsLib.Patches.Thing_SpawnSetup+Postfix",
      "- TRANSPILER CombatExtended.Harmony.Harmony_Verb_TryStartCastOn",
      "- POSTFIX UnlimitedHugs.HugsLib.Patches.Thing_SpawnSetup+Postfix",
    ];
    const mods = [
      mod("unlimitedhugs.hugslib", { name: "HugsLib" }),
      mod("ceteam.combatextended", { name: "Combat Extended" }),
    ];

    it("names each patch, its kind, and the mod that owns it", () => {
      expect(patchFrames(frames, mods)).toEqual([
        {
          kind: "POSTFIX",
          method: "UnlimitedHugs.HugsLib.Patches.Thing_SpawnSetup",
          packageId: "unlimitedhugs.hugslib",
        },
        {
          kind: "TRANSPILER",
          method: "CombatExtended.Harmony.Harmony_Verb_TryStartCastOn",
          packageId: "ceteam.combatextended",
        },
      ]);
    });

    it("reports a patch whose owner is not installed rather than dropping it", () => {
      const orphan = ["- PREFIX SomeGoneMod.Patches.Thing_Tick"];
      expect(patchFrames(orphan, mods)).toEqual([
        { kind: "PREFIX", method: "SomeGoneMod.Patches.Thing_Tick", packageId: undefined },
      ]);
    });

    it("says nothing for a trace with no patches in it", () => {
      expect(patchFrames(["at Verse.Thing.Tick () [0x00000]"], mods)).toHaveLength(0);
    });
  });

  /**
   * The engine and the game do not agree on how to write a duration. Only the "took" form
   * was matched, which a real RimWorld log does not contain, so this read nothing at all on
   * every genuine log and the panel built on it was permanently empty.
   */
  describe("startup timings", () => {
    it("reads the form Unity actually writes", () => {
      const text = [
        "- Loaded All Assemblies, in  0.195 seconds",
        "- Finished resetting the current domain, in  0.001 seconds",
      ].join("\n");
      expect(analyzeLog(text).timings).toEqual([
        { label: "Loaded All Assemblies", ms: 195 },
        { label: "Finished resetting the current domain", ms: 1 },
      ]);
    });

    it("reads a bare colon-and-milliseconds line", () => {
      expect(analyzeLog("UnloadTime: 0.708800 ms").timings).toEqual([{ label: "UnloadTime", ms: 0.7088 }]);
    });

    it("still reads the took form, which some lines use", () => {
      expect(analyzeLog("Loading defs took 1.5 s").timings).toEqual([{ label: "Loading defs", ms: 1500 }]);
    });

    it("puts the longest phase first, since that is the one worth looking at", () => {
      const text = ["Quick: 5 ms", "- Slow, in  2 seconds"].join("\n");
      expect(analyzeLog(text).timings.map((t) => t.label)).toEqual(["Slow", "Quick"]);
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
    // Named, because the repair acts on one item and two of them can be missing at once.
    expect(ghost?.title).toBe("Workshop item 3092936341 never downloaded");
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

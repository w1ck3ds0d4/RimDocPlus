import { describe, expect, it } from "vitest";
import type { Finding, ModEntry, ProposedFix, ScanResult } from "../types";
import type { Profile } from "../profiles";
import { runStaticRules } from "../analysis/rules";
import { allFileActions, runTriage } from "./triage";

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
    paths: { saveData: "C:/save" },
    mods,
    activeOrder,
  };
}

function profileOf(activeOrder: string[]): Profile {
  return {
    id: "p1",
    name: "Test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    gameCycle: "1.6",
    activeOrder,
  };
}

function findingWith(fix: ProposedFix, over: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    rule: "test",
    severity: "error",
    title: "t",
    detail: "d",
    packageIds: [],
    fix,
    ...over,
  };
}

const auto = { tier: 1 as const, auto: true, label: "Fix" };
const manual = { tier: 1 as const, auto: false, label: "Fix" };

describe("runTriage", () => {
  const mods = [mod("a.one"), mod("b.two"), mod("c.lib")];

  it("sorts each finding into what can actually be done about it", () => {
    const findings = [
      findingWith({ ...auto, kind: "remove-orphan-entries", params: { ids: ["gone"] } }, { id: "pack" }),
      findingWith(
        { ...manual, kind: "disable-one-of", params: { candidates: ["a.one", "b.two"] } },
        { id: "choice" },
      ),
      findingWith({ ...manual, kind: "restore-mods-config" }, { id: "files" }),
      findingWith(
        { ...manual, kind: "install-dependency", params: { dependency: "x.y", name: "X" } },
        { id: "external" },
      ),
      findingWith({ ...auto, kind: "repair-xpath" }, { id: "none" }),
    ];

    const result = runTriage(findings, {
      scan: scanOf(mods, ["a.one", "b.two", "gone"]),
      profile: profileOf(["a.one", "b.two", "gone"]),
    });

    expect(result.applied.map((a) => a.finding.id)).toEqual(["pack"]);
    expect(result.decisions.map((d) => d.finding.id)).toEqual(["choice"]);
    expect(result.files.map((f) => f.finding.id)).toEqual(["files"]);
    expect(result.external.map((e) => e.finding.id)).toEqual(["external"]);
    expect(result.unresolved.map((u) => u.id)).toEqual(["none"]);
  });

  it("never applies a pack repair the rule marked as needing judgement", () => {
    const findings = [
      findingWith({ ...manual, kind: "remove-orphan-entries", params: { ids: ["gone"] } }, { id: "manual" }),
    ];
    const result = runTriage(findings, {
      scan: scanOf(mods, ["a.one", "gone"]),
      profile: profileOf(["a.one", "gone"]),
    });
    expect(result.applied).toHaveLength(0);
    expect(result.unresolved.map((u) => u.id)).toEqual(["manual"]);
  });

  it("chains automatic repairs so the returned pack carries all of them", () => {
    const withLib = [mod("a.one", { loadAfter: ["c.lib"] }), mod("c.lib")];
    const findings = [
      findingWith({ ...auto, kind: "remove-orphan-entries", params: { ids: ["gone"] } }, { id: "f1" }),
      findingWith({ ...auto, kind: "enable-dependency", params: { dependency: "c.lib" } }, { id: "f2" }),
    ];
    const result = runTriage(findings, {
      scan: scanOf(withLib, ["a.one", "gone"]),
      profile: profileOf(["a.one", "gone"]),
    });

    expect(result.applied).toHaveLength(2);
    expect(result.profile.activeOrder).toContain("c.lib");
    expect(result.profile.activeOrder).not.toContain("gone");
  });

  it("leaves the original pack untouched, returning a new one", () => {
    const original = profileOf(["a.one", "gone"]);
    const result = runTriage(
      [findingWith({ ...auto, kind: "remove-orphan-entries", params: { ids: ["gone"] } })],
      { scan: scanOf(mods, ["a.one", "gone"]), profile: original },
    );
    expect(original.activeOrder).toEqual(["a.one", "gone"]);
    expect(result.profile).not.toBe(original);
  });

  it("counts what is left by re-running the rules, not by subtracting", () => {
    // One real orphan; triage removes it, so the recount must actually drop.
    const scan = scanOf([mod("a.one")], ["a.one", "ghost.mod"]);
    const findings = runStaticRules(scan);
    const result = runTriage(findings, { scan, profile: profileOf(["a.one", "ghost.mod"]) });

    expect(result.before).toBeGreaterThan(0);
    expect(result.after).toBeLessThan(result.before);
    expect(result.after).toBe(0);
  });

  it("reports nothing to do for a clean pack", () => {
    const result = runTriage([], { scan: scanOf(mods, ["a.one"]), profile: profileOf(["a.one"]) });
    expect(result.applied).toEqual([]);
    expect(result.before).toBe(0);
    expect(result.after).toBe(0);
  });

  it("gathers every file action into one script's worth of work", () => {
    const findings = [
      findingWith({ ...manual, kind: "restore-mods-config" }, { id: "a" }),
      findingWith(
        { ...auto, kind: "stamp-supported-version", params: { ids: ["a.one"], cycle: "1.6" } },
        { id: "b" },
      ),
    ];
    const result = runTriage(findings, {
      scan: scanOf(mods, ["a.one"]),
      profile: profileOf(["a.one"]),
    });
    expect(allFileActions(result)).toHaveLength(2);
  });
});

describe("auto mode", () => {
  const incompatible = [
    mod("a.keep", { dependencies: [] }),
    mod("b.drop"),
    mod("c.user", { dependencies: [{ packageId: "a.keep" }] }),
  ];

  function incompatibleFinding() {
    return findingWith(
      { ...manual, kind: "disable-one-of", params: { candidates: ["a.keep", "b.drop"] } },
      { id: "pair" },
    );
  }

  it("leaves the decision to the player when off", () => {
    const result = runTriage([incompatibleFinding()], {
      scan: scanOf(incompatible, ["a.keep", "b.drop", "c.user"]),
      profile: profileOf(["a.keep", "b.drop", "c.user"]),
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.autoDecided).toHaveLength(0);
  });

  it("resolves it on its own judgement when on", () => {
    const result = runTriage(
      [incompatibleFinding()],
      {
        scan: scanOf(incompatible, ["a.keep", "b.drop", "c.user"]),
        profile: profileOf(["a.keep", "b.drop", "c.user"]),
      },
      { auto: true },
    );
    expect(result.decisions).toHaveLength(0);
    expect(result.autoDecided).toHaveLength(1);
    // Keeps the mod something depends on, so it disables the other one.
    expect(result.profile.activeOrder).toContain("a.keep");
    expect(result.profile.activeOrder).not.toContain("b.drop");
  });

  it("records the reasoning it used, so an auto decision is still inspectable", () => {
    const result = runTriage(
      [incompatibleFinding()],
      {
        scan: scanOf(incompatible, ["a.keep", "b.drop", "c.user"]),
        profile: profileOf(["a.keep", "b.drop", "c.user"]),
      },
      { auto: true },
    );
    expect(result.autoDecided[0].reasons.join(" ")).toContain("depend on it");
  });

  it("still asks when the repair could not defend any option", () => {
    // No candidates resolve to real mods, so nothing can be recommended.
    const finding = findingWith(
      { ...manual, kind: "disable-one-of", params: { candidates: ["ghost.one", "ghost.two"] } },
      { id: "unknowable" },
    );
    const result = runTriage(
      [finding],
      {
        scan: scanOf([mod("a.one")], ["a.one"]),
        profile: profileOf(["a.one"]),
      },
      { auto: true },
    );
    expect(result.autoDecided).toHaveLength(0);
    expect(result.decisions).toHaveLength(1);
  });

  it("stages a file resolution rather than performing it, even in auto", () => {
    const copies = [
      mod("dup.mod", { steamId: "1", folder: "C:/ws/1" }),
      mod("dup.mod", { steamId: "2", folder: "C:/ws/2" }),
    ];
    const finding = findingWith(
      {
        ...manual,
        kind: "pick-duplicate-winner",
        params: { packageId: "dup.mod", folders: ["C:/ws/1", "C:/ws/2"] },
      },
      { id: "dupe" },
    );
    const result = runTriage(
      [finding],
      { scan: scanOf(copies, ["dup.mod"]), profile: profileOf(["dup.mod"]) },
      { auto: true },
    );
    expect(result.autoDecided).toHaveLength(1);
    // It lands in the script, which the player still has to download and run.
    expect(result.files).toHaveLength(1);
    expect(result.files[0].actions[0].op).toBe("delete-matching");
  });
});

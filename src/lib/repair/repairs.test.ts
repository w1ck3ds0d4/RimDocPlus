import { describe, expect, it } from "vitest";
import type { Finding, ModEntry, ProposedFix, ScanResult } from "../types";
import type { Profile } from "../profiles";
import { autoPackRepairs, planRepair, toPowerShell, type RepairPlan } from "./repairs";

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

describe("planRepair", () => {
  it("returns null for a fix kind with no implementation", () => {
    const ctx = {
      scan: scanOf([], []),
      profile: profileOf([]),
      finding: findingWith({ ...auto, kind: "repair-xpath" }),
    };
    expect(planRepair(ctx)).toBeNull();
  });

  it("returns null for a finding with no fix at all", () => {
    const finding: Finding = {
      id: "x",
      rule: "r",
      severity: "info",
      title: "t",
      detail: "d",
      packageIds: [],
    };
    expect(planRepair({ scan: scanOf([], []), profile: profileOf([]), finding })).toBeNull();
  });
});

describe("remove-orphan-entries", () => {
  it("drops exactly the listed ids and leaves the rest in order", () => {
    const plan = planRepair({
      scan: scanOf([mod("a.one")], ["a.one", "b.gone", "c.gone"]),
      profile: profileOf(["a.one", "b.gone", "c.gone"]),
      finding: findingWith({ ...auto, kind: "remove-orphan-entries", params: { ids: ["b.gone", "c.gone"] } }),
    });
    expect(plan?.kind).toBe("pack");
    expect((plan as Extract<RepairPlan, { kind: "pack" }>).profile.activeOrder).toEqual(["a.one"]);
  });

  it("does nothing when the rule supplied no ids", () => {
    const plan = planRepair({
      scan: scanOf([], ["a"]),
      profile: profileOf(["a"]),
      finding: findingWith({ ...auto, kind: "remove-orphan-entries" }),
    });
    expect(plan).toBeNull();
  });
});

describe("enable-dependency", () => {
  it("enables the dependency ahead of the mod that needs it", () => {
    const mods = [mod("a.needs", { loadAfter: ["b.lib"] }), mod("b.lib")];
    const plan = planRepair({
      scan: scanOf(mods, ["a.needs"]),
      profile: profileOf(["a.needs"]),
      finding: findingWith({ ...auto, kind: "enable-dependency", params: { dependency: "b.lib" } }),
    }) as Extract<RepairPlan, { kind: "pack" }>;
    expect(plan.profile.activeOrder).toContain("b.lib");
  });

  it("offers nothing when the dependency is already enabled", () => {
    const mods = [mod("a.needs"), mod("b.lib")];
    expect(
      planRepair({
        scan: scanOf(mods, ["b.lib", "a.needs"]),
        profile: profileOf(["b.lib", "a.needs"]),
        finding: findingWith({ ...auto, kind: "enable-dependency", params: { dependency: "b.lib" } }),
      }),
    ).toBeNull();
  });
});

describe("ordering repairs", () => {
  const mods = [mod("a.late", { loadAfter: ["b.first"] }), mod("b.first")];

  it("reorders to satisfy the declared constraint", () => {
    const plan = planRepair({
      scan: scanOf(mods, ["a.late", "b.first"]),
      profile: profileOf(["a.late", "b.first"]),
      finding: findingWith({ ...auto, kind: "reorder", params: { mod: "a.late", other: "b.first" } }),
    }) as Extract<RepairPlan, { kind: "pack" }>;
    expect(plan.profile.activeOrder).toEqual(["b.first", "a.late"]);
  });

  it("offers nothing when the order is already correct", () => {
    expect(
      planRepair({
        scan: scanOf(mods, ["b.first", "a.late"]),
        profile: profileOf(["b.first", "a.late"]),
        finding: findingWith({ ...auto, kind: "reorder" }),
      }),
    ).toBeNull();
  });
});

describe("choice repairs", () => {
  it("disable-one-of offers one option per candidate and each removes only that mod", () => {
    const mods = [mod("a.one"), mod("b.two")];
    const plan = planRepair({
      scan: scanOf(mods, ["a.one", "b.two"]),
      profile: profileOf(["a.one", "b.two"]),
      finding: findingWith({ ...manual, kind: "disable-one-of", params: { candidates: ["a.one", "b.two"] } }),
    }) as Extract<RepairPlan, { kind: "choice" }>;

    expect(plan.kind).toBe("choice");
    expect(plan.choices).toHaveLength(2);
    const first = plan.choices[0].plan() as Extract<RepairPlan, { kind: "pack" }>;
    expect(first.profile.activeOrder).toEqual(["b.two"]);
  });

  it("pick-duplicate-winner removes every folder except the chosen one", () => {
    const plan = planRepair({
      scan: scanOf([], []),
      profile: profileOf([]),
      finding: findingWith({
        ...manual,
        kind: "pick-duplicate-winner",
        params: { packageId: "orion.hospitality", folders: ["C:/ws/1", "C:/ws/2"] },
      }),
    }) as Extract<RepairPlan, { kind: "choice" }>;

    const keepFirst = plan.choices[0].plan() as Extract<RepairPlan, { kind: "files" }>;
    expect(keepFirst.actions).toHaveLength(1);
    expect(keepFirst.actions[0]).toMatchObject({ op: "delete-matching", directory: "C:/ws/2" });
  });
});

describe("file repairs", () => {
  it("stamp-supported-version targets each mod's About.xml", () => {
    const mods = [mod("a.one", { folder: "C:/mods/a" }), mod("b.two", { folder: "C:/mods/b" })];
    const plan = planRepair({
      scan: scanOf(mods, ["a.one", "b.two"]),
      profile: profileOf(["a.one", "b.two"]),
      finding: findingWith({
        ...auto,
        kind: "stamp-supported-version",
        params: { ids: ["a.one", "b.two"], cycle: "1.6" },
      }),
    }) as Extract<RepairPlan, { kind: "files" }>;

    expect(plan.kind).toBe("files");
    expect(plan.actions.map((a) => ("path" in a ? a.path : ""))).toEqual([
      "C:/mods/a/About/About.xml",
      "C:/mods/b/About/About.xml",
    ]);
  });

  it("skips mods that are no longer installed", () => {
    const plan = planRepair({
      scan: scanOf([mod("a.one")], ["a.one"]),
      profile: profileOf(["a.one"]),
      finding: findingWith({
        ...auto,
        kind: "stamp-supported-version",
        params: { ids: ["gone.mod"], cycle: "1.6" },
      }),
    });
    expect(plan).toBeNull();
  });

  it("restore-mods-config writes the pack's own load order", () => {
    const plan = planRepair({
      scan: scanOf([mod("a.one")], []),
      profile: profileOf(["a.one", "b.two"]),
      finding: findingWith({ ...manual, kind: "restore-mods-config" }),
    }) as Extract<RepairPlan, { kind: "files" }>;

    const write = plan.actions[0];
    expect(write.op).toBe("write");
    expect("contents" in write && write.contents).toContain("<li>b.two</li>");
  });

  it("needs a save-data path before it can touch config", () => {
    const scan = { ...scanOf([], []), paths: {} };
    expect(
      planRepair({
        scan,
        profile: profileOf(["a"]),
        finding: findingWith({ ...manual, kind: "restore-mods-config" }),
      }),
    ).toBeNull();
  });
});

describe("toPowerShell", () => {
  it("backs a file up before changing it", () => {
    const script = toPowerShell([
      { op: "add-supported-version", path: "C:/mods/a/About/About.xml", cycle: "1.6", reason: "stale" },
    ]);
    expect(script).toContain("Backup-Once");
    expect(script).toContain("rimdocbak");
    expect(script).toContain("1.6");
  });

  it("escapes single quotes so a path cannot break out of its literal", () => {
    const script = toPowerShell([
      { op: "delete-matching", directory: "C:/it's/mods", pattern: "*.xml", reason: "test" },
    ]);
    expect(script).toContain("'C:/it''s/mods'");
  });

  it("carries the reason for every action into the script as a comment", () => {
    const script = toPowerShell([
      { op: "write", path: "C:/x.xml", contents: "<a/>", reason: "because the load order was reset" },
    ]);
    expect(script).toContain("# because the load order was reset");
  });
});

describe("autoPackRepairs", () => {
  const mods = [mod("a.needs", { loadAfter: ["b.lib"] }), mod("b.lib"), mod("c.other")];

  it("takes only deterministic pack repairs, skipping manual and file ones", () => {
    const findings = [
      findingWith({ ...auto, kind: "remove-orphan-entries", params: { ids: ["gone"] } }, { id: "f1" }),
      findingWith(
        { ...manual, kind: "disable-one-of", params: { candidates: ["a.needs", "c.other"] } },
        { id: "f2" },
      ),
      findingWith(
        { ...auto, kind: "stamp-supported-version", params: { ids: ["a.needs"], cycle: "1.6" } },
        { id: "f3" },
      ),
    ];
    const applied = autoPackRepairs(findings, {
      scan: scanOf(mods, ["a.needs", "gone"]),
      profile: profileOf(["a.needs", "gone"]),
    });
    expect(applied.map((a) => a.finding.id)).toEqual(["f1"]);
  });

  it("chains each repair onto the previous result rather than the original pack", () => {
    const findings = [
      findingWith({ ...auto, kind: "remove-orphan-entries", params: { ids: ["gone"] } }, { id: "f1" }),
      findingWith({ ...auto, kind: "enable-dependency", params: { dependency: "b.lib" } }, { id: "f2" }),
    ];
    const applied = autoPackRepairs(findings, {
      scan: scanOf(mods, ["a.needs", "gone"]),
      profile: profileOf(["a.needs", "gone"]),
    });

    expect(applied).toHaveLength(2);
    // The last plan carries both edits, so applying it alone is the whole batch.
    const final = applied[applied.length - 1].plan.profile.activeOrder;
    expect(final).toContain("b.lib");
    expect(final).not.toContain("gone");
  });

  it("returns nothing when the pack is already clean", () => {
    expect(autoPackRepairs([], { scan: scanOf(mods, []), profile: profileOf([]) })).toEqual([]);
  });
});

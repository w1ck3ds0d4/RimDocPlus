import { describe, expect, it } from "vitest";
import type { Finding, ModEntry, ProposedFix, ScanResult } from "../types";
import type { Modpack } from "../modpacks";
import {
  autoPackRepairs,
  needsSteamClosed,
  workshopManifest,
  planRepair,
  toPowerShell,
  toRollbackPowerShell,
  type FileAction,
  type RepairPlan,
} from "./repairs";

/** A single backslash, spelled this way so no escaping layer can eat it. */
const SEP = String.fromCharCode(92);

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

function profileOf(activeOrder: string[]): Modpack {
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
      modpack: profileOf([]),
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
    expect(planRepair({ scan: scanOf([], []), modpack: profileOf([]), finding })).toBeNull();
  });
});

describe("remove-orphan-entries", () => {
  it("drops exactly the listed ids and leaves the rest in order", () => {
    const plan = planRepair({
      scan: scanOf([mod("a.one")], ["a.one", "b.gone", "c.gone"]),
      modpack: profileOf(["a.one", "b.gone", "c.gone"]),
      finding: findingWith({ ...auto, kind: "remove-orphan-entries", params: { ids: ["b.gone", "c.gone"] } }),
    });
    expect(plan?.kind).toBe("modpack");
    expect((plan as Extract<RepairPlan, { kind: "modpack" }>).modpack.activeOrder).toEqual(["a.one"]);
  });

  it("does nothing when the rule supplied no ids", () => {
    const plan = planRepair({
      scan: scanOf([], ["a"]),
      modpack: profileOf(["a"]),
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
      modpack: profileOf(["a.needs"]),
      finding: findingWith({ ...auto, kind: "enable-dependency", params: { dependency: "b.lib" } }),
    }) as Extract<RepairPlan, { kind: "modpack" }>;
    expect(plan.modpack.activeOrder).toContain("b.lib");
  });

  it("offers nothing when the dependency is already enabled", () => {
    const mods = [mod("a.needs"), mod("b.lib")];
    expect(
      planRepair({
        scan: scanOf(mods, ["b.lib", "a.needs"]),
        modpack: profileOf(["b.lib", "a.needs"]),
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
      modpack: profileOf(["a.late", "b.first"]),
      finding: findingWith({ ...auto, kind: "reorder", params: { mod: "a.late", other: "b.first" } }),
    }) as Extract<RepairPlan, { kind: "modpack" }>;
    expect(plan.modpack.activeOrder).toEqual(["b.first", "a.late"]);
  });

  it("offers nothing when the order is already correct", () => {
    expect(
      planRepair({
        scan: scanOf(mods, ["b.first", "a.late"]),
        modpack: profileOf(["b.first", "a.late"]),
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
      modpack: profileOf(["a.one", "b.two"]),
      finding: findingWith({ ...manual, kind: "disable-one-of", params: { candidates: ["a.one", "b.two"] } }),
    }) as Extract<RepairPlan, { kind: "choice" }>;

    expect(plan.kind).toBe("choice");
    expect(plan.choices).toHaveLength(2);
    const first = plan.choices[0].plan() as Extract<RepairPlan, { kind: "modpack" }>;
    expect(first.modpack.activeOrder).toEqual(["b.two"]);
  });

  it("pick-duplicate-winner removes every folder except the chosen one", () => {
    const plan = planRepair({
      scan: scanOf([], []),
      modpack: profileOf([]),
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
      modpack: profileOf(["a.one", "b.two"]),
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
      modpack: profileOf(["a.one"]),
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
      modpack: profileOf(["a.one", "b.two"]),
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
        modpack: profileOf(["a"]),
        finding: findingWith({ ...manual, kind: "restore-mods-config" }),
      }),
    ).toBeNull();
  });
});

describe("workshopManifest", () => {
  const withWorkshop = (workshop: string): ScanResult => ({
    ...scanOf([], []),
    paths: { saveData: "C:/save", workshop },
  });

  const WIN = ["C:", "Steam", "steamapps", "workshop", "content", "294100"].join(SEP);
  const NIX = "/home/me/.steam/steam/steamapps/workshop/content/294100";

  /** The scan reports whatever the platform handed it, and on Windows that is backslashes. */
  it("finds the manifest two levels above the content folder", () => {
    expect(workshopManifest(withWorkshop(WIN))).toBe(
      ["C:", "Steam", "steamapps", "workshop", "appworkshop_294100.acf"].join(SEP),
    );
    expect(workshopManifest(withWorkshop(NIX))).toBe(
      "/home/me/.steam/steam/steamapps/workshop/appworkshop_294100.acf",
    );
  });

  it("says nothing rather than guessing when the path is not the shape it expects", () => {
    expect(workshopManifest(withWorkshop("C:/somewhere/else"))).toBeNull();
    expect(workshopManifest(scanOf([], []))).toBeNull();
  });
});

describe("retry-workshop-download", () => {
  const scanWith = (mods: ModEntry[], workshop?: string): ScanResult => ({
    ...scanOf(
      mods,
      mods.map((m) => m.packageId),
    ),
    paths: { saveData: "C:/save", ...(workshop ? { workshop } : {}) },
  });

  const planFor = (mods: ModEntry[]) =>
    planRepair({
      scan: scanWith(mods, "C:/Steam/steamapps/workshop/content/294100"),
      modpack: profileOf([]),
      finding: findingWith({ ...manual, kind: "retry-workshop-download", params: { steamId: "123" } }),
    }) as Extract<RepairPlan, { kind: "files" }>;

  /**
   * One failing action does not stop the rest, so the other order left the mod deleted while
   * Steam still believed it had a copy: gone, and never re-fetched. That is the one outcome
   * worse than doing nothing, so the edit Steam can refuse goes first.
   */
  it("drops Steam's record before removing the folder, never after", () => {
    const plan = planFor([mod("a.one", { steamId: "123", folder: "C:/ws/123" })]);
    expect(plan.actions.map((a) => a.op)).toEqual(["forget-workshop-item", "delete-matching"]);
  });

  /** A ghost subscription has no folder, so there is nothing on disk to remove. */
  it("only touches the manifest when the mod never arrived", () => {
    const plan = planFor([mod("other.mod", { steamId: "999" })]);
    expect(plan.actions.map((a) => a.op)).toEqual(["forget-workshop-item"]);
  });

  it("is recognised as needing Steam closed, whichever half of it exists", () => {
    expect(needsSteamClosed(planFor([mod("a.one", { steamId: "123" })]).actions)).toBe(true);
    expect(needsSteamClosed([{ op: "write", path: "p", contents: "c", reason: "r" }])).toBe(false);
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

  it("removes a duplicate folder itself, so the rollback finds the backup it looks for", () => {
    const actions: FileAction[] = [
      { op: "delete-matching", directory: "C:/mods/dupe", pattern: "*", reason: "duplicate" },
    ];
    const script = toPowerShell(actions);
    const undo = toRollbackPowerShell(actions);

    // Emptying the folder would leave every backup inside the folder being emptied, while
    // the rollback restores from <folder>.rimdocbak beside it.
    expect(script).toContain("Remove-Item $d -Recurse -Force");
    expect(script).not.toContain("Get-ChildItem -Path 'C:/mods/dupe'");
    expect(undo).toContain("Restore-One 'C:/mods/dupe'");
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
      modpack: profileOf(["a.needs", "gone"]),
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
      modpack: profileOf(["a.needs", "gone"]),
    });

    expect(applied).toHaveLength(2);
    // The last plan carries both edits, so applying it alone is the whole batch.
    const final = applied[applied.length - 1].plan.modpack.activeOrder;
    expect(final).toContain("b.lib");
    expect(final).not.toContain("gone");
  });

  it("returns nothing when the pack is already clean", () => {
    expect(autoPackRepairs([], { scan: scanOf(mods, []), modpack: profileOf([]) })).toEqual([]);
  });
});

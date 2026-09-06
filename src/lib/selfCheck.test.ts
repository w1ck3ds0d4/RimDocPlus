import { describe, expect, it } from "vitest";
import type { Finding, ModEntry, ScanResult } from "./types";
import { runSelfChecks } from "./selfCheck";

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
    loadIndex: 0,
    ...over,
  };
}

function scanOf(mods: ModEntry[], activeOrder = mods.map((m) => m.packageId)): ScanResult {
  return {
    scannedAt: "2026-01-01T00:00:00.000Z",
    gameVersion: "1.6.4871 rev590",
    gameCycle: "1.6",
    paths: { game: "C:/game", saveData: "C:/save" },
    mods,
    activeOrder,
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    rule: "test",
    severity: "info",
    title: "A title",
    detail: "A detail",
    packageIds: [],
    ...over,
  };
}

function check(scan: ScanResult, findings: Finding[], name: string) {
  return runSelfChecks(scan, findings).find((c) => c.name === name)!;
}

const HEALTHY = scanOf([mod("a.one")]);

describe("runSelfChecks", () => {
  it("passes on a healthy scan", () => {
    expect(runSelfChecks(HEALTHY, [finding()]).every((c) => c.ok)).toBe(true);
  });

  it("catches duplicate finding ids, which React silently collapses", () => {
    const result = check(
      HEALTHY,
      [finding({ id: "same" }), finding({ id: "same" })],
      "Finding ids are unique",
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("same");
  });

  it("catches a fix naming a repair nobody registered", () => {
    const bad = finding({
      fix: { kind: "does-not-exist", label: "Fix", tier: 1, auto: false },
    });
    const result = check(HEALTHY, [bad], "Every proposed fix has a repair");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("does-not-exist");
  });

  it("accepts a fix naming a real repair", () => {
    const good = finding({
      fix: { kind: "remove-orphan-entries", label: "Fix", tier: 1, auto: true },
    });
    expect(check(HEALTHY, [good], "Every proposed fix has a repair").ok).toBe(true);
  });

  it("catches a finding that would render as an empty row", () => {
    expect(check(HEALTHY, [finding({ title: "  " })], "Findings have a title and detail").ok).toBe(false);
  });

  it("catches a mod with no usable identity", () => {
    const scan = scanOf([mod("a.one"), { ...mod("b.two"), packageId: "" }]);
    expect(check(scan, [], "Mods have an id and a name").ok).toBe(false);
  });

  it("tolerates a few orphans but not a load order that mostly resolves to nothing", () => {
    const few = scanOf([mod("a.one"), mod("b.two")], ["a.one", "b.two", "gone.mod"]);
    expect(check(few, [], "Load order resolves to installed mods").ok).toBe(true);

    // A scanner that stopped matching looks like this, and is not an orphan problem.
    const most = scanOf([mod("a.one")], ["a.one", "x.1", "x.2", "x.3"]);
    expect(check(most, [], "Load order resolves to installed mods").ok).toBe(false);
  });

  it("catches an install whose paths were never found", () => {
    const scan = { ...HEALTHY, paths: {} };
    const result = check(scan, [], "Install paths were found");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("game");
  });
});

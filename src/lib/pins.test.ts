import { describe, expect, it } from "vitest";
import { checkPins, clearPins, pinTo } from "./pins";
import type { Modpack } from "./modpacks";
import type { ModEntry } from "./types";

function mod(packageId: string): ModEntry {
  return {
    packageId,
    name: packageId.toUpperCase(),
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
  };
}

const pack = (over: Partial<Modpack> = {}): Modpack => ({
  id: "p1",
  name: "Test",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  gameCycle: "1.6",
  activeOrder: ["a", "b"],
  ...over,
});

const MODS = [mod("a"), mod("b")];

describe("pinning", () => {
  it("records the build of everything in the order", () => {
    const pinned = pinTo(pack(), { a: "aaa", b: "bbb" });
    expect(pinned.pins).toEqual({ a: "aaa", b: "bbb" });
  });

  it("pins only what it could measure, rather than inventing a build", () => {
    expect(pinTo(pack(), { a: "aaa" }).pins).toEqual({ a: "aaa" });
  });

  it("drops every pin when asked", () => {
    expect(clearPins(pinTo(pack(), { a: "aaa" })).pins).toBeUndefined();
  });
});

describe("checking pins against the install", () => {
  const pinned = pack({ pins: { a: "aaa", b: "bbb" } });

  it("says nothing is wrong when every build still matches", () => {
    const report = checkPins(pinned, MODS, { a: "aaa", b: "bbb" });
    expect(report.drifted).toBe(0);
    expect(report.checks.every((c) => c.state === "matched")).toBe(true);
  });

  /**
   * The state that is otherwise invisible: nothing about a load order changes when Steam
   * replaces a mod underneath it, so the setup looks identical and behaves differently.
   */
  it("catches a mod replaced underneath the modpack", () => {
    const report = checkPins(pinned, MODS, { a: "aaa", b: "CHANGED" });
    expect(report.drifted).toBe(1);
    const drifted = report.checks.find((c) => c.state === "drifted");
    expect(drifted?.packageId).toBe("b");
    expect(drifted?.pinned).toBe("bbb");
    expect(drifted?.current).toBe("CHANGED");
  });

  it("separates a mod that is gone from one that merely changed", () => {
    const report = checkPins(pinned, [mod("a")], { a: "aaa" });
    expect(report.missing).toBe(1);
    expect(report.checks.find((c) => c.state === "missing")?.packageId).toBe("b");
  });

  /** Not measuring a mod is not evidence that it changed. */
  it("does not call an unmeasured mod drifted", () => {
    const report = checkPins(pinned, MODS, { a: "aaa" });
    expect(report.drifted).toBe(0);
    expect(report.checks.find((c) => c.packageId === "b")?.state).toBe("unpinned");
  });

  it("reports an unpinned modpack as unpinned rather than as drift", () => {
    const report = checkPins(pack(), MODS, { a: "aaa", b: "bbb" });
    expect(report.pinned).toBe(0);
    expect(report.drifted).toBe(0);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToggleMod } from "./ToggleMod";
import { RepairProvider } from "./Repair";
import type { ModEntry, ScanResult } from "../lib/types";
import type { Modpack } from "../lib/modpacks";

afterEach(cleanup);

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

function show(mods: ModEntry[], activeOrder: string[], target: ModEntry) {
  const applyModpack = vi.fn();
  const scan: ScanResult = {
    scannedAt: "2026-01-01T00:00:00.000Z",
    gameVersion: "1.6.4871 rev591",
    gameCycle: "1.6",
    paths: {},
    mods,
    activeOrder,
  };
  const modpack: Modpack = {
    id: "p1",
    name: "Test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    gameCycle: "1.6",
    activeOrder,
  };
  render(
    <RepairProvider value={{ scan, modpack, applyModpack }}>
      <ToggleMod mod={target} />
    </RepairProvider>,
  );
  return { applyModpack };
}

describe("ToggleMod", () => {
  it("takes an active mod out of the order without touching anything else", () => {
    const target = mod("a.target");
    const { applyModpack } = show([target, mod("b.other")], ["a.target", "b.other"], target);

    fireEvent.click(screen.getByRole("button", { name: /Disable it/ }));

    expect(applyModpack).toHaveBeenCalledTimes(1);
    const [next, label] = applyModpack.mock.calls[0];
    expect(next.activeOrder).toEqual(["b.other"]);
    expect(label).toContain("disable");
  });

  it("puts an inactive one back", () => {
    const target = mod("a.target", { active: false });
    const { applyModpack } = show([target, mod("b.other")], ["b.other"], target);

    fireEvent.click(screen.getByRole("button", { name: /Enable it/ }));

    expect(applyModpack.mock.calls[0][0].activeOrder).toEqual(["b.other", "a.target"]);
  });

  it("warns who needs it rather than refusing", () => {
    // A disabled button with no explanation helps nobody, and the person looking at this
    // screen usually knows what they are doing.
    const target = mod("framework.core", { name: "Framework" });
    const dependent = mod("some.mod", {
      name: "Dependent Mod",
      dependencies: [{ packageId: "framework.core" }],
    });
    show([target, dependent], ["framework.core", "some.mod"], target);

    const button = screen.getByRole("button", { name: /Disable it/ });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("title")).toContain("Dependent Mod");
    expect(screen.getByText("1 need it")).toBeTruthy();
  });

  it("counts only dependents that are actually in the order", () => {
    const target = mod("framework.core");
    const inactive = mod("dormant.mod", {
      active: false,
      dependencies: [{ packageId: "framework.core" }],
    });
    show([target, inactive], ["framework.core"], target);

    expect(screen.queryByText(/need it/)).toBeNull();
    expect(screen.getByRole("button", { name: /Disable it/ }).getAttribute("title")).toContain(
      "Apply to game",
    );
  });

  it("matches a package id however it is cased", () => {
    // Load orders and About.xml files disagree about casing constantly, and a toggle that
    // silently did nothing because of it would be the worst kind of broken.
    const target = mod("Oskar.MixedCase");
    const { applyModpack } = show([target], ["oskar.mixedcase"], target);

    fireEvent.click(screen.getByRole("button", { name: /Disable it/ }));
    expect(applyModpack.mock.calls[0][0].activeOrder).toEqual([]);
  });

  it("renders nothing outside a repair context, rather than throwing", () => {
    render(<ToggleMod mod={mod("a.target")} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

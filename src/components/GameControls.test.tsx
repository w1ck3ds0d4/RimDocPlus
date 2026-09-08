// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GameControls } from "./GameControls";
import type { ModEntry, ScanResult } from "../lib/types";
import type { Modpack } from "../lib/modpacks";

// The button is shell-only, and renders disabled with a reason in a browser. inShell()
// looks for exactly this, so standing it up is what puts the test where the button lives.
beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  cleanup();
});

function mod(packageId: string): ModEntry {
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
  };
}

/** The game has `inGame`; the working copy has `inModpack`. */
function show(inGame: string[], inModpack: string[]) {
  const scan: ScanResult = {
    scannedAt: "2026-01-01T00:00:00.000Z",
    gameVersion: "1.6.4871 rev591",
    gameCycle: "1.6",
    // configDir reads this; without it the button is disabled for a different reason.
    paths: { saveData: "C:/save", game: "C:/RimWorld" },
    mods: [...new Set([...inGame, ...inModpack])].map(mod),
    activeOrder: inGame,
  };
  const modpack: Modpack = {
    id: "p1",
    name: "Test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    gameCycle: "1.6",
    activeOrder: inModpack,
  };
  render(<GameControls scan={scan} modpack={modpack} onRescan={vi.fn()} scanning={false} onPlay={vi.fn()} />);
  return screen.getByRole("button", { name: /Apply to game/ });
}

describe("Apply to game", () => {
  it("counts what is waiting and offers itself", () => {
    const button = show(["a.one"], ["a.one", "b.two", "c.three"]);
    expect(button.textContent).toContain("2");
    expect(button.className).toContain("go");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.title).toContain("2 to add");
  });

  it("refuses when the game already has this order", () => {
    // Pressed on an unchanged order it rewrote the same file and reported success, which
    // reads as having done something.
    const button = show(["a.one", "b.two"], ["a.one", "b.two"]);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.className).not.toContain("go");
    expect(button.title).toBe("The game already has this load order");
  });

  it("counts a reorder, which changes nothing about which mods are present", () => {
    // The count is what makes the button offer itself, so an order-only change has to
    // reach it: those are the changes most worth applying.
    const button = show(["a.one", "b.two", "c.three"], ["c.three", "a.one", "b.two"]);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.title).toContain("1 to move");
  });

  it("adds up removals and moves together", () => {
    const button = show(["a.one", "b.two", "c.three"], ["c.three", "a.one"]);
    expect(button.textContent).toContain("2");
    expect(button.title).toContain("1 to remove");
    expect(button.title).toContain("1 to move");
  });
});

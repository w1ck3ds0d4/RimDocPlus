import { describe, expect, it } from "vitest";
import { bootVerdict, isBootFailure, isDecided } from "./bootCheck";

/** The line RimWorld writes when it gives up on a mod list, taken from a real failed load. */
const RESET =
  "Caught exception while loading play data but there are active mods other than Core. " +
  "Resetting mods config and trying again.";

describe("judging a run from what it wrote", () => {
  it("calls a load that reached mod construction loaded", () => {
    const lines = ["[HugsLib] version 12.0.0", "Verse.LoadedModManager:CreateModClasses():0"];
    expect(bootVerdict(lines).verdict).toBe("loaded");
  });

  it("calls the game's own reset a failure, and quotes it", () => {
    const result = bootVerdict(["Initialize engine version: 2022.3.35f1", RESET]);
    expect(result.verdict).toBe("reset");
    expect(result.evidence).toContain("Resetting mods config");
  });

  /**
   * Everything after the reset is the game's recovery attempt with Core only, which is a
   * different run from the one being judged and would otherwise report as loaded.
   */
  it("does not let the recovery attempt overturn the failure", () => {
    const lines = [RESET, "Verse.LoadedModManager:CreateModClasses():0", "[HugsLib] version 12.0.0"];
    expect(bootVerdict(lines).verdict).toBe("reset");
  });

  it("says loading while the run is still going and nothing has gone wrong", () => {
    expect(bootVerdict(["Initialize engine version: 2022.3.35f1"]).verdict).toBe("loading");
  });

  /** Gone, with no reset line and no clean shutdown, is something taking the process down. */
  it("calls a process that vanished mid-load a crash", () => {
    expect(bootVerdict(["Initialize engine version: 2022.3.35f1"], 1).verdict).toBe("crashed");
  });

  it("does not call a clean shutdown a crash", () => {
    const lines = ["Initialize engine version: 2022.3.35f1", "[ALLOC_TEMP_TLS] TLS Allocator"];
    expect(bootVerdict(lines, 0).verdict).toBe("unknown");
  });

  it("counts the mods that announced themselves, as a measure of how far it got", () => {
    const lines = [
      "[HugsLib] version 12.0.0",
      "Combat Extended :: initialized",
      "[AutoParking] Harmony patches have been applied successfully.",
      "Verse.LoadedModManager:CreateModClasses():0",
    ];
    expect(bootVerdict(lines).modsInitialised).toBe(3);
  });
});

describe("acting on a verdict", () => {
  it("treats a reset and a crash as failures, and a load as not", () => {
    expect(isBootFailure("reset")).toBe(true);
    expect(isBootFailure("crashed")).toBe(true);
    expect(isBootFailure("loaded")).toBe(false);
    expect(isBootFailure("loading")).toBe(false);
  });

  /** A search may only stop the game once the run has actually answered its question. */
  it("only calls a run decided once it has loaded or failed", () => {
    expect(isDecided("loading")).toBe(false);
    expect(isDecided("unknown")).toBe(false);
    expect(isDecided("loaded")).toBe(true);
    expect(isDecided("reset")).toBe(true);
  });
});

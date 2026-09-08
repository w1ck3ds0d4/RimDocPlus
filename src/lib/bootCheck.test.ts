import { describe, expect, it } from "vitest";
import { bootVerdict, isBootFailure, isDecided } from "./bootCheck";

/** The line RimWorld writes when it gives up on a mod list, taken from a real failed load. */
const RESET =
  "Caught exception while loading play data but there are active mods other than Core. " +
  "Resetting mods config and trying again.";

describe("a run that died before it loaded", () => {
  it("is a crash, whatever Unity printed on the way out", () => {
    // There was a CLEAN_EXIT marker matching Unity's allocator dump, on the belief that it
    // is written only on a clean shutdown. A RimWorld killed with Stop-Process wrote
    // seventeen of those lines, so the marker was true for a crash and this came back
    // "unknown". The exit code answers it instead.
    const dumpAfterDeath = [
      "[HugsLib] v11.0.4",
      "Memory Statistics:",
      "[ALLOC_TEMP_TLS] TLS Allocator",
      "      Peak Allocated memory 0 B",
    ];
    expect(bootVerdict(dumpAfterDeath, -1).verdict).toBe("crashed");
    expect(bootVerdict(dumpAfterDeath, 3221225477).verdict).toBe("crashed");
  });

  it("is still only loading while the process is alive", () => {
    expect(bootVerdict(["[HugsLib] v11.0.4"], undefined).verdict).toBe("loading");
  });

  it("says unknown rather than guessing when the game closed tidily without loading", () => {
    // Not something the game does on its own, so there is nothing honest to conclude.
    expect(bootVerdict(["[HugsLib] v11.0.4"], 0).verdict).toBe("unknown");
  });
});

describe("judging past the main menu", () => {
  const loadedThen = (...after: string[]) => [
    "[HugsLib] v11.0.4",
    "Verse.LoadedModManager:CreateModClasses",
    ...after,
  ];

  it("fails a trial that loaded and then died", () => {
    // The search used to stop the moment mod construction was reached, which is the
    // earliest point at which nothing has gone wrong yet. Every post-menu crash passed.
    const result = bootVerdict(
      loadedThen(
        "Could not allocate memory: System out of memory!",
        "A crash has been intercepted by the crash handler. For call stack and other details, see...",
      ),
    );
    expect(result.verdict).toBe("crashed-after-load");
    expect(isBootFailure(result.verdict)).toBe(true);
  });

  it("still calls a death before the load a plain crash", () => {
    const result = bootVerdict(["Could not allocate memory: System out of memory!"]);
    expect(result.verdict).toBe("crashed");
  });

  it("stops watching a load hunt once the list loads, and a play hunt only when it ends", () => {
    // The same run, judged against two different questions. A fault that needs a colony is
    // still ahead of a game that has merely finished loading.
    const loaded = bootVerdict(loadedThen()).verdict;
    expect(loaded).toBe("loaded");
    expect(isDecided(loaded, "load")).toBe(true);
    expect(isDecided(loaded, "play")).toBe(false);
  });

  it("ends a play hunt the moment the game dies, whichever question was asked", () => {
    const died = bootVerdict(loadedThen("A crash has been intercepted by the crash handler.")).verdict;
    expect(isDecided(died, "play")).toBe(true);
    expect(isDecided(died, "load")).toBe(true);
  });
});

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

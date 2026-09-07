import { describe, expect, it } from "vitest";
import { applyVerdict, isSettled, pulledIn, startBisect, trialOrder, trialsLeft } from "./bisect";
import type { ModEntry } from "./types";

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

const ORDER = ["ludeon.rimworld", "brrainz.harmony", "a", "b", "c", "d", "e", "f", "g", "h"];

describe("starting a search", () => {
  it("never puts official content or the bootstrap layer on trial", () => {
    const session = startBisect(ORDER);
    expect(session.pinned).toEqual(["ludeon.rimworld", "brrainz.harmony"]);
    expect(session.suspects).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  it("puts half the suspects in the first trial", () => {
    expect(startBisect(ORDER).testing).toEqual(["a", "b", "c", "d"]);
  });
});

describe("narrowing", () => {
  /** The fault showing up with these mods enabled means it lives among them. */
  it("keeps the tested half when the fault is still there", () => {
    const next = applyVerdict(startBisect(ORDER), "still-there");
    expect(next.suspects).toEqual(["a", "b", "c", "d"]);
    expect(next.testing).toEqual(["a", "b"]);
  });

  it("keeps the other half when the fault is gone", () => {
    const next = applyVerdict(startBisect(ORDER), "gone");
    expect(next.suspects).toEqual(["e", "f", "g", "h"]);
  });

  it("reaches one suspect in a number of trials that halves the list", () => {
    let session = startBisect(ORDER);
    let trials = 0;
    while (!isSettled(session)) {
      session = applyVerdict(session, "still-there");
      trials++;
    }
    expect(session.suspects).toEqual(["a"]);
    // Eight suspects, so three halvings.
    expect(trials).toBe(3);
  });

  it("keeps a record of what each trial showed", () => {
    const session = applyVerdict(applyVerdict(startBisect(ORDER), "gone"), "still-there");
    expect(session.trials).toEqual([
      { step: 1, tested: 4, verdict: "gone" },
      { step: 2, tested: 2, verdict: "still-there" },
    ]);
  });

  it("counts down the trials left, so the search reads as finite", () => {
    expect(trialsLeft(startBisect(ORDER))).toBe(3);
    expect(trialsLeft(applyVerdict(startBisect(ORDER), "still-there"))).toBe(2);
  });
});

/**
 * The trap this whole feature turns on. Splitting a list in half breaks mods whose
 * dependencies landed in the other half, and those failures look exactly like the fault
 * being searched for, so the search follows the wrong half and settles on an innocent mod.
 */
describe("building a trial that means something", () => {
  const mods = [
    mod("ludeon.rimworld"),
    mod("brrainz.harmony"),
    mod("a", { dependencies: [{ packageId: "h" }] }),
    mod("b"),
    mod("c"),
    mod("d"),
    mod("e"),
    mod("f"),
    mod("g"),
    mod("h"),
  ];

  it("pulls in a dependency that fell on the other side of the split", () => {
    const session = startBisect(ORDER);
    const order = trialOrder(session, mods);
    expect(order).toContain("h");
    expect(pulledIn(session, mods)).toEqual(["h"]);
  });

  it("follows dependencies of dependencies rather than stopping one level down", () => {
    const chained = [
      mod("ludeon.rimworld"),
      mod("a", { dependencies: [{ packageId: "g" }] }),
      mod("g", { dependencies: [{ packageId: "h" }] }),
      mod("h"),
      mod("b"),
    ];
    const session = startBisect(["ludeon.rimworld", "a", "b", "g", "h"]);
    expect(trialOrder(session, chained)).toEqual(expect.arrayContaining(["g", "h"]));
  });

  /** Being needed by something is not evidence of innocence. */
  it("leaves a pulled-in mod on the suspect list", () => {
    const session = startBisect(ORDER);
    expect(session.suspects).toContain("h");
    expect(trialOrder(session, mods)).toContain("h");
    expect(applyVerdict(session, "gone").suspects).toContain("h");
  });

  it("never invents a dependency that is not installed", () => {
    const missing = [mod("ludeon.rimworld"), mod("a", { dependencies: [{ packageId: "nope" }] })];
    expect(trialOrder(startBisect(["ludeon.rimworld", "a"]), missing)).not.toContain("nope");
  });

  it("always keeps the pinned mods, whatever the split", () => {
    const session = applyVerdict(startBisect(ORDER), "still-there");
    const order = trialOrder(session, mods);
    expect(order).toContain("ludeon.rimworld");
    expect(order).toContain("brrainz.harmony");
  });
});

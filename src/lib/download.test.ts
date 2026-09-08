import { describe, expect, it } from "vitest";
import { slug } from "./download";

describe("slug", () => {
  it("turns a name someone typed into something a filesystem accepts", () => {
    expect(slug("Modded Game Setup")).toBe("modded-game-setup");
    expect(slug("1.6 / vanilla+  (test)")).toBe("1-6-vanilla-test");
  });

  it("never returns an empty name", () => {
    // A modpack called "***" would otherwise produce a file with no name at all.
    expect(slug("***")).toBe("modpack");
    expect(slug("")).toBe("modpack");
    expect(slug("   ")).toBe("modpack");
  });
});

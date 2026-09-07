import { describe, expect, it } from "vitest";
import { workshopIdOf } from "./Subscribe";

describe("workshopIdOf", () => {
  it("reads the id out of a Workshop item link", () => {
    expect(workshopIdOf("https://steamcommunity.com/sharedfiles/filedetails/?id=2009463077")).toBe(
      "2009463077",
    );
  });

  it("ignores a search link, which carries an app id and no item", () => {
    // The trap this regex exists for: `appid=294100` ends in `id=294100`, and matching it
    // would offer to subscribe someone to the number that means RimWorld itself.
    expect(
      workshopIdOf("https://steamcommunity.com/workshop/browse/?appid=294100&searchtext=Rimworld"),
    ).toBeNull();
  });

  it("reads an id that is not the first parameter", () => {
    expect(workshopIdOf("https://steamcommunity.com/sharedfiles/filedetails/?l=english&id=818773962")).toBe(
      "818773962",
    );
  });

  it("has nothing to read from a link that names no item, or from no link", () => {
    expect(workshopIdOf("https://rimworldgame.com/")).toBeNull();
    expect(workshopIdOf(undefined)).toBeNull();
  });
});

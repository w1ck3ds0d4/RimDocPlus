// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { clearHistory, loadHistory, record } from "./history";

describe("the journal", () => {
  beforeEach(() => localStorage.clear());

  it("puts the newest entry first", () => {
    record({ kind: "order", summary: "first" });
    record({ kind: "launch", summary: "second" });
    expect(loadHistory().map((e) => e.summary)).toEqual(["second", "first"]);
  });

  it("reads through to storage rather than trusting a caller's copy", () => {
    // Entries are recorded from several places. A stale in-memory list would drop whichever
    // change the other one happened to write.
    record({ kind: "order", summary: "written elsewhere" });
    const returned = record({ kind: "repair", summary: "written here" });
    expect(returned.map((e) => e.summary)).toEqual(["written here", "written elsewhere"]);
  });

  it("stays bounded, because a journal is not an audit log", () => {
    for (let i = 0; i < 205; i++) record({ kind: "order", summary: `entry ${i}` });
    const journal = loadHistory();
    expect(journal).toHaveLength(200);
    expect(journal[0].summary).toBe("entry 204");
  });

  it("gives every entry an id of its own", () => {
    for (let i = 0; i < 50; i++) record({ kind: "order", summary: "same text" });
    const ids = new Set(loadHistory().map((e) => e.id));
    expect(ids.size).toBe(50);
  });

  it("survives a store holding something that is not a journal", () => {
    // The key is discovered rather than written down, so this cannot pass by corrupting
    // somewhere the journal does not live. It did, the first time it was written.
    record({ kind: "order", summary: "anything" });
    const key = Object.keys(localStorage)[0];
    expect(key).toBeTruthy();

    localStorage.setItem(key, "{not json");
    expect(loadHistory()).toEqual([]);
    localStorage.setItem(key, '{"a":1}');
    expect(loadHistory()).toEqual([]);
  });

  it("empties", () => {
    record({ kind: "order", summary: "gone soon" });
    expect(clearHistory()).toEqual([]);
    expect(loadHistory()).toEqual([]);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { resetApp, storedKeys } from "./reset";

/**
 * A store standing in for the browser's, since these tests run under node.
 *
 * Only what the sweep actually uses: enumeration, removal, and the indexing that
 * `Object.keys` walks. What is being tested is which keys go, not the browser.
 */
function fakeStorage(entries: Record<string, string>) {
  const store: Record<string, string> = { ...entries };
  return {
    ...store,
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
      delete (globalThis.localStorage as unknown as Record<string, unknown>)[key];
    },
  };
}

function install(entries: Record<string, string>) {
  Object.defineProperty(globalThis, "localStorage", {
    value: fakeStorage(entries),
    configurable: true,
    writable: true,
  });
}

describe("resetting the app", () => {
  beforeEach(() => install({}));

  it("forgets everything the app stored", () => {
    install({
      "rimdoc.modpacks.v1": "[]",
      "rimdoc.history.v1": "[]",
      "rimdoc.devMode": "1",
    });

    expect(storedKeys().sort()).toEqual(["rimdoc.devMode", "rimdoc.history.v1", "rimdoc.modpacks.v1"]);
    expect(resetApp()).toHaveLength(3);
    expect(storedKeys()).toEqual([]);
    expect(localStorage.getItem("rimdoc.modpacks.v1")).toBeNull();
  });

  it("leaves anything that is not the app's alone", () => {
    // The desktop build has this origin to itself, but sweeping the whole store would be
    // wrong in the browser build and wrong the first time anything else shared it.
    install({ "rimdoc.history.v1": "[]", theme: "dark" });

    expect(resetApp()).toEqual(["rimdoc.history.v1"]);
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("reports nothing to clear rather than failing when there is nothing", () => {
    expect(storedKeys()).toEqual([]);
    expect(resetApp()).toEqual([]);
  });

  it("reports none rather than throwing where storage is blocked", () => {
    // A private window throws on the very first access. The reset button reads this to
    // decide what to say, so throwing here would take the Settings tab down with it.
    Object.defineProperty(globalThis, "localStorage", {
      get() {
        throw new Error("The operation is insecure.");
      },
      configurable: true,
    });

    expect(storedKeys()).toEqual([]);
    expect(resetApp()).toEqual([]);
  });
});

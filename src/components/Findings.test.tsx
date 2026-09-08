// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { FindingList } from "./Findings";
import type { Finding } from "../lib/types";

afterEach(cleanup);

function finding(over: Partial<Finding>): Finding {
  return {
    id: over.title ?? "f",
    rule: "log:exception",
    severity: "error",
    title: "A fault",
    detail: "",
    packageIds: [],
    ...over,
  };
}

/**
 * One of the three lists, by the class that distinguishes it.
 *
 * The class is the grouping here: there is no landmark or heading association to query by,
 * and walking from the heading found the first list on the page rather than the one under
 * it, which made two of these tests pass while proving nothing.
 */
function list(container: HTMLElement, which: "work" | "notes" | "settled"): HTMLElement {
  const selector = which === "work" ? ".finding-list:not(.notes):not(.settled)" : `.finding-list.${which}`;
  const found = container.querySelector(selector);
  if (!found) throw new Error(`no ${which} list rendered`);
  return found as HTMLElement;
}

describe("FindingList", () => {
  it("puts a crash above the fold even though nothing can repair it", () => {
    // The bug this file was written for. The split keyed on whether a repair existed, and
    // nothing can automate a null dereference, so a NullReferenceException the game threw
    // six times was filed under Observations beneath a note about patch overrides.
    const view = render(
      <FindingList
        findings={[
          finding({ title: "NullReferenceException", severity: "critical" }),
          finding({ title: "An override", severity: "info", observation: true }),
        ]}
        empty="nothing"
      />,
    );

    const { container } = view;
    expect(within(list(container, "notes")).queryByText("NullReferenceException")).toBeNull();
    expect(within(list(container, "notes")).getByText("An override")).toBeTruthy();
    expect(within(list(container, "work")).getByText("NullReferenceException")).toBeTruthy();
  });

  it("keeps an observation out of the work list even when it has a repair", () => {
    // And the same mistake pointing the other way: a patch override carries a repair, and
    // twelve of them sat above the real faults because of it.
    const view = render(
      <FindingList
        findings={[
          finding({
            title: "Vanilla Plants Expanded overrides 29 patch targets",
            severity: "info",
            observation: true,
            fix: { kind: "disable-overriding-mod", label: "Repair", tier: 1, auto: false },
          }),
        ]}
        empty="nothing"
      />,
    );

    expect(screen.getByText(/Observations/)).toBeTruthy();
    expect(within(list(view.container, "notes")).getByText(/Vanilla Plants Expanded/)).toBeTruthy();
  });

  it("separates what the scan proved is already gone", () => {
    const view = render(
      <FindingList
        findings={[
          finding({ title: "Still true", severity: "error" }),
          finding({ title: "Fixed since", severity: "error", stale: "the scan proves it" }),
        ]}
        empty="nothing"
      />,
    );

    expect(screen.getByText(/Already dealt with/)).toBeTruthy();
    expect(within(list(view.container, "settled")).getByText("Fixed since")).toBeTruthy();
    expect(within(list(view.container, "work")).getByText("Still true")).toBeTruthy();
  });

  it("says so plainly when a list has nothing in it", () => {
    render(<FindingList findings={[]} empty="This load order is structurally sound." />);
    expect(screen.getByText("This load order is structurally sound.")).toBeTruthy();
  });

  it("does not let a page of observations read as work waiting", () => {
    // With no actionable findings at all, the tab has to say that, or a reader sees a long
    // list and assumes every line is theirs to do.
    render(
      <FindingList
        findings={[finding({ title: "An override", severity: "info", observation: true })]}
        empty="nothing"
      />,
    );
    expect(screen.getByText(/not work waiting to be done/)).toBeTruthy();
  });
});

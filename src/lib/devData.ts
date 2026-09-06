import type { ScanResult, WorkshopCache } from "./types";

/**
 * Fixture loading for the browser preview.
 *
 * `pnpm scan` writes these from a real install and they are gitignored, so they may not
 * exist. import.meta.glob resolves to an empty map when the file is absent instead of
 * failing the build, which import() of a missing path would do.
 */
const scanFixture = import.meta.glob("../dev-data/scan.json", { import: "default" });
const sessionFixture = import.meta.glob("../dev-data/session.json", { import: "default" });
const workshopFixture = import.meta.glob("../dev-data/workshop.json", { import: "default" });

async function first<T>(modules: Record<string, () => Promise<unknown>>): Promise<T | null> {
  const loader = Object.values(modules)[0];
  return loader ? ((await loader()) as T) : null;
}

export function loadScan(): Promise<ScanResult | null> {
  return first<ScanResult>(scanFixture);
}

export function loadSession(): Promise<{ path: string; text: string } | null> {
  return first<{ path: string; text: string }>(sessionFixture);
}

export function loadWorkshop(): Promise<WorkshopCache | null> {
  return first<WorkshopCache>(workshopFixture);
}

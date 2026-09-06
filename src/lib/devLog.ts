export interface CapturedEntry {
  level: "error" | "warn";
  text: string;
  count: number;
  at: string;
}

const MAX_ENTRIES = 200;
const entries: CapturedEntry[] = [];
const listeners = new Set<() => void>();
let installed = false;

/**
 * Mirror console errors and warnings into the app.
 *
 * React reports duplicate keys, failed prop types and render warnings to the console and
 * nowhere else, so they are invisible to anyone not already looking at devtools. A tool
 * whose subject is diagnosing failures should surface its own.
 *
 * Installed from the entry module rather than a component, because the errors worth
 * catching most are the ones thrown before any component has mounted.
 */
export function installDevLog(): void {
  if (installed || typeof console === "undefined") return;
  installed = true;

  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      record(level, args);
      original(...args);
    };
  }

  window.addEventListener("error", (event) => record("error", [event.message]));
  window.addEventListener("unhandledrejection", (event) =>
    record("error", [`Unhandled rejection: ${String(event.reason)}`]),
  );
}

function record(level: "error" | "warn", args: unknown[]): void {
  const text = args.map(describe).join(" ").slice(0, 600);
  if (!text.trim()) return;

  // React repeats the same warning per render; a count is more useful than 400 rows.
  const existing = entries.find((e) => e.level === level && e.text === text);
  if (existing) {
    existing.count++;
  } else {
    entries.unshift({ level, text, count: 1, at: new Date().toISOString().slice(11, 19) });
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  }
  for (const listener of listeners) listener();
}

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function getDevLog(): CapturedEntry[] {
  return [...entries];
}

export function clearDevLog(): void {
  entries.length = 0;
  for (const listener of listeners) listener();
}

export function subscribeDevLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

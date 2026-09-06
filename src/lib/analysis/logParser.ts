import type { Finding, ModEntry, Severity } from "../types";

/** Hardware and build facts scraped from the log header. Drives the performance rules. */
export interface SessionEnvironment {
  gameVersion?: string;
  unityVersion?: string;
  renderer?: string;
  vramMb?: number;
  gpuDriver?: string;
  savePath?: string;
  commandLine?: string;
}

/** One deduplicated log event, with every occurrence collapsed into `count`. */
export interface LogEvent {
  fingerprint: string;
  category: string;
  severity: Severity;
  message: string;
  /** Stack frames, when the entry carried a trace. */
  frames: string[];
  /** Namespace roots pulled from the frames, used to attribute the event to a mod. */
  namespaces: string[];
  count: number;
  firstLine: number;
}

export interface SessionAnalysis {
  environment: SessionEnvironment;
  events: LogEvent[];
  /** Milliseconds spent in named startup phases, when the log reports them. */
  timings: { label: string; ms: number }[];
  totalLines: number;
}

/**
 * Unity writes these whenever a native library probe misses, dozens of times per launch,
 * on a perfectly healthy install. Filtering them out is most of what makes a RimWorld log
 * readable, so it happens before anything else looks at the text.
 */
const NOISE = [
  /^Fallback handler could not load library/,
  /^Non-matching Profiler.EndSample/,
  /^Unloading \d+ unused Assets/,
  /^Loading .* file .*/,
  /^UnloadTime: /,
  /^\s*$/,
];

interface Matcher {
  category: string;
  severity: Severity;
  test: RegExp;
}

/**
 * Ordered most-specific first. The first matcher that hits wins, so a recognised RimWorld
 * condition beats the generic exception fallback and gets a real explanation attached.
 */
const MATCHERS: Matcher[] = [
  {
    category: "ghost-subscription",
    severity: "warning",
    test: /^Created WorkshopItem for (\d+) but there is no folder for it/,
  },
  {
    category: "duplicate-package-id",
    severity: "error",
    test: /^Tried loading mod with the same packageId multiple times: (\S+?)\./,
  },
  { category: "mod-init-failure", severity: "critical", test: /^Error while instantiating a mod of type/ },
  { category: "xml-patch-failure", severity: "error", test: /^XML error:/ },
  { category: "xml-patch-failure", severity: "error", test: /Could not find a node matching|PatchOperation/ },
  { category: "cross-reference", severity: "error", test: /^Could not resolve cross-reference/ },
  { category: "missing-type", severity: "error", test: /^Could not find a type named/ },
  {
    category: "def-not-found",
    severity: "error",
    test: /^Could not find \S+ named|^Failed to find \S+ named/,
  },
  { category: "config-error", severity: "error", test: /^Config error in/ },
  { category: "vsync-broken", severity: "warning", test: /^Direct3D: detected that vsync is broken/ },
  {
    category: "refresh-rate-drift",
    severity: "warning",
    test: /^Direct3D: detected that using refresh rate/,
  },
  { category: "exception", severity: "critical", test: /Exception|^Error |^\[ERROR\]/ },
];

export function analyzeLog(text: string): SessionAnalysis {
  const lines = text.split(/\r?\n/);
  const environment = readEnvironment(lines);
  const timings = readTimings(lines);
  const clusters = new Map<string, LogEvent>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (NOISE.some((n) => n.test(line))) continue;
    // Stack frames belong to the entry above them, never to themselves.
    if (isFrame(line)) continue;

    const matcher = MATCHERS.find((m) => m.test.test(line));
    if (!matcher) continue;

    const frames = collectFrames(lines, i + 1);
    const message = line.trim();
    const fingerprint = fingerprintOf(matcher.category, message, frames);
    const existing = clusters.get(fingerprint);
    if (existing) {
      existing.count++;
      continue;
    }
    clusters.set(fingerprint, {
      fingerprint,
      category: matcher.category,
      severity: matcher.severity,
      message,
      frames,
      namespaces: namespacesOf(frames),
      count: 1,
      firstLine: i + 1,
    });
  }

  return {
    environment,
    events: [...clusters.values()],
    timings,
    totalLines: lines.length,
  };
}

function isFrame(line: string): boolean {
  return /^\s+at\s|^\s*at\s[\w.<>]+\s*\(|^\s*--- End of|^\s*Rethrow/.test(line);
}

function collectFrames(lines: string[], from: number): string[] {
  const frames: string[] = [];
  for (let i = from; i < lines.length && frames.length < 40; i++) {
    if (!isFrame(lines[i])) break;
    frames.push(lines[i].trim());
  }
  return frames;
}

/**
 * The same fault reported from the same place must collapse to one row. Numbers are
 * normalised out of the message because ids, coordinates and tick counts vary per
 * occurrence while the underlying fault does not.
 */
function fingerprintOf(category: string, message: string, frames: string[]): string {
  const normalised = message.replace(/\d+/g, "#").slice(0, 200);
  const top = frames.slice(0, 3).map((f) => f.replace(/\s*\[0x[0-9a-f]+\].*$/i, ""));
  return [category, normalised, ...top].join("|");
}

/** Namespace roots from stack frames, e.g. "at MedievalOverhaul.Foo.Bar()" -> MedievalOverhaul. */
function namespacesOf(frames: string[]): string[] {
  const roots = new Set<string>();
  for (const frame of frames) {
    const m = /at\s+([A-Za-z_][\w]*)\./.exec(frame);
    if (m) roots.add(m[1]);
  }
  return [...roots];
}

function readEnvironment(lines: string[]): SessionEnvironment {
  const env: SessionEnvironment = {};
  for (const line of lines.slice(0, 400)) {
    let m: RegExpExecArray | null;
    if ((m = /^RimWorld (\S+ rev\d+)/.exec(line))) env.gameVersion = m[1];
    else if ((m = /^Initialize engine version: (\S+)/.exec(line))) env.unityVersion = m[1];
    else if ((m = /^\s*Renderer:\s*(.+)$/.exec(line))) env.renderer = m[1].trim();
    else if ((m = /^\s*VRAM:\s*(\d+) MB/.exec(line))) env.vramMb = Number(m[1]);
    else if ((m = /^\s*Driver:\s*(\S+)/.exec(line))) env.gpuDriver = m[1];
    else if ((m = /^Command line arguments: (.+)$/.exec(line))) env.commandLine = m[1].trim();
    else if ((m = /^Save data folder overridden to (.+)$/.exec(line))) env.savePath = m[1].trim();
  }
  return env;
}

/** Startup phase costs the log volunteers, e.g. Prepatcher's serialize step. */
function readTimings(lines: string[]): { label: string; ms: number }[] {
  const timings: { label: string; ms: number }[] = [];
  for (const line of lines) {
    const m = /^(.*?)\s+took\s+([\d.]+)\s*(ms|s)\b/.exec(line.trim());
    if (!m) continue;
    const ms = Number(m[2]) * (m[3] === "s" ? 1000 : 1);
    if (Number.isFinite(ms)) timings.push({ label: m[1].replace(/[:,]$/, ""), ms });
  }
  return timings.sort((a, b) => b.ms - a.ms).slice(0, 10);
}

/** Human-readable explanation and repair for each recognised category. */
const EXPLANATIONS: Record<string, { title: (e: LogEvent) => string; detail: string; fixKind?: string }> = {
  "ghost-subscription": {
    title: () => "Subscribed Workshop items never downloaded",
    detail:
      "Steam registered the subscription but no folder arrived. The mod is not actually installed, so " +
      "anything depending on it fails. Usually fixed by unsubscribing and resubscribing.",
    fixKind: "resubscribe-workshop-item",
  },
  "duplicate-package-id": {
    title: (e) => `Duplicate mod loaded: ${/multiple times: (\S+?)\./.exec(e.message)?.[1] ?? "unknown"}`,
    detail:
      "The same packageId exists in more than one folder, typically a Workshop copy and a local copy. " +
      "RimWorld keeps one and silently ignores the other, so you cannot tell which version is running.",
    fixKind: "pick-duplicate-winner",
  },
  "mod-init-failure": {
    title: (e) => `Mod failed to initialise: ${/type (\S+?)[:.]/.exec(e.message)?.[1] ?? "unknown"}`,
    detail:
      "The mod threw while constructing its settings object. Its settings are unreadable and any feature " +
      "gated behind them is dead for the whole session.",
    fixKind: "reset-mod-settings",
  },
  "vsync-broken": {
    title: () => "VSync is not limiting the frame rate",
    detail:
      "Direct3D reports vsync as broken, so the render loop runs unthrottled and burns GPU headroom that " +
      "the simulation thread needs. Capping the frame rate externally recovers it.",
    fixKind: "cap-frame-rate",
  },
  "refresh-rate-drift": {
    title: () => "Refresh rate causes time drift",
    detail:
      "The game stopped trusting the reported refresh rate and fell back to CPU timestamps, which shows " +
      "up as uneven pacing. Common on laptops with hybrid graphics and variable refresh displays.",
    fixKind: "force-dgpu",
  },
  "xml-patch-failure": {
    title: () => "XML patch did not apply",
    detail:
      "A PatchOperation could not find its target node. The patch silently did nothing, so the mod is " +
      "loaded but part of its content is missing.",
    fixKind: "repair-xpath",
  },
  "cross-reference": {
    title: () => "Unresolved cross-reference",
    detail: "A def points at another def that does not exist, usually a missing or disabled dependency.",
  },
  "missing-type": {
    title: () => "Missing type",
    detail:
      "A def references a C# type that no assembly provides. Either the mod supplying it is disabled, or " +
      "the type was renamed in a newer version of the game.",
  },
  "def-not-found": {
    title: () => "Def not found",
    detail: "Referenced content does not exist in this load.",
  },
  "config-error": { title: () => "Def config error", detail: "A def failed validation and was rejected." },
  exception: { title: () => "Unhandled exception", detail: "Code threw and the operation did not complete." },
};

/**
 * Turn clustered log events into findings, attributing each to a mod where the stack
 * frames allow it. Attribution is by namespace root against mod names and package ids,
 * which is what makes a wall of NullReferences point at something actionable.
 */
export function findingsFromLog(analysis: SessionAnalysis, mods: ModEntry[]): Finding[] {
  const index = buildAttributionIndex(mods);
  return analysis.events.map((event) => {
    const explanation = EXPLANATIONS[event.category];
    const attributed = event.namespaces
      .map((ns) => index.get(ns.toLowerCase()))
      .filter((id): id is string => !!id);
    const inline = inlineAttribution(event.message, index);
    const packageIds = [...new Set([...attributed, ...inline])];

    return {
      id: event.fingerprint,
      rule: `log:${event.category}`,
      severity: event.severity,
      title: explanation?.title(event) ?? truncate(event.message, 90),
      detail: explanation?.detail ?? event.message,
      packageIds,
      count: event.count,
      fix: explanation?.fixKind
        ? { kind: explanation.fixKind, label: "Repair", tier: 1 as const, auto: false }
        : undefined,
    };
  });
}

/** Lowercased lookup from namespace-ish token to packageId. */
function buildAttributionIndex(mods: ModEntry[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const mod of mods) {
    index.set(mod.packageId, mod.packageId);
    // "oskarpotocki.vanillafactionsexpanded.core" -> "core", "vanillafactionsexpanded"
    for (const part of mod.packageId.split(".")) {
      if (part.length > 4 && !index.has(part)) index.set(part, mod.packageId);
    }
    const squashed = mod.name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    if (squashed.length > 4 && !index.has(squashed)) index.set(squashed, mod.packageId);
  }
  return index;
}

/** Some entries name the mod in the message rather than in a stack frame. */
function inlineAttribution(message: string, index: Map<string, string>): string[] {
  const found: string[] = [];
  for (const token of message.matchAll(/[A-Za-z][A-Za-z0-9_.]{4,}/g)) {
    const hit = index.get(token[0].toLowerCase()) ?? index.get(token[0].split(".")[0].toLowerCase());
    if (hit) found.push(hit);
  }
  return found;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

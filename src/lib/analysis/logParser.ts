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
  /** Stack frames and Harmony patch annotations belonging to this entry, in order. */
  frames: string[];
  /** Namespace roots pulled from the frames, used to attribute the event to a mod. */
  namespaces: string[];
  /** Exception type name without its namespace, when the entry carried one. */
  exceptionType?: string;
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
  /^UnloadTime: /,
  /^\s*$/,
  // Logs truncated mid-write leave a run of NUL bytes behind.
  /^[\u0000\uFFFD]+$/,
];

/**
 * RimWorld tags each distinct error with a reference id so repeats can be collapsed. The
 * tag sits between the message and its stack trace, which means a naive "is the next line
 * a frame" check finds nothing and every trace is lost.
 */
const REF_MARKER = /^\[Ref [0-9A-Fa-f]+\]\s*$/;

/** Namespace roots that belong to the engine or the patch library, not to a mod. */
const FRAMEWORK_ROOTS = new Set([
  "System",
  "Mono",
  "UnityEngine",
  "Verse",
  "RimWorld",
  "HarmonyLib",
  "Prepatcher",
]);

export type FrameKind = "patch" | "mod" | "framework" | "separator";

/**
 * Classify a trace line so the UI can grey out engine noise and surface the handful of
 * frames that actually belong to a mod. In a 40-frame Mono trace, typically three lines
 * matter and the rest is reflection plumbing.
 */
export function frameKind(frame: string): FrameKind {
  if (/^-\s+(PREFIX|POSTFIX|TRANSPILER|FINALIZER)\s/.test(frame)) return "patch";
  if (/^---/.test(frame) || /^\(wrapper\s/.test(frame)) return "separator";
  const root = /^at\s+([A-Za-z_][\w]*)\./.exec(frame)?.[1];
  if (!root) return "separator";
  return FRAMEWORK_ROOTS.has(root) ? "framework" : "mod";
}

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
    category: "playdata-reset",
    severity: "critical",
    test: /^Caught exception while loading play data but there are active mods other than Core/,
  },
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
    // Trace lines belong to the entry above them. Skipping them here is what stops a
    // frame such as "(wrapper ...System.Exception&)" being reported as its own error.
    if (isFrame(line) || REF_MARKER.test(line)) continue;

    const matcher = MATCHERS.find((m) => m.test.test(line));
    if (!matcher) continue;

    const { frames, next } = collectFrames(lines, i + 1);
    const message = line.trim();
    const fingerprint = fingerprintOf(matcher.category, message, frames);
    const existing = clusters.get(fingerprint);
    if (existing) {
      existing.count++;
    } else {
      clusters.set(fingerprint, {
        fingerprint,
        category: matcher.category,
        severity: matcher.severity,
        message,
        frames,
        namespaces: namespacesOf(frames, message),
        exceptionType: exceptionTypeOf(message),
        count: 1,
        firstLine: i + 1,
      });
    }
    // Jump past the trace we just consumed so none of it is re-examined.
    i = next - 1;
  }

  return { environment, events: [...clusters.values()], timings, totalLines: lines.length };
}

/**
 * A trace line. Mono emits several shapes and only one of them starts with "at": native
 * wrapper entries, inner-exception separators, and the Harmony patch annotations RimWorld
 * injects, which are the most useful lines in the whole trace because they name the mod.
 */
function isFrame(line: string): boolean {
  return (
    /^\s+at\s/.test(line) ||
    /^\(wrapper\s/.test(line) ||
    /^\s*---\s*End of inner exception stack trace\s*---/.test(line) ||
    /^\s*-\s+(PREFIX|POSTFIX|TRANSPILER|FINALIZER)\s/.test(line)
  );
}

/**
 * Gather the trace under an entry, stepping over the reference tags RimWorld interleaves.
 * Tags trailing with no frame after them belong to the next entry, so they are handed
 * back rather than swallowed.
 */
function collectFrames(lines: string[], from: number): { frames: string[]; next: number } {
  const frames: string[] = [];
  let i = from;
  let pendingRefs = 0;

  while (i < lines.length && frames.length < 80) {
    const line = lines[i];
    if (REF_MARKER.test(line)) {
      pendingRefs++;
      i++;
      continue;
    }
    if (!isFrame(line)) break;
    frames.push(line.trim());
    pendingRefs = 0;
    i++;
  }

  return frames.length ? { frames, next: i - pendingRefs } : { frames: [], next: from };
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

/** "System.Reflection.TargetInvocationException" -> "TargetInvocationException". */
function exceptionTypeOf(message: string): string | undefined {
  const m = /([A-Za-z_][\w.]*(?:Exception|Error))\b/.exec(message);
  return m ? m[1].split(".").pop() : undefined;
}

/**
 * Namespace roots to attribute the event with. Harmony patch annotations are read first
 * because they name the patching mod outright, which beats guessing from a frame.
 */
function namespacesOf(frames: string[], message: string): string[] {
  const roots = new Set<string>();
  const add = (root?: string) => {
    if (root && !FRAMEWORK_ROOTS.has(root)) roots.add(root);
  };

  for (const frame of frames) {
    const patch = /^-\s+(?:PREFIX|POSTFIX|TRANSPILER|FINALIZER)\s+([\w.]+)/.exec(frame);
    if (patch) {
      // "UnlimitedHugs.HugsLib" identifies the mod on either half of the dot.
      patch[1].split(".").forEach((part) => add(part));
      continue;
    }
    const at = /^at\s+([A-Za-z_][\w]*)\./.exec(frame);
    add(at?.[1]);
  }

  // "Error while instantiating a mod of type MedievalOverhaul.Settings" names it inline.
  add(/type\s+([A-Za-z_][\w]*)\./.exec(message)?.[1]);
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

interface Explanation {
  title: (e: LogEvent) => string;
  detail: string;
  fixKind?: string;
  /** Arguments the repair needs, read back out of the log line that raised it. */
  params?: (e: LogEvent) => Record<string, string | string[]>;
}

/** Human-readable explanation and repair for each recognised category. */
const EXPLANATIONS: Record<string, Explanation> = {
  "playdata-reset": {
    title: () => "RimWorld reset your mod list after a load failure",
    detail:
      "Loading threw with mods active, so the game rewrote ModsConfig.xml back to Core only and " +
      "retried. Any load order you had is gone. Restore it from a modpack before launching again.",
    fixKind: "restore-mods-config",
  },
  "ghost-subscription": {
    title: () => "Subscribed Workshop items never downloaded",
    detail:
      "Steam registered the subscription but no folder arrived. The mod is not actually installed, so " +
      "anything depending on it fails. Usually fixed by unsubscribing and resubscribing.",
    fixKind: "resubscribe-workshop-item",
    params: (e) => ({ steamIds: [/for (\d+)/.exec(e.message)?.[1] ?? ""].filter(Boolean) }),
  },
  "duplicate-package-id": {
    title: (e) => `Duplicate mod loaded: ${duplicateIdOf(e) ?? "unknown"}`,
    detail:
      "The same packageId exists in more than one folder, typically a Workshop copy and a local copy. " +
      "RimWorld keeps one and silently ignores the other, so you cannot tell which version is running.",
    fixKind: "pick-duplicate-winner",
    // The log names the mod but knows nothing of folders, which is what the repair acts on.
    // Without this the repair was handed no arguments at all and quietly produced nothing,
    // so the finding carried a Repair button that could never do anything.
    params: (e) => ({ packageId: duplicateIdOf(e)?.toLowerCase() ?? "" }),
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
    const packageIds = [...new Set([...attributed, ...inlineAttribution(event.message, index)])];

    return {
      id: event.fingerprint,
      rule: `log:${event.category}`,
      severity: event.severity,
      title: explanation?.title(event) ?? genericTitle(event),
      detail: explanation?.detail ?? event.message,
      packageIds,
      count: event.count,
      frames: event.frames,
      firstLine: event.firstLine,
      stale: settledSince(event, mods),
      fix: explanation?.fixKind
        ? {
            kind: explanation.fixKind,
            label: "Repair",
            tier: 1 as const,
            auto: false,
            params: explanation.params?.(event),
          }
        : undefined,
    };
  });
}

/** The Workshop file id a ghost-subscription complaint names. */
function ghostIdOf(event: LogEvent): string | undefined {
  return /WorkshopItem for (\d+)/.exec(event.message)?.[1];
}

/**
 * Whether the scan proves a logged fault has already been dealt with.
 *
 * The log records a run that has finished, so a fault in it may well have been fixed since,
 * possibly by this very app. Where the current files can settle the question, saying so
 * beats offering a repair that would find nothing to do. Only claimed where the scan is
 * genuinely decisive: most faults leave no trace on disk, and silence is not proof.
 */
function settledSince(event: LogEvent, mods: ModEntry[]): string | undefined {
  if (event.category === "duplicate-package-id") {
    const id = duplicateIdOf(event)?.toLowerCase();
    if (!id) return undefined;
    // Exactly one copy is proof it was resolved. None is not: the id may be from a mod since
    // uninstalled, or one this parser read wrongly, and neither is grounds for a claim.
    const copies = mods.filter((m) => m.packageId === id).length;
    return copies === 1
      ? `Only one copy of ${id} is installed now, so this was resolved after the log was written.`
      : undefined;
  }

  if (event.category === "ghost-subscription") {
    // The complaint is that Steam registered a subscription and no folder arrived. A mod
    // carrying that file id in the scan is the folder having arrived since, which is what
    // resubscribing is meant to achieve and the only way to know it worked.
    const id = ghostIdOf(event);
    if (!id) return undefined;
    const arrived = mods.find((m) => m.steamId === id);
    return arrived
      ? `${arrived.name} has downloaded since, so the subscription is no longer a ghost.`
      : undefined;
  }

  return undefined;
}

/**
 * The packageId a duplicate-load complaint is about, exactly as the log wrote it.
 *
 * The trailing dot ends the sentence, and package ids contain dots of their own. A lazy
 * match stopped at the first one and yielded "orion" out of "Orion.Hospitality.", which
 * matched no installed mod: the finding was titled with half an id and its repair was handed
 * something that could never be found.
 *
 * Returned in the author's own casing, which is what belongs in a title. Comparisons against
 * the scan lowercase it themselves, because that is the only place the casing matters.
 */
function duplicateIdOf(event: LogEvent): string | undefined {
  return /multiple times: (\S+)\.(?:\s|$)/.exec(event.message)?.[1];
}

/** An unrecognised fault still deserves better than "Unhandled exception". */
function genericTitle(event: LogEvent): string {
  const where = event.namespaces[0];
  if (event.exceptionType) return where ? `${event.exceptionType} in ${where}` : event.exceptionType;
  return truncate(event.message, 90);
}

/** Lowercased lookup from namespace-ish token to packageId. */
function buildAttributionIndex(mods: ModEntry[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const mod of mods) {
    index.set(mod.packageId, mod.packageId);
    // "oskarpotocki.vanillafactionsexpanded.core" -> "vanillafactionsexpanded", "core"
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

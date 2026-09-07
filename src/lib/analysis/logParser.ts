import type { Finding, ModEntry, Severity } from "../types";
import { BOOTSTRAP_PACKAGE_IDS, OFFICIAL_PACKAGE_IDS } from "./about.ts";

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
  /**
   * For a failing XML patch: the mod that shipped it, and what it could not find.
   *
   * RimWorld already says both, on the lines around the failure. Reading them turns "a
   * PatchOperation could not find its target node", which is true of every one of these and
   * useful for none of them, into the file and the xpath somebody could act on.
   */
  patch?: {
    /** The mod named on the "[X - Start of stack trace]" line above the failure. */
    owner?: string;
    /** Each distinct xpath that failed, in the order they were met. */
    xpaths: string[];
    /** Each distinct source file named beneath one. */
    files: string[];
  };
  /**
   * For a def fault: what is missing, and which defs are affected.
   *
   * RimWorld names both on the line. Reading them turns "a def points at another def that
   * does not exist" into the def that is absent and the ones that wanted it.
   */
  defs?: {
    /** The absent def, as "Verse.SoundDef RT_T72VehicleEngine". Absent for config errors. */
    missing?: string;
    /** Defs implicated, each named once. */
    affected: string[];
    /** For a config error, what the game objected to. */
    reason?: string;
  };
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
  // Unity's crash handler dumps every loaded module, then walks the native stack address by
  // address. Hundreds of lines, none of them about the install: the fault is the line above
  // the dump, and this is the machinery that recorded it.
  /^\s*ERROR: SymGetSymFromAddr\d+,/,
  /^0x[0-9A-Fa-f]+ \(/,
  /^[A-Za-z]:[\\/].*\.dll:.*SymType:/,
  /^=+ END OF STACKTRACE =+/,
  /^\[ ALLOC_\w+ \]/,
  /^\s*\d+B: \d+ Subsections/,
  /^Failed Allocations\. Bucket layout/,
];

/**
 * RimWorld tags each distinct error with a reference id so repeats can be collapsed. The
 * tag sits between the message and its stack trace, which means a naive "is the next line
 * a frame" check finds nothing and every trace is lost.
 */
const REF_MARKER = /^\[Ref [0-9A-Fa-f]+\]\s*$/;

/**
 * RimWorld's own id for a distinct fault, from either shape of the marker.
 *
 * The first occurrence gets `[Ref ABCD1234]` on its own line with the trace under it; every
 * repeat gets `[Ref ABCD1234] Duplicate stacktrace, see ref for original` and no trace. The
 * id is the game saying these are the same fault, which is a better answer than anything
 * derived from the text: the message can carry a different pawn id each time and the stack
 * can be absent on the repeats, and both of those split one fault into several rows.
 */
const REF_ID = /^\[Ref ([0-9A-Fa-f]+)\]/;

/**
 * An exception written on its own line, under a line saying where it happened.
 *
 * RimWorld logs some faults as two lines: "Error in PostExposeData of X" and then
 * "System.NullReferenceException: ...". Both match the exception matcher, so one fault was
 * reported twice, once with the stack trace and once without it.
 */
const BARE_EXCEPTION = /^[A-Za-z_][\w.]*(?:Exception|Error):\s/;

/**
 * A line that finishes the one above it.
 *
 * Unity says it could not allocate memory, then says on the next line how much it wanted and
 * what for. Read alone the first line is a fact with no size and the second is a number with
 * no reason, and the size is the whole story: 683 MB for one texture is a different problem
 * from 683 MB for a save file.
 */
const CONTINUATION = /^Trying to allocate: \d+B with \d+ alignment/;

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

/** One Harmony patch named in a stack trace: who patched what, and how. */
export interface PatchFrame {
  /** PREFIX, POSTFIX, TRANSPILER or FINALIZER. */
  kind: string;
  /** The patch method Harmony ran, as the trace names it. */
  method: string;
  /** The mod that owns it, when the frame's namespace matches an installed one. */
  packageId?: string;
}

/**
 * The Harmony patches a trace ran through.
 *
 * A patched method reports the patch in the stack rather than the original, so the frames
 * name every mod whose code was on the way to the fault. That is a different question from
 * which mod threw: a fault inside a postfix belongs to whoever wrote the postfix, not to
 * whatever they patched, and the trace is the only place that distinction is visible.
 */
export function patchFrames(frames: string[], mods: ModEntry[]): PatchFrame[] {
  const index = buildAttributionIndex(mods);
  const seen = new Set<string>();
  const found: PatchFrame[] = [];

  for (const frame of frames) {
    const match = /^-\s+(PREFIX|POSTFIX|TRANSPILER|FINALIZER)\s+([\w.]+)/.exec(frame);
    if (!match) continue;
    const [, kind, method] = match;
    const key = `${kind} ${method}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Either half of "UnlimitedHugs.HugsLib" can be the one that names the mod.
    const owner = method
      .split(".")
      .map((part) => index.get(part.toLowerCase()))
      .find((id): id is string => !!id);

    found.push({ kind, method, packageId: owner });
  }
  return found;
}

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
  // The run did not end, it stopped. Unity's crash handler writes this last, after the
  // native stack dump, and it is the only line in the file that says the process died
  // rather than exited. A log ending in a crash reported the same routine def errors as a
  // log ending in someone pressing quit.
  {
    category: "crashed",
    severity: "critical",
    test: /^A crash has been intercepted by the crash handler/,
  },
  // Ran out of address space asking for one allocation. On a modded install this is almost
  // always a texture, and it is the failure the texture footprint measurement predicts.
  {
    category: "out-of-memory",
    severity: "critical",
    test: /^Could not allocate memory: System out of memory/,
  },
  // A def names a texture that is not on disk anywhere. The thing it belongs to draws as a
  // missing-texture placeholder, which is one of the most reported "my game is broken"
  // symptoms and produced no finding at all.
  {
    category: "missing-texture",
    severity: "error",
    test: /^Could not load Texture2D at '.+' in any active mod or in base resources/,
  },
  // Two mods claiming the same key. One of them silently does nothing when it is pressed,
  // and nothing in the game tells you which.
  {
    category: "keybind-conflict",
    severity: "warning",
    test: /^Key binding conflict: .+ are both bound to /,
  },
  // A mod read a DefOf before the game filled them in, so it read null. Whatever it was
  // deciding with that value decided it wrong, silently, once, at startup.
  {
    category: "early-defof",
    severity: "error",
    test: /^Tried to use an uninitialized DefOf of type /,
  },
  // Two objects claiming one id in the save's object directory. The second is dropped, so
  // something that was saved does not come back.
  {
    category: "duplicate-object-id",
    severity: "error",
    test: /^Cannot register .+ in loaded object directory\. Id already used/,
  },
  // A mesh built from indices that point past its own vertices. Whatever it draws does not.
  {
    category: "broken-mesh",
    severity: "error",
    test: /^Failed setting triangles\. Some indices are referencing out of bounds vertices/,
  },
  // A mod loading a texture or material into a static field off the main thread. RimWorld
  // says "probably" because it is guessing from the field type, and it is usually right.
  {
    category: "static-asset",
    severity: "warning",
    test: /^Type \S+ probably needs a StaticConstructorOnStartup attribute/,
  },
  // Missing or malformed translation keys. Cosmetic, and the count is the only part worth
  // reading, so it is one row rather than a finding per key.
  {
    category: "translation-errors",
    severity: "info",
    test: /^Translation data for language \S+ has \d+ errors/,
  },
  // A mod announcing that its own compatibility patch did not attach. Nothing else
  // matched this: it is not XML-shaped, does not start with "Error", and has no
  // "Exception" in it, so Combat Extended saying its Vanilla Events patch failed produced
  // no finding at all. Two installed mods failing to cooperate, named by one of them, is
  // the thing this app exists to surface.
  {
    category: "patch-injection-failed",
    severity: "error",
    test: /^.+\s::\s(?:Failed to find injection point|Could not find method) /,
  },
  // Thrown at the end of a session, not during one. Unity aborts worker threads when the
  // process closes, and the trace is a thread parked in Monitor.Wait waiting for work it
  // will never get. Scored critical, it told someone who had just quit the game that it
  // could not recover from something.
  {
    category: "thread-teardown",
    severity: "info",
    test: /ThreadAbortException|^Exception thrown from thread=\d+\.?$/,
  },
  // Mono failing to preload a dependency while scanning types in the ReflectionOnly
  // context. The load carries on: in the reference log the next thing written is Unity
  // unloading unused assets, and the save finishes loading.
  {
    category: "reflection-probe",
    severity: "info",
    test: /Cannot resolve dependency to assembly .* because it has not been preloaded/,
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

    // Where it happened and what was thrown are one fault written on two lines. Folded
    // into one message, in the shape RimWorld itself uses when it writes both on one line.
    let message = line.trim();
    const under = lines[i + 1]?.trim();
    if (under && CONTINUATION.test(under)) {
      message = `${message} ${under}`;
      i++;
    } else if (under && !BARE_EXCEPTION.test(message) && BARE_EXCEPTION.test(under)) {
      message = `${message}: ${under}`;
      i++;
    }

    const { frames, next } = collectFrames(lines, i + 1);
    const ref = REF_ID.exec(lines[i + 1]?.trim() ?? "")?.[1];
    const owner = matcher.category === "xml-patch-failure" ? patchOwnerOf(lines, i) : undefined;
    const fingerprint = fingerprintOf(matcher.category, message, frames, owner, ref);
    const existing = clusters.get(fingerprint);
    if (existing) {
      existing.count++;
      // A repeat carries "see ref for original" instead of the trace. Where the row it
      // joins has none yet, this one's is the only one there will be.
      if (!existing.frames.length && frames.length) {
        existing.frames = frames;
        existing.namespaces = namespacesOf(frames, existing.message);
      }
      rememberPatch(existing, line, lines, i);
      rememberDefs(existing, line);
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
        patch: matcher.category === "xml-patch-failure" ? { owner, xpaths: [], files: [] } : undefined,
        defs:
          matcher.category === "cross-reference" ||
          matcher.category === "config-error" ||
          matcher.category === "static-asset"
            ? { affected: [] }
            : undefined,
      });
      rememberPatch(clusters.get(fingerprint)!, line, lines, i);
      rememberDefs(clusters.get(fingerprint)!, line);
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
/** `[The Dead Man's Switch-more dozer - Start of stack trace]` -> the mod's name. */
const PATCH_OWNER = /^\[(.+?)\s+-\s+Start of stack trace\]/;

/** The xpath a PatchOperation was looking for. */
const PATCH_XPATH = /xpath="([^"]*(?:"[^"]*"[^"]*)*)"\)/;

/** RimWorld names the file a few lines under the failure. */
const PATCH_FILE = /^Source file:\s*(.+)$/i;

/**
 * `Could not resolve cross-reference: No Verse.SoundDef named RT_T72VehicleEngine found to
 * give to Vehicles.VehicleTurretDef SiegeTank_Turret_TankBreaker`
 *
 * The missing thing and the def that wanted it, both named. Reporting neither, which is what
 * this did, leaves "a def points at another def that does not exist" ten times over.
 */
/** The two things clashing over a key, and the key. */
const KEYBIND = /^Key binding conflict: (.+?) and (.+?) are both bound to (\S+?)\.?$/;

/** The type RimWorld named in a static-asset warning. */
const STATIC_ASSET = /^Type (\S+) probably needs a StaticConstructorOnStartup/;

const CROSS_REF = /No\s+(\S+)\s+named\s+(\S+)\s+found to give to\s+(\S+)(?:\s+(\S+))?/;

/** `Config error in WD_Quard: no parts vulnerable to frostbite` */
const CONFIG_ERROR = /^Config error in\s+([^:]+):\s*(.+)$/;

/** `[The Dead Man's Switch-more dozer] Patch operation ...` names its mod inline. */
const PATCH_OWNER_INLINE = /^\[([^\]]+)\]\s+Patch operation/;

/**
 * The mod that owns a failing patch.
 *
 * RimWorld reports these twice in two shapes: a stack trace under a marker line naming the
 * mod, and a summary line carrying the name inline. Both are read, or the same seven
 * failures appear as one grouped row and seven loose ones.
 *
 * Searched upward only a short way rather than tracked as state, because the marker sits
 * immediately above and a scan that carried the last one seen would attribute an unmarked
 * failure to whichever mod happened to fail before it.
 */
function patchOwnerOf(lines: string[], at: number): string | undefined {
  const inline = PATCH_OWNER_INLINE.exec(lines[at].trim());
  if (inline) return inline[1].trim();

  for (let i = at - 1; i >= 0 && i >= at - 3; i--) {
    const found = PATCH_OWNER.exec(lines[i].trim());
    if (found) return found[1].trim();
  }
  return undefined;
}

/** The source file named below a failing patch, within the same block. */
function patchFileBelow(lines: string[], at: number): string | undefined {
  for (let i = at + 1; i < lines.length && i <= at + 6; i++) {
    const found = PATCH_FILE.exec(lines[i].trim());
    if (found) return found[1].trim();
  }
  return undefined;
}

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
function fingerprintOf(
  category: string,
  message: string,
  frames: string[],
  patchOwner?: string,
  ref?: string,
): string {
  // RimWorld has already decided which occurrences are the same fault. Taking its word for
  // it collapses what no reading of the text can: a message that names a different pawn each
  // time, and repeats that arrive with no stack to compare.
  if (ref) return ["ref", ref].join("|");
  // A failing patch is grouped by the mod that shipped it, not by what it was looking for.
  // The message carries the defName, so one mod whose compatibility patches miss seven
  // different defs became seven identical-looking rows saying nothing seven times. What
  // someone decides about is the mod, once.
  if (category === "xml-patch-failure" && patchOwner) {
    return [category, patchOwner].join("|");
  }
  // One row for the lot. Twenty types on this install, each named differently, so one row
  // per type filled the tab with twenty warnings saying the same thing about mods whose
  // authors are the only ones who can act on it.
  if (category === "static-asset") return category;
  // RimWorld reports a key clash twice, once from each side: "A and B are both bound to F9"
  // and then "B and A". One clash, one row, whichever way round it was written.
  if (category === "keybind-conflict") {
    const both = KEYBIND.exec(message);
    if (both) return [category, [both[1], both[2]].sort().join("+"), both[3]].join("|");
  }
  // One row per Workshop item. Ids are digits, and the fallback normalises digits out, so
  // two items that never downloaded became one row counted twice, with a Retry button that
  // could only ever act on whichever id happened to be first. The second was not named
  // anywhere in the app.
  if (category === "ghost-subscription") {
    const id = /WorkshopItem for (\d+)/.exec(message)?.[1];
    if (id) return [category, id].join("|");
  }
  // One row per absent def, however many things wanted it. Three defs reaching for the same
  // missing sound is one thing to fix, not three.
  if (category === "cross-reference") {
    const found = CROSS_REF.exec(message);
    if (found) return [category, found[1], found[2]].join("|");
  }
  // One row per kind of complaint. The def name is normalised out, because "same research
  // view coords" affecting four defs is one collision described four times.
  if (category === "config-error") {
    const found = CONFIG_ERROR.exec(message);
    if (found) return [category, found[2].replace(/\d+(\.\d+)?/g, "#").slice(0, 120)].join("|");
  }
  const normalised = message.replace(/\d+/g, "#").slice(0, 200);
  const top = frames.slice(0, 3).map((f) => f.replace(/\s*\[0x[0-9a-f]+\].*$/i, ""));
  return [category, normalised, ...top].join("|");
}

/** Add this occurrence's def names to the row it was grouped into. */
function rememberDefs(event: LogEvent, line: string): void {
  if (!event.defs) return;
  const cross = CROSS_REF.exec(line);
  if (cross) {
    event.defs.missing ??= `${cross[1]} ${cross[2]}`;
    const wanted = [cross[3], cross[4]].filter(Boolean).join(" ");
    if (wanted && !event.defs.affected.includes(wanted) && event.defs.affected.length < 40) {
      event.defs.affected.push(wanted);
    }
    return;
  }
  const staticAsset = STATIC_ASSET.exec(line.trim());
  if (staticAsset) {
    if (!event.defs.affected.includes(staticAsset[1]) && event.defs.affected.length < 40) {
      event.defs.affected.push(staticAsset[1]);
    }
    return;
  }
  const config = CONFIG_ERROR.exec(line.trim());
  if (config) {
    event.defs.reason ??= config[2].trim();
    const def = config[1].trim();
    if (!event.defs.affected.includes(def) && event.defs.affected.length < 40) {
      event.defs.affected.push(def);
    }
  }
}

/** Add this occurrence's xpath and file to the row it was grouped into. */
function rememberPatch(event: LogEvent, line: string, lines: string[], at: number): void {
  if (!event.patch) return;
  const xpath = PATCH_XPATH.exec(line)?.[1];
  if (xpath && !event.patch.xpaths.includes(xpath) && event.patch.xpaths.length < 40) {
    event.patch.xpaths.push(xpath);
  }
  const file = patchFileBelow(lines, at);
  if (file && !event.patch.files.includes(file) && event.patch.files.length < 40) {
    event.patch.files.push(file);
  }
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
/**
 * Startup phases and how long each took.
 *
 * Three shapes, because the engine and the game do not agree on one. Unity writes
 * "- Loaded All Assemblies, in  0.195 seconds" and "UnloadTime: 0.708800 ms"; other lines
 * use "took". Only "took" was matched before, which is a form a real RimWorld log does not
 * contain, so this returned nothing at all on every genuine log and the panel built on it
 * was permanently empty.
 */
function readTimings(lines: string[]): { label: string; ms: number }[] {
  const patterns: [RegExp, number, number, (unit: string) => number][] = [
    // "- Loaded All Assemblies, in  0.195 seconds"
    [/^-?\s*(.+?),\s+in\s+([\d.]+)\s*(seconds?|s|ms)\b/i, 1, 2, (u) => (u.startsWith("m") ? 1 : 1000)],
    // "UnloadTime: 0.708800 ms"
    [/^(.+?):\s+([\d.]+)\s*(ms|seconds?|s)\b/i, 1, 2, (u) => (u.startsWith("m") ? 1 : 1000)],
    // "Something took 12.5 ms"
    [/^(.*?)\s+took\s+([\d.]+)\s*(ms|seconds?|s)\b/i, 1, 2, (u) => (u.startsWith("m") ? 1 : 1000)],
  ];

  const timings: { label: string; ms: number }[] = [];
  for (const line of lines) {
    const text = line.trim();
    for (const [pattern, labelAt, valueAt, scale] of patterns) {
      const m = pattern.exec(text);
      if (!m) continue;
      const ms = Number(m[valueAt]) * scale(m[3].toLowerCase());
      if (Number.isFinite(ms)) {
        timings.push({ label: m[labelAt].replace(/^[-\s]+|[:,]$/g, "").trim(), ms });
      }
      break;
    }
  }
  return timings.sort((a, b) => b.ms - a.ms).slice(0, 10);
}

interface Explanation {
  title: (e: LogEvent) => string;
  /** A function where the entry itself carries the specifics worth naming. */
  detail: string | ((e: LogEvent) => string);
  fixKind?: string;
  /** Arguments the repair needs, read back out of the log line that raised it. */
  params?: (e: LogEvent) => Record<string, string | string[]>;
  /** Set where the category describes the run rather than reporting a fault with it. */
  observation?: true;
  /**
   * Set where every occurrence restates one fact, so a count would only mislead.
   *
   * RimWorld reports a key clash from both sides. Two lines, one clash, and a badge reading
   * two next to a title naming one pair invites a question with no answer.
   */
  singular?: true;
}

/** A real newline, spelled so no escaping layer between here and the file can eat it. */
const NEWLINE = String.fromCharCode(10);

/** Human-readable explanation and repair for each recognised category. */
const EXPLANATIONS: Record<string, Explanation> = {
  "playdata-reset": {
    title: () => "RimWorld reset your mod list after a load failure",
    detail:
      "Loading threw with mods active, so the game rewrote ModsConfig.xml back to Core only and " +
      "retried. Any load order you had is gone. Restore it from a modpack before launching again.",
    fixKind: "restore-mods-config",
  },
  crashed: {
    title: () => "This run ended in a crash",
    detail:
      "The game did not exit, it died. Unity's crash handler wrote a native stack dump and stopped. " +
      "Whatever is above this in the log is the last thing that happened, and RimWorld keeps its own " +
      "report under Temp/Ludeon Studios/RimWorld by Ludeon Studios/Crashes.",
  },
  "out-of-memory": {
    title: (e) => {
      const bytes = Number(/Trying to allocate: (\d+)B/.exec(e.message)?.[1] ?? 0);
      const what = /MemoryLabel: (\w+)/.exec(e.message)?.[1];
      if (!bytes) return "The game ran out of memory";
      const mb = Math.round(bytes / (1024 * 1024));
      return what
        ? `Out of memory asking for ${mb} MB of ${what.toLowerCase()}`
        : `Out of memory asking for ${mb} MB`;
    },
    detail:
      "RimWorld is a 64-bit process, so this is the machine running out, not the game hitting a " +
      "ceiling of its own. One allocation this large in a modded install is almost always a texture " +
      "atlas being built, which is what the texture footprint on the Doctor tab measures: the more " +
      "decoded texture data the active mods carry, the larger the atlases the game has to build at " +
      "once. Fewer or smaller textures is the lever, and downscaling is the one that keeps the mods.",
  },
  "missing-texture": {
    title: (e) => {
      const path = /at '(.+?)'/.exec(e.message)?.[1];
      return path ? `Missing texture ${path}` : "A texture is missing";
    },
    detail:
      "A def points at a texture file that is not in any active mod or in the game's own resources. " +
      "Whatever uses it draws as the missing-texture placeholder. Either the mod that ships the file " +
      "is disabled, or a patch changed the path, or the file was renamed and something still asks for " +
      "the old name.",
  },
  "keybind-conflict": {
    singular: true,
    title: (e) => {
      const both = KEYBIND.exec(e.message);
      return both ? `${both[1]} and ${both[2]} both use ${both[3]}` : "Two things share one key";
    },
    detail:
      "RimWorld gives the key to one of them and the other does nothing when you press it, with no " +
      "sign which. Rebind one under Options, Keyboard configuration.",
  },
  "early-defof": {
    title: (e) => {
      const type = /uninitialized DefOf of type (\S+?)\.?\s/.exec(e.message)?.[1];
      return type ? `A mod read ${type} before the game filled it in` : "A DefOf was read too early";
    },
    detail:
      "DefOfs are filled in after every def has loaded. Read before that, they are null, so whatever " +
      "the mod was deciding with that value decided it wrong. It happens once, at startup, and the " +
      "wrong answer is kept for the rest of the run.",
  },
  "duplicate-object-id": {
    title: (e) => {
      const id = /\(id=([^\s,]+)/.exec(e.message)?.[1];
      return id ? `Two things claim the saved id ${id}` : "Two things claim one saved id";
    },
    detail:
      "The save's object directory holds one entry per id, and the second thing to claim one is " +
      "dropped. Something that was saved does not come back, and the usual cause is two mods giving " +
      "the same thing an id, or one mod loaded twice.",
  },
  "broken-mesh": {
    title: () => "A mesh was built from indices pointing past its own vertices",
    detail:
      "Unity refused to build the mesh, so whatever it belongs to does not draw. A vertex count of " +
      "zero means the geometry it was given was empty, which is usually a texture or model a mod " +
      "expected to be there and was not.",
  },
  "static-asset": {
    title: (e) => {
      const n = e.defs?.affected.length ?? e.count;
      return `${n} type${n === 1 ? "" : "s"} load an asset off the main thread`;
    },
    detail: (e) => {
      const said =
        "A static field holding a texture or material, on a type without StaticConstructorOnStartup. " +
        "Unity only allows assets to be loaded on the main thread, so the field can come back null and " +
        'whatever draws with it draws nothing. RimWorld says "probably" because it is inferring this ' +
        "from the field's type, and it is usually right. Each of these is the mod author's to fix, " +
        "which is why they are one row rather than twenty.";
      const types = e.defs?.affected ?? [];
      if (types.length === 0) return said;
      return said + NEWLINE + NEWLINE + "Types:" + NEWLINE + types.map((t) => "  " + t).join(NEWLINE);
    },
  },
  "translation-errors": {
    observation: true,
    title: (e) => {
      const n = /has (\d+) errors/.exec(e.message)?.[1];
      return n ? `${n} translation errors in this language` : "Translation errors";
    },
    detail:
      "Keys a mod refers to and does not supply, or supplies twice. The symptom is untranslated text " +
      "in the interface, and nothing else. Read rather than fixed: the count is the whole of it, and " +
      "the game generates a full report from Options, Development mode.",
  },
  "patch-injection-failed": {
    title: (e) => {
      const who = /^(.+?)\s::\s/.exec(e.message)?.[1];
      return who ? `${who} could not apply one of its patches` : "A mod patch did not attach";
    },
    detail:
      "The mod says so itself: it went looking for a method to patch and did not find it. The patch " +
      "simply does not run, so whatever it was compensating for is not compensated. Usually the mod " +
      "it was patching changed, or updated, or is not the version this patch was written against.",
  },
  "thread-teardown": {
    observation: true,
    title: (e) => {
      const where = e.namespaces[0];
      return where ? `${where} thread stopped when the game closed` : "Worker thread stopped at shutdown";
    },
    detail:
      "Unity aborts worker threads when the process closes, and a thread parked waiting for work " +
      "reports the abort on its way out. Read rather than fixed: it says the game shut down, not " +
      "that anything went wrong while you were playing.",
  },
  "reflection-probe": {
    observation: true,
    title: () => "An assembly scan could not preload a dependency",
    detail:
      "Something scanned types without loading the assemblies they refer to, which is what the " +
      "ReflectionOnly APIs do. The load carries on afterwards. Read rather than fixed: it is a " +
      "scan reporting what it could not see, not the game failing to start something.",
  },
  "ghost-subscription": {
    title: (e) => {
      const id = ghostIdOf(e);
      return id ? `Workshop item ${id} never downloaded` : "A subscribed Workshop item never downloaded";
    },
    detail:
      "Steam registered the subscription but no folder arrived. The mod is not actually installed, so " +
      "anything depending on it fails. Usually fixed by unsubscribing and resubscribing.",
    fixKind: "retry-workshop-download",
    params: (e) => ({ steamId: ghostIdOf(e) ?? "" }),
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
    title: (e) =>
      e.patch?.owner
        ? `${e.patch.owner}: ${e.count} XML patch${e.count === 1 ? "" : "es"} found nothing to change`
        : "XML patch did not apply",
    detail: (e) => {
      const said =
        "A PatchOperation names a node that is not there, so it silently does nothing and part " +
        "of what the mod meant to add is missing. Usually the mod it patches has changed, or a " +
        "sibling operation guards for the node being absent and this one does not.";
      const xpaths = e.patch?.xpaths ?? [];
      const files = e.patch?.files ?? [];
      if (xpaths.length === 0) return said;
      // The log names both. Repeating the generic sentence and nothing else was the whole
      // of what these findings used to say, seven times over.
      return (
        said +
        "\n\nLooking for:\n" +
        xpaths.map((x) => `  ${x}`).join("\n") +
        (files.length > 0 ? "\n\nIn:\n" + files.map((f) => `  ${f}`).join("\n") : "")
      );
    },
    fixKind: "repair-xpath",
  },
  "cross-reference": {
    title: (e) => {
      if (!e.defs?.missing) return "Unresolved cross-reference";
      const n = affectedCount(e);
      return `Missing ${e.defs.missing}, wanted by ${n} def${n === 1 ? "" : "s"}`;
    },
    detail: (e) => {
      const said =
        "A def points at another def that does not exist, usually because the mod defining it " +
        "is missing, disabled, or loading after the mod that needs it.";
      const affected = e.defs?.affected ?? [];
      if (affected.length === 0) return said;
      return said + NEWLINE + NEWLINE + "Wanted by:" + NEWLINE + affected.map((d) => "  " + d).join(NEWLINE);
    },
  },
  "missing-type": {
    title: (e) => {
      const named = /^Could not find a type named (\S+?)[\s.]*$/.exec(e.message)?.[1];
      return named ? `Missing type ${named}` : "Missing type";
    },
    detail:
      "A def references a C# type that no assembly provides. Either the mod supplying it is disabled, or " +
      "the type was renamed in a newer version of the game.",
  },
  "def-not-found": {
    title: (e) => {
      const named = /^(?:Could not|Failed to) find (\S+) named (\S+?)[\s.]*$/.exec(e.message);
      return named ? `Missing ${named[1]} ${named[2]}` : "Def not found";
    },
    detail: "Referenced content does not exist in this load.",
  },
  "config-error": {
    title: (e) => {
      if (!e.defs?.reason) return "Def config error";
      const n = affectedCount(e);
      return `${n} def${n === 1 ? "" : "s"} rejected: ${truncate(e.defs.reason, 70)}`;
    },
    detail: (e) => {
      const said =
        "The game validated these defs and refused them, so whatever they describe is not in " +
        "your game. The reason is the game's own words.";
      const affected = e.defs?.affected ?? [];
      if (affected.length === 0) return said;
      return said + NEWLINE + NEWLINE + "Rejected:" + NEWLINE + affected.map((d) => "  " + d).join(NEWLINE);
    },
  },
};

/**
 * Turn clustered log events into findings, attributing each to a mod where the stack
 * frames allow it. Attribution is by namespace root against mod names and package ids,
 * which is what makes a wall of NullReferences point at something actionable.
 */
export function findingsFromLog(
  analysis: SessionAnalysis,
  mods: ModEntry[],
  activeOrder: string[] = [],
): Finding[] {
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
      detail:
        typeof explanation?.detail === "function"
          ? explanation.detail(event)
          : (explanation?.detail ?? event.message),
      packageIds,
      // The same number the title counts. A row reading "7 defs rejected" beside a badge
      // reading 14 asks a question it does not answer; the 14 is log lines, which RimWorld
      // wrote twice per def and which nobody acts on.
      count: explanation?.singular ? undefined : event.defs ? affectedCount(event) : event.count,
      frames: event.frames,
      firstLine: event.firstLine,
      observation: explanation?.observation,
      stale: settledSince(event, mods, activeOrder),
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
function settledSince(event: LogEvent, mods: ModEntry[], activeOrder: string[]): string | undefined {
  if (event.category === "playdata-reset") {
    // The complaint is that the game rewrote the load order back to the mods it ships with.
    // A single mod of anyone else's in the current order is that having been put back, and
    // is the only proof available: the log says what happened, and no amount of repairing
    // will make it stop saying it. Without this the finding returned on every triage after
    // being fixed, which read as the repair having done nothing.
    const restored = activeOrder.filter(
      (id) =>
        !OFFICIAL_PACKAGE_IDS.includes(id.toLowerCase()) && !BOOTSTRAP_PACKAGE_IDS.includes(id.toLowerCase()),
    );
    return restored.length > 0
      ? `The load order holds ${restored.length} mod${restored.length === 1 ? "" : "s"} again, ` +
          `so it was restored after the log was written. Launching the game will clear this.`
      : undefined;
  }

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

/**
 * How many defs a def-error row is actually about.
 *
 * `count` is occurrences of a log line, and RimWorld writes some of them twice: seven
 * rejected defs produced fourteen lines, and the headline said "14 defs rejected" over a
 * body listing seven. The deduplicated names are already collected for that body, so they
 * are what the headline counts. Falls back to occurrences only when nothing was collected,
 * which is the case where the two agree anyway.
 */
function affectedCount(event: LogEvent): number {
  return event.defs?.affected.length || event.count;
}

/**
 * Cut at a word, not at a character.
 *
 * A hard slice produced "explosive projectiles and o", which reads as a broken screen
 * rather than as a summary. Backs up to the last space when one is close enough to the
 * limit to be the right place to stop.
 */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const space = cut.lastIndexOf(" ");
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

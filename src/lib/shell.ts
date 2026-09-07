import type { FileAction } from "./repair/repairs";
import type { ScanResult } from "./types";

export interface ActionOutcome {
  target: string;
  ok: boolean;
  detail: string;
}

export interface RunReport {
  applied: number;
  failed: number;
  skipped: number;
  backup_dir: string;
  outcomes: ActionOutcome[];
}

/**
 * Whether the desktop shell is present.
 *
 * Everything the app can do without it stays available in the browser, so this gates
 * extra capability rather than switching between two versions: the analysis, modpacks and
 * repair plans are identical either way, and only who carries a plan out changes.
 */
export function inShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Imported lazily so a browser build never pulls the desktop API into its bundle. */
async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!inShell()) throw new Error("RimDoc+ is running in a browser, which cannot write to disk.");
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call<T>(command, args);
}

/** One action's result, as it lands rather than at the end of the run. */
export interface RepairProgress {
  /** 1-based. */
  index: number;
  total: number;
  target: string;
  ok: boolean;
  detail: string;
}

export interface RepairEvents {
  onBackup?: (configDir: string | null) => void;
  onStart?: (total: number) => void;
  onProgress?: (progress: RepairProgress) => void;
}

/**
 * Subscribe to a run's transcript, returning a function that stops listening.
 *
 * Resolves to a no-op outside the shell rather than throwing, so a caller can arm the
 * listener unconditionally and let the disabled button be what says the browser cannot run
 * repairs.
 */
export async function watchRepair(events: RepairEvents): Promise<() => void> {
  if (!inShell()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const offs = await Promise.all([
    listen<string | null>("repair:backup", (e) => events.onBackup?.(e.payload)),
    listen<number>("repair:start", (e) => events.onStart?.(e.payload)),
    listen<RepairProgress>("repair:progress", (e) => events.onProgress?.(e.payload)),
  ]);
  return () => offs.forEach((off) => off());
}

/** Carry out a repair plan directly, backing every target up first. */
export function runFileActions(actions: FileAction[], configDir: string | null): Promise<RunReport> {
  return invoke<RunReport>("run_file_actions", { actions, configDir });
}

/** Write a modpack's load order into the game's ModsConfig.xml. */
export function applyModsConfig(path: string, contents: string): Promise<string> {
  return invoke<string>("apply_mods_config", { path, contents });
}

/** Undo a run by restoring the backups beside each path it touched. */
export function rollback(targets: string[]): Promise<RunReport> {
  return invoke<RunReport>("rollback", { targets });
}

/** Read a mod's banner image back as a data URL. */
export function readModPreview(path: string): Promise<string> {
  return invoke<string>("read_mod_preview", { path });
}

export interface ScanProgress {
  done: number;
  total: number;
  /** The mod folder just read. */
  label: string;
}

/** Follow a scan as it walks, returning a function that stops listening. */
export async function watchScan(onProgress: (p: ScanProgress) => void): Promise<() => void> {
  if (!inShell()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const off = await listen<ScanProgress>("scan:progress", (e) => onProgress(e.payload));
  return () => off();
}

/**
 * Walk the install and report what is on disk right now.
 *
 * The browser build reads a fixture written by `pnpm scan`, which is fixed at build time.
 * The desktop build asks the shell instead, so the numbers reflect the install as it is
 * rather than as it was when the app was compiled.
 */
export function scanInstall(): Promise<ScanResult> {
  return invoke<ScanResult>("scan_install", {});
}

/**
 * Read the game's current Player.log.
 *
 * Null when the game has never been run, or the log has been cleared away.
 */
export function readSessionLog(): Promise<{ path: string; text: string } | null> {
  return invoke<{ path: string; text: string } | null>("read_session_log", {});
}

/** Start RimWorld from its install folder. */
export function launchGame(gameDir: string): Promise<string> {
  return invoke<string>("launch_game", { gameDir });
}

/** Every distinct path a plan touches, which is also what a rollback needs. */
export function targetsOf(actions: FileAction[]): string[] {
  return [...new Set(actions.map((a) => ("path" in a ? a.path : a.directory)))];
}

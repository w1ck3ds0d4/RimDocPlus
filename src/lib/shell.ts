import type { FileAction } from "./repair/repairs";

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

/** Start RimWorld from its install folder. */
export function launchGame(gameDir: string): Promise<string> {
  return invoke<string>("launch_game", { gameDir });
}

/** Every distinct path a plan touches, which is also what a rollback needs. */
export function targetsOf(actions: FileAction[]): string[] {
  return [...new Set(actions.map((a) => ("path" in a ? a.path : a.directory)))];
}

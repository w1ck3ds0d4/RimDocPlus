import type { FileAction } from "./repair/repairs";

// Re-exported so callers that reach for it alongside runFileActions keep one import.
export { targetsOf } from "./repair/repairs";
import type { ScanResult } from "./types";
import type { SaveMeta } from "./saves";

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
 * Read one of the game's two logs.
 *
 * RimWorld truncates Player.log on launch and keeps what was there as Player-prev.log, so
 * after a crash the run worth reading is the previous one. Null when that run never happened
 * or its log has been cleared away.
 */
export function readSessionLog(previous = false): Promise<{ path: string; text: string } | null> {
  return invoke<{ path: string; text: string } | null>("read_session_log", { previous });
}

/**
 * Whether the Steam client is running.
 *
 * It holds its workshop record in memory and rewrites the file on exit, so anything editing
 * that record has to wait for Steam to be closed or the change is simply undone.
 */
export function isSteamRunning(): Promise<boolean> {
  return invoke<boolean>("is_steam_running", {});
}

/**
 * Fetch a log someone shared, from a gist link.
 *
 * The only outbound request this app makes, and only because a link was pasted and a button
 * pressed. The shell refuses any host but gist.github.com and gist.githubusercontent.com, so
 * this cannot be turned into a general fetcher by whatever ends up in the box.
 */
export function fetchSharedLog(url: string): Promise<{ path: string; text: string }> {
  return invoke<{ path: string; text: string }>("fetch_shared_log", { url });
}

export interface SteamShutdown {
  /** True only when this call closed a Steam that was actually running. */
  closed: boolean;
  detail: string;
}

/**
 * Whether Steam is running a game right now, read out of Steam's own record.
 *
 * Asked before Steam is closed on the player's behalf, because closing it takes whatever it
 * is running with it, and a button that says it closes Steam does not say that.
 */
export function isGameRunning(): Promise<boolean> {
  return invoke<boolean>("is_game_running", {});
}

/**
 * Close Steam, resolving only once it has actually gone.
 *
 * Steam's own shutdown rather than a kill, because a kill is precisely the case where the
 * download record never gets written: what would be left on disk is whatever Steam last
 * happened to flush, and the repair would then be editing a stale file.
 */
export function stopSteam(workshop: string | null): Promise<SteamShutdown> {
  return invoke<SteamShutdown>("stop_steam", { workshop });
}

/** Start Steam again. Called whether or not the repair in between worked. */
export function startSteam(workshop: string | null): Promise<string> {
  return invoke<string>("start_steam", { workshop });
}

/**
 * Every save RimWorld has written, newest first, with the mod list each was made with.
 *
 * Only the head of each file is read, so listing a dozen saves does not mean reading a
 * gigabyte of world data to find twenty kilobytes of metadata.
 */
export function listSaves(): Promise<SaveMeta[]> {
  return invoke<SaveMeta[]>("list_saves", {});
}

export interface GameExit {
  /** Null when the process was terminated rather than exiting on its own. */
  code: number | null;
  durationMs: number;
  lines: number;
  /** Highest working set seen while the run was watched. */
  peakMemoryMb: number;
  /** The game stopped writing well before it stopped running. */
  wentQuiet: boolean;
}

export interface GameEvents {
  onStarted?: (exe: string) => void;
  onLines?: (lines: string[]) => void;
  /** The run has written nothing for this many seconds while still running. */
  onQuiet?: (seconds: number) => void;
  onExited?: (exit: GameExit) => void;
}

/** Follow a supervised run, returning a function that stops listening. */
export async function watchGame(events: GameEvents): Promise<() => void> {
  if (!inShell()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const offs = await Promise.all([
    listen<string>("game:started", (e) => events.onStarted?.(e.payload)),
    listen<string[]>("game:lines", (e) => events.onLines?.(e.payload)),
    listen<number>("game:quiet", (e) => events.onQuiet?.(e.payload)),
    listen<GameExit>("game:exited", (e) => events.onExited?.(e.payload)),
  ]);
  return () => offs.forEach((off) => off());
}

/**
 * Start RimWorld and watch it: the log streams back live, and the run reports how it ended.
 *
 * Returns as soon as the game is up. Everything after that arrives through watchGame.
 */
export function launchSupervised(gameDir: string, logPath: string): Promise<string> {
  return invoke<string>("launch_supervised", { gameDir, logPath });
}

/**
 * Stop the run this app started.
 *
 * For a search that judges its own trials: once the log has said whether the mod list loads,
 * the run has answered its question. Never touches a game the app did not launch.
 */
export function stopGame(): Promise<string> {
  return invoke<string>("stop_game", {});
}

export interface VaultEntry {
  packageId: string;
  name: string;
  /** First 16 hex characters of the folder's content hash. */
  hash: string;
  sizeBytes: number;
  files: number;
  capturedAt: string;
  path: string;
}

/** Take a mod's current build into the vault, or recognise one already held. */
export function vaultCapture(folder: string, packageId: string, name: string): Promise<VaultEntry> {
  return invoke<VaultEntry>("vault_capture", { folder, packageId, name });
}

export function vaultList(): Promise<VaultEntry[]> {
  return invoke<VaultEntry[]>("vault_list", {});
}

/** Put a vaulted build back, backing up what it replaces. */
export function vaultRestore(packageId: string, hash: string, target: string): Promise<string> {
  return invoke<string>("vault_restore", { packageId, hash, target });
}

export function vaultForget(packageId: string, hash: string): Promise<string> {
  return invoke<string>("vault_forget", { packageId, hash });
}

/**
 * What is in a mod folder right now, as one hash, without copying anything.
 *
 * How a pin is checked: the modpack records the hash it was built against, and a mismatch
 * means the mod on disk is not the one it was tested with.
 */
export function hashMod(folder: string): Promise<string> {
  return invoke<string>("hash_mod", { folder });
}

/** Start RimWorld from its install folder. */
export function launchGame(gameDir: string): Promise<string> {
  return invoke<string>("launch_game", { gameDir });
}

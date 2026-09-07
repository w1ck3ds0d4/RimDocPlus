mod scan;
mod vault;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// One change to disk, mirroring the FileAction union the analysis layer produces.
///
/// The same plan the UI already renders and the script already emits is what arrives
/// here, so the shell is a third executor of one description rather than a second
/// implementation of the repairs.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
enum FileAction {
    AddSupportedVersion {
        path: String,
        cycle: String,
    },
    Write {
        path: String,
        contents: String,
    },
    DeleteMatching {
        directory: String,
        pattern: String,
    },
    DownscalePng {
        path: String,
        #[serde(rename = "maxPx")]
        max_px: u32,
    },
    ForgetWorkshopItem {
        path: String,
        #[serde(rename = "steamId")]
        steam_id: String,
    },
}

#[derive(Debug, Serialize)]
pub struct ActionOutcome {
    target: String,
    ok: bool,
    /// What happened, in the same words the console uses.
    detail: String,
}

/// One line of the live transcript, emitted as each action lands.
///
/// The run reports itself as it goes rather than only at the end. A texture pass is 730
/// files and the better part of a minute, and a window that sits still for that long is
/// indistinguishable from one that has hung.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepairProgress {
    /// 1-based, so it reads as "412 of 730" without arithmetic at the other end.
    index: usize,
    total: usize,
    target: String,
    ok: bool,
    detail: String,
}

#[derive(Debug, Serialize)]
pub struct RunReport {
    applied: usize,
    failed: usize,
    skipped: usize,
    /// Where the untouched copies went, so a rollback knows what to read.
    backup_dir: String,
    outcomes: Vec<ActionOutcome>,
}

/// Now, in the same ISO shape everything else in this app records a time with.
fn now_iso() -> String {
    scan::iso8601(std::time::SystemTime::now()).unwrap_or_default()
}

fn backups_root() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "No home directory to write backups into".to_string())?;
    Ok(PathBuf::from(home).join("RimDoc-Backups"))
}

/// Copy a file or directory beside itself as `.rimdocbak`, once.
///
/// Directories are copied recursively. A plain copy of a directory creates an empty one,
/// which would make removing a duplicate mod folder unrecoverable while looking backed up.
fn backup_once(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let bak = PathBuf::from(format!("{}.rimdocbak", path.display()));
    if bak.exists() {
        return Ok(());
    }
    if path.is_dir() {
        copy_dir(path, &bak)
    } else {
        fs::copy(path, &bak).map(|_| ()).map_err(|e| e.to_string())
    }
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Take the original-version copy once, and never again.
///
/// It stays the install as it was before RimDoc+ first touched anything, rather than
/// sliding forward to mean "before the most recent run".
///
/// Doneness is a marker file written after the copy, not the folder's existence. Gating on
/// the folder would let a copy that failed halfway mark itself done permanently, and this is
/// the one backup that can never be retaken once the install has changed.
fn save_original(config_dir: Option<&str>) -> Result<PathBuf, String> {
    let root = backups_root()?;
    let original = root.join("original-version");
    let done = original.join(".complete");
    if done.exists() {
        return Ok(original);
    }
    fs::create_dir_all(&original).map_err(|e| e.to_string())?;
    if let Some(config) = config_dir {
        let source = Path::new(config);
        if source.exists() {
            copy_dir(source, &original.join("Config"))?;
        }
    }
    fs::write(&done, "").map_err(|e| e.to_string())?;
    Ok(original)
}

fn add_supported_version(path: &Path, cycle: &str) -> Result<String, String> {
    let xml = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let entry = format!("<li>{cycle}</li>");
    if xml.contains(&entry) {
        return Ok(format!("already advertises {cycle}"));
    }
    let Some(at) = xml.find("<supportedVersions>") else {
        return Err("no supportedVersions block".into());
    };
    let insert = at + "<supportedVersions>".len();
    let patched = format!("{}\n    {}{}", &xml[..insert], entry, &xml[insert..]);
    fs::write(path, patched).map_err(|e| e.to_string())?;
    Ok(format!("stamped {cycle}"))
}

fn downscale(path: &Path, max_px: u32) -> Result<String, String> {
    let img = image::open(path).map_err(|e| e.to_string())?;
    let (w, h) = (img.width(), img.height());
    if w <= max_px && h <= max_px {
        return Ok("already within bounds".into());
    }
    // `thumbnail` preserves aspect ratio and is markedly faster than a full Lanczos
    // resample, which matters across several hundred textures.
    let resized = img.thumbnail(max_px, max_px);
    resized.save(path).map_err(|e| e.to_string())?;
    Ok(format!(
        "{}x{} to {}x{}",
        w,
        h,
        resized.width(),
        resized.height()
    ))
}

fn delete_matching(directory: &Path, pattern: &str) -> Result<String, String> {
    if !directory.exists() {
        return Ok("nothing there".into());
    }
    // "*" means the directory itself, which is how a duplicate mod folder is removed.
    if pattern == "*" {
        backup_once(directory)?;
        fs::remove_dir_all(directory).map_err(|e| e.to_string())?;
        return Ok("removed folder".into());
    }

    let prefix = pattern.split('*').next().unwrap_or("");
    let suffix = pattern.rsplit('*').next().unwrap_or("");
    let mut removed = 0;
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(prefix) && name.ends_with(suffix) {
            backup_once(&entry.path())?;
            let path = entry.path();
            if path.is_dir() {
                fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
            } else {
                fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
            removed += 1;
        }
    }
    Ok(format!("removed {removed}"))
}

/// Whether the Steam client is running.
///
/// It holds its workshop manifest in memory and rewrites the file on exit, so an edit made
/// while it is up is simply undone. Anything that touches that manifest has to check first.
#[tauri::command]
fn is_steam_running() -> bool {
    let output = Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq steam.exe", "/NH"])
        .output();
    match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .to_lowercase()
            .contains("steam.exe"),
        // Unknown is treated as running: refusing to edit is recoverable, editing under a
        // live Steam silently loses the change and looks like the repair did nothing.
        Err(_) => true,
    }
}

/// Drop one item from Steam's record of what it has downloaded.
///
/// The manifest keeps two lists: what Steam believes is installed, and what the account is
/// subscribed to. Removing the installed entry while leaving the subscription is what makes
/// Steam fetch the item again; removing the subscription instead would just unsubscribe.
///
/// The file is Valve's tab-indented key-value format. Parsed by hand because only one block
/// is being removed and every byte outside it must survive untouched, which a
/// parse-and-reserialise would not guarantee.
fn forget_workshop_item(path: &Path, steam_id: &str) -> Result<String, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;

    let installed = text
        .find("\"WorkshopItemsInstalled\"")
        .ok_or("No WorkshopItemsInstalled block in the manifest")?;
    // Bounded by the next section, so an id appearing in both lists cannot have the wrong
    // one removed.
    let end = text[installed..]
        .find("\"WorkshopItemDetails\"")
        .map(|i| installed + i)
        .unwrap_or(text.len());

    let key = format!("\t\t\"{steam_id}\"\n");
    let Some(at) = text[installed..end].find(&key).map(|i| installed + i) else {
        return Ok(format!("{steam_id} was not recorded as installed"));
    };

    let brace = text[at..end]
        .find("\t\t{")
        .map(|i| at + i)
        .ok_or("Malformed manifest entry")?;
    let close = text[brace..end]
        .find("\n\t\t}")
        .map(|i| brace + i + "\n\t\t}".len())
        .ok_or("Unterminated manifest entry")?;
    // Take the newline after the closing brace too, so no blank line is left behind.
    let cut = if text[close..].starts_with('\n') {
        close + 1
    } else {
        close
    };

    let mut next = String::with_capacity(text.len());
    next.push_str(&text[..at]);
    next.push_str(&text[cut..]);
    fs::write(path, next).map_err(|e| e.to_string())?;
    Ok(format!("Steam will fetch {steam_id} again"))
}

/// Carry out a repair plan, backing every target up first.
///
/// One failing action does not stop the run: the rest still apply and the failure is
/// reported against its own target, because a plan of 730 texture resizes should not be
/// abandoned wholesale because one file is locked.
/// Anything that takes real time, or emits while it works, must not run on the main thread.
///
/// Tauri runs a synchronous command on the main thread, which is the thread that pumps the
/// webview's message loop. A long command therefore blocks the window, and an `emit` from
/// inside one deadlocks outright: the emit needs the pump that the command is holding. This
/// ran 476 texture resizes and hung on the very first progress event, with the process at
/// zero CPU. `(async)` runs the same synchronous body on a worker thread instead.
#[tauri::command(async)]
fn run_file_actions(
    app: AppHandle,
    actions: Vec<FileAction>,
    config_dir: Option<String>,
) -> Result<RunReport, String> {
    let total = actions.len();
    // Also to stdout: when the window shows nothing, this is what says whether the run is
    // progressing, stalled, or never started. Launched from Explorer nobody sees it.
    println!("[rimdoc] apply: {total} actions");
    // Taking the original-version copy walks the whole Config folder, so it is announced
    // before it starts rather than leaving the first pause unexplained.
    let _ = app.emit("repair:backup", config_dir.clone());
    let backup_dir = save_original(config_dir.as_deref())?;
    let _ = app.emit("repair:start", total);

    let mut outcomes = Vec::new();
    let (mut applied, mut failed, mut skipped) = (0, 0, 0);

    for (i, action) in actions.into_iter().enumerate() {
        let (target, result) = match &action {
            FileAction::AddSupportedVersion { path, cycle } => {
                let p = PathBuf::from(path);
                (
                    path.clone(),
                    backup_once(&p).and_then(|_| add_supported_version(&p, cycle)),
                )
            }
            FileAction::Write { path, contents } => {
                let p = PathBuf::from(path);
                let write = backup_once(&p)
                    .and_then(|_| fs::write(&p, contents).map_err(|e| e.to_string()))
                    .map(|_| "written".to_string());
                (path.clone(), write)
            }
            FileAction::DownscalePng { path, max_px } => {
                let p = PathBuf::from(path);
                (
                    path.clone(),
                    backup_once(&p).and_then(|_| downscale(&p, *max_px)),
                )
            }
            FileAction::DeleteMatching { directory, pattern } => (
                directory.clone(),
                delete_matching(Path::new(directory), pattern),
            ),
            FileAction::ForgetWorkshopItem { path, steam_id } => {
                let p = PathBuf::from(path);
                if is_steam_running() {
                    (
                        path.clone(),
                        Err("Steam is running, and it rewrites this file on exit. Close Steam and try again.".to_string()),
                    )
                } else {
                    (
                        path.clone(),
                        backup_once(&p).and_then(|_| forget_workshop_item(&p, steam_id)),
                    )
                }
            }
        };

        let (ok, detail) = match result {
            Ok(detail) => {
                if detail.starts_with("already") || detail == "nothing there" {
                    skipped += 1;
                } else {
                    applied += 1;
                }
                (true, detail)
            }
            Err(detail) => {
                failed += 1;
                (false, detail)
            }
        };

        // A dropped event must not fail the run: the report is still returned in full, and
        // losing a transcript line matters far less than abandoning 300 pending resizes.
        let _ = app.emit(
            "repair:progress",
            RepairProgress {
                index: i + 1,
                total,
                target: target.clone(),
                ok,
                detail: detail.clone(),
            },
        );
        if (i + 1) % 50 == 0 || i + 1 == total {
            println!("[rimdoc] apply: {} / {total}", i + 1);
        }
        outcomes.push(ActionOutcome { target, ok, detail });
    }

    Ok(RunReport {
        applied,
        failed,
        skipped,
        backup_dir: backup_dir.display().to_string(),
        outcomes,
    })
}

/// Write a modpack's load order into the game's ModsConfig.xml.
#[tauri::command]
fn apply_mods_config(path: String, contents: String) -> Result<String, String> {
    let target = PathBuf::from(&path);
    backup_once(&target)?;
    fs::write(&target, contents).map_err(|e| e.to_string())?;
    Ok(format!("wrote {path}"))
}

/// Undo a run by restoring every `.rimdocbak` beside the paths it touched.
#[tauri::command(async)]
fn rollback(targets: Vec<String>) -> Result<RunReport, String> {
    let mut outcomes = Vec::new();
    let (mut applied, mut failed, mut skipped) = (0, 0, 0);

    for target in targets {
        let path = PathBuf::from(&target);
        let bak = PathBuf::from(format!("{target}.rimdocbak"));
        if !bak.exists() {
            skipped += 1;
            outcomes.push(ActionOutcome {
                target,
                ok: true,
                detail: "no backup".into(),
            });
            continue;
        }
        let restore = (|| -> Result<(), String> {
            if path.exists() {
                if path.is_dir() {
                    fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
                } else {
                    fs::remove_file(&path).map_err(|e| e.to_string())?;
                }
            }
            fs::rename(&bak, &path).map_err(|e| e.to_string())
        })();

        match restore {
            Ok(()) => {
                applied += 1;
                outcomes.push(ActionOutcome {
                    target,
                    ok: true,
                    detail: "restored".into(),
                });
            }
            Err(detail) => {
                failed += 1;
                outcomes.push(ActionOutcome {
                    target,
                    ok: false,
                    detail,
                });
            }
        }
    }

    Ok(RunReport {
        applied,
        failed,
        skipped,
        backup_dir: backups_root()?.display().to_string(),
        outcomes,
    })
}

/// Walk the install and report what is actually there right now.
///
/// The browser build reads a fixture written at build time, which is fine for a preview but
/// means the desktop app would keep reporting the install as it was when it was compiled.
/// After a repair rewrites 730 textures, or after Steam updates a mod, that snapshot is
/// simply wrong, so the shell scans for itself.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgressEvent {
    done: usize,
    total: usize,
    label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLog {
    path: String,
    text: String,
}

/// Read the game's current Player.log.
///
/// The browser build reads a fixture written at build time, which froze the Session tab at
/// whenever the app was compiled: a fault the player had since fixed stayed on screen, and a
/// new one never appeared. Read lossily on purpose, because logs carry raw bytes from mods
/// with odd encodings and a strict decode would drop the whole file over one of them.
#[tauri::command(async)]
fn read_session_log() -> Result<Option<SessionLog>, String> {
    let Some(path) = scan::discover().player_log else {
        return Ok(None);
    };
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Ok(None),
    };
    Ok(Some(SessionLog {
        path,
        text: bytes.iter().map(|&b| b as char).collect(),
    }))
}

/// Every save RimWorld has written, newest first, with the mod list each was made with.
///
/// Only the head of each file is read: the mod list sits in a meta block at the very top,
/// and a save runs to a hundred megabytes of world data below it that nothing here needs.
#[tauri::command(async)]
fn list_saves() -> Result<Vec<scan::SaveMeta>, String> {
    let Some(save_data) = scan::discover().save_data else {
        return Ok(Vec::new());
    };
    Ok(scan::list_saves(Path::new(&save_data))
        .iter()
        // A save being unreadable is not a reason to report none of them.
        .filter_map(|p| scan::read_save_meta(p).ok())
        .collect())
}

#[tauri::command(async)]
fn scan_install(app: AppHandle) -> Result<scan::ScanResult, String> {
    scan::scan_install_with(None, &mut |p| {
        let _ = app.emit(
            "scan:progress",
            ScanProgressEvent {
                done: p.done,
                total: p.total,
                label: p.label.to_string(),
            },
        );
    })
}

/// Read a mod's banner image back as a data URL.
///
/// Deliberately narrower than enabling Tauri's asset protocol, which would let the webview
/// read any file on the machine to show a picture. Only a Preview image sitting in an About
/// folder can be reached, which is exactly what the scan records and the detail panel asks
/// for, so widening what the UI can see would take a change here rather than a config edit.
#[tauri::command(async)]
fn read_mod_preview(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let in_about = p
        .parent()
        .and_then(|d| d.file_name())
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("about"));

    if !in_about || !name.starts_with("preview.") {
        return Err(format!("Not a mod preview: {path}"));
    }
    let mime = match name.rsplit('.').next().unwrap_or_default() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        other => return Err(format!("Unsupported preview format: {other}")),
    };

    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

fn rimworld_exe(game_dir: &str) -> Result<PathBuf, String> {
    ["RimWorldWin64.exe", "RimWorld.exe", "RimWorldWin.exe"]
        .iter()
        .map(|name| Path::new(game_dir).join(name))
        .find(|candidate| candidate.exists())
        .ok_or_else(|| format!("No RimWorld executable in {game_dir}"))
}

/// Start RimWorld and hand it over, without watching it.
#[tauri::command]
fn launch_game(game_dir: String) -> Result<String, String> {
    let exe = rimworld_exe(&game_dir)?;
    Command::new(&exe)
        .current_dir(&game_dir)
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", exe.display()))?;
    Ok(exe.display().to_string())
}

/// The supervised run's process id, so it can be stopped without guessing at one.
///
/// Killing by image name would take down a copy of the game the app did not start, which is
/// exactly the sort of thing an unattended search must not do.
static GAME_PID: Mutex<Option<u32>> = Mutex::new(None);

/// Take a mod's current build into the vault.
///
/// Cheap to call over a whole modpack: a build already held is recognised by its hash and
/// costs one walk and no copy, so only what has actually changed is written.
#[tauri::command(async)]
fn vault_capture(
    folder: String,
    package_id: String,
    name: String,
) -> Result<vault::VaultEntry, String> {
    vault::capture(Path::new(&folder), &package_id, &name, now_iso())
}

#[tauri::command(async)]
fn vault_list() -> Result<Vec<vault::VaultEntry>, String> {
    vault::list()
}

/// Put a vaulted build back, backing up what it replaces.
#[tauri::command(async)]
fn vault_restore(package_id: String, hash: String, target: String) -> Result<String, String> {
    vault::restore(&package_id, &hash, Path::new(&target))
}

#[tauri::command(async)]
fn vault_forget(package_id: String, hash: String) -> Result<String, String> {
    vault::forget(&package_id, &hash)
}

/// What is in a mod folder right now, as one hash, without copying anything.
///
/// This is how a pin is checked: the modpack records the hash it was built against, and a
/// mismatch means the mod on disk is not the one it was tested with.
#[tauri::command(async)]
fn hash_mod(folder: String) -> Result<String, String> {
    vault::hash_folder(Path::new(&folder)).map(|(hash, _, _)| hash)
}

/// Stop the run this app started, if it is still going.
///
/// Used by a search that decides for itself: once the log has said whether the mod list
/// loads, the run has answered its question and sitting at the main menu answers nothing
/// more. Never touches a game the app did not launch.
#[tauri::command(async)]
fn stop_game() -> Result<String, String> {
    let pid = { *GAME_PID.lock().map_err(|e| e.to_string())? };
    let Some(pid) = pid else {
        return Ok("No supervised run to stop".into());
    };
    let out = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(if out.status.success() {
        format!("Stopped {pid}")
    } else {
        // Already gone is the common case, and not a failure worth surfacing.
        format!("{pid} was no longer running")
    })
}

/// How long the game may write nothing before the run is called quiet.
///
/// Loading a large mod list has genuinely silent stretches, so this is well past anything a
/// working load produces. It reports rather than acts: a quiet run is a fact about the log,
/// not proof of a hang, and killing someone's game on a guess is not worth being right.
const QUIET_SECONDS: u64 = 90;

/// How often the log is read and the process checked.
const POLL_MS: u64 = 250;

/// Current working set of a process, in megabytes.
///
/// Read through tasklist rather than a Windows API binding: it is one poll every quarter
/// second against a process that is loading gigabytes of textures, so the cost of spawning
/// it is irrelevant next to what it is measuring.
fn memory_mb(pid: u32) -> Option<u64> {
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // "name","pid","session","n","27,900 K"
    let field = text.split(',').next_back()?.trim().trim_matches('"');
    let kb: u64 = field
        .trim_end_matches(" K")
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()?;
    Some(kb / 1024)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameExit {
    /// Highest working set seen while the run was watched.
    peak_memory_mb: u64,
    /// None when the process was terminated rather than exiting on its own.
    code: Option<i32>,
    duration_ms: u128,
    lines: usize,
    /// True when the game stopped writing well before it stopped running.
    went_quiet: bool,
}

/// Start RimWorld and watch it.
///
/// The log is followed from wherever it stands when the game starts, because RimWorld
/// truncates Player.log on launch: reading from the beginning would replay the previous run
/// as though it were this one, and reading from the old end would miss everything until the
/// file grew past it. A shrinking file is the truncation, so the offset resets with it.
///
/// Nothing here decides the game is broken. It reports what the run did, and the exit code
/// and the transcript are what the player and the rules reason about afterwards.
#[tauri::command(async)]
fn launch_supervised(app: AppHandle, game_dir: String, log_path: String) -> Result<String, String> {
    let exe = rimworld_exe(&game_dir)?;
    let mut child = Command::new(&exe)
        .current_dir(&game_dir)
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", exe.display()))?;

    let log = PathBuf::from(&log_path);
    let started = std::time::Instant::now();
    if let Ok(mut slot) = GAME_PID.lock() {
        *slot = Some(child.id());
    }
    let _ = app.emit("game:started", exe.display().to_string());

    // A thread rather than the command's own body: the command returns as soon as the game
    // is up, so the window stays usable while the run is watched.
    std::thread::spawn(move || {
        let mut offset: u64 = fs::metadata(&log).map(|m| m.len()).unwrap_or(0);
        let mut lines = 0usize;
        let mut last_output = std::time::Instant::now();
        let mut went_quiet = false;
        let mut carry = String::new();
        let pid = child.id();
        let mut peak_memory_mb = 0u64;

        loop {
            let exited = child.try_wait().ok().flatten();

            match read_from(&log, &mut offset) {
                Some(chunk) if !chunk.is_empty() => {
                    carry.push_str(&chunk);
                    // Hold back a trailing partial line: the game writes in chunks, and
                    // splitting mid-line would put half a stack frame in the transcript.
                    let keep = carry.rfind('\n').map(|i| i + 1).unwrap_or(0);
                    let ready: Vec<String> = carry[..keep]
                        .lines()
                        .map(|l| l.trim_end().to_string())
                        .collect();
                    carry.drain(..keep);

                    if !ready.is_empty() {
                        lines += ready.len();
                        last_output = std::time::Instant::now();
                        let _ = app.emit("game:lines", ready);
                    }
                }
                _ => {}
            }

            if !went_quiet && exited.is_none() && last_output.elapsed().as_secs() >= QUIET_SECONDS {
                went_quiet = true;
                let _ = app.emit("game:quiet", QUIET_SECONDS);
            }

            if let Some(mb) = memory_mb(pid) {
                peak_memory_mb = peak_memory_mb.max(mb);
            }

            if let Some(status) = exited {
                if let Ok(mut slot) = GAME_PID.lock() {
                    *slot = None;
                }
                let _ = app.emit(
                    "game:exited",
                    GameExit {
                        peak_memory_mb,
                        code: status.code(),
                        duration_ms: started.elapsed().as_millis(),
                        lines,
                        went_quiet,
                    },
                );
                return;
            }

            std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
        }
    });

    Ok(exe.display().to_string())
}

/// Read whatever has been appended since the last look.
///
/// A file shorter than the offset has been truncated, which is RimWorld starting a new run,
/// so the offset goes back to the beginning rather than waiting for the file to grow past
/// where the previous run left off.
fn read_from(path: &Path, offset: &mut u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};

    let len = fs::metadata(path).ok()?.len();
    if len < *offset {
        *offset = 0;
    }
    if len == *offset {
        return None;
    }

    let mut file = fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(*offset)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    *offset = len;
    // Lossy on purpose: logs carry raw bytes from mods with odd encodings, and a strict
    // decode would drop the whole chunk over one of them.
    Some(bytes.iter().map(|&b| b as char).collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            run_file_actions,
            apply_mods_config,
            rollback,
            launch_game,
            read_mod_preview,
            scan_install,
            read_session_log,
            is_steam_running,
            list_saves,
            launch_supervised,
            stop_game,
            vault_capture,
            vault_list,
            vault_restore,
            vault_forget,
            hash_mod
        ])
        .run(tauri::generate_context!())
        .expect("error while running RimDoc+");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    /// The PowerShell executor once copied a directory without -Recurse, which produced an
    /// empty folder and made removing a duplicate mod unrecoverable while reporting success.
    #[test]
    fn backing_up_a_directory_keeps_what_is_inside_it() {
        let tmp = tempdir().unwrap();
        let mod_dir = tmp.path().join("DuplicateMod");
        write(&mod_dir.join("About/About.xml"), "<ModMetaData/>");
        write(&mod_dir.join("Defs/Things.xml"), "<Defs/>");

        backup_once(&mod_dir).unwrap();

        let bak = tmp.path().join("DuplicateMod.rimdocbak");
        assert_eq!(
            fs::read_to_string(bak.join("About/About.xml")).unwrap(),
            "<ModMetaData/>"
        );
        assert_eq!(
            fs::read_to_string(bak.join("Defs/Things.xml")).unwrap(),
            "<Defs/>"
        );
    }

    /// A second run must not overwrite the copy the first run took, or the backup would
    /// track the damage instead of preceding it.
    #[test]
    fn a_backup_is_never_retaken() {
        let tmp = tempdir().unwrap();
        let file = tmp.path().join("ModsConfig.xml");
        write(&file, "original");
        backup_once(&file).unwrap();

        write(&file, "changed");
        backup_once(&file).unwrap();

        let bak = tmp.path().join("ModsConfig.xml.rimdocbak");
        assert_eq!(fs::read_to_string(bak).unwrap(), "original");
    }

    /// "*" means the folder itself. This is the only destructive repair, so the round trip
    /// through rollback is the property that matters, not the deletion on its own.
    #[test]
    fn removing_a_duplicate_folder_can_be_undone() {
        let tmp = tempdir().unwrap();
        let mod_dir = tmp.path().join("Hospitality");
        write(&mod_dir.join("About/About.xml"), "<ModMetaData/>");
        write(&mod_dir.join("Assemblies/Hospitality.dll"), "MZ");

        let detail = delete_matching(&mod_dir, "*").unwrap();
        assert_eq!(detail, "removed folder");
        assert!(!mod_dir.exists());

        let report = rollback(vec![mod_dir.display().to_string()]).unwrap();
        assert_eq!(report.applied, 1);
        assert_eq!(report.failed, 0);
        assert_eq!(
            fs::read_to_string(mod_dir.join("About/About.xml")).unwrap(),
            "<ModMetaData/>"
        );
        assert_eq!(
            fs::read_to_string(mod_dir.join("Assemblies/Hospitality.dll")).unwrap(),
            "MZ"
        );
        assert!(!tmp.path().join("Hospitality.rimdocbak").exists());
    }

    /// The settings repair passes `Mod_<id>_*.xml`, which must not reach its neighbours.
    #[test]
    fn a_glob_removes_only_what_it_matches() {
        let tmp = tempdir().unwrap();
        write(&tmp.path().join("Mod_brrainz.harmony_Settings.xml"), "a");
        write(&tmp.path().join("Mod_brrainz.harmony_Other.xml"), "b");
        write(&tmp.path().join("Mod_other.mod_Settings.xml"), "c");
        write(&tmp.path().join("ModsConfig.xml"), "keep");

        delete_matching(tmp.path(), "Mod_brrainz.harmony_*.xml").unwrap();

        assert!(!tmp.path().join("Mod_brrainz.harmony_Settings.xml").exists());
        assert!(!tmp.path().join("Mod_brrainz.harmony_Other.xml").exists());
        assert!(tmp.path().join("Mod_other.mod_Settings.xml").exists());
        assert!(tmp.path().join("ModsConfig.xml").exists());
    }

    #[test]
    fn stamping_a_cycle_is_idempotent() {
        let tmp = tempdir().unwrap();
        let about = tmp.path().join("About.xml");
        write(&about, "<ModMetaData>\n  <supportedVersions>\n    <li>1.5</li>\n  </supportedVersions>\n</ModMetaData>");

        assert_eq!(add_supported_version(&about, "1.6").unwrap(), "stamped 1.6");
        assert_eq!(
            add_supported_version(&about, "1.6").unwrap(),
            "already advertises 1.6"
        );

        let xml = fs::read_to_string(&about).unwrap();
        assert_eq!(xml.matches("<li>1.6</li>").count(), 1);
        assert!(
            xml.contains("<li>1.5</li>"),
            "the existing cycle must survive"
        );
    }

    /// The shell is a second executor of a plan the TypeScript layer writes, so the union it
    /// emits has to land here unchanged. It carries fields Rust does not model, and dropping
    /// them silently is the intended behaviour rather than an oversight.
    #[test]
    fn the_typescript_plan_deserialises() {
        let json = r#"[
          {"op":"add-supported-version","path":"C:/mods/a/About/About.xml","cycle":"1.6","reason":"stale"},
          {"op":"write","path":"C:/cfg/ModsConfig.xml","contents":"<ModsConfigData/>","reason":"order"},
          {"op":"delete-matching","directory":"C:/mods/dupe","pattern":"*","reason":"duplicate"},
          {"op":"downscale-png","path":"C:/mods/a/T.png","maxPx":512,"fromPx":2048,"reason":"big"}
        ]"#;

        let actions: Vec<FileAction> = serde_json::from_str(json).unwrap();
        assert_eq!(actions.len(), 4);
        match &actions[3] {
            FileAction::DownscalePng { path, max_px } => {
                assert_eq!(max_px, &512);
                assert!(path.ends_with("T.png"));
            }
            other => panic!("expected a downscale, got {other:?}"),
        }
    }

    /// The preview command exists to be a restriction, so what it refuses is the behaviour
    /// worth pinning down. It reads a banner and nothing else, however the path is dressed up.
    #[test]
    fn only_a_mod_banner_can_be_read_back() {
        let tmp = tempdir().unwrap();
        let about = tmp.path().join("About");
        write(
            &about.join("Preview.png"),
            "not really a png, but it is the right file",
        );
        write(&about.join("About.xml"), "<ModMetaData/>");
        write(&tmp.path().join("secrets.png"), "somewhere else entirely");

        assert!(read_mod_preview(about.join("Preview.png").display().to_string()).is_ok());

        // The neighbouring metadata, a file outside an About folder, and a traversal that
        // lands on one are all refused, so widening what the UI can see means editing this.
        for denied in [
            about.join("About.xml"),
            tmp.path().join("secrets.png"),
            about.join("..").join("secrets.png"),
        ] {
            assert!(
                read_mod_preview(denied.display().to_string()).is_err(),
                "{} should not be readable",
                denied.display()
            );
        }
    }

    /// Vault a real mod, twice, and check the second is recognised rather than re-copied.
    ///
    /// Run with `cargo test --lib -- --ignored vault_roundtrip --nocapture`.
    #[test]
    #[ignore]
    fn vault_roundtrip() {
        let scanned = scan::scan_install(None).expect("scan");
        // A small one: the point is the addressing, not how fast a gigabyte copies.
        let target = scanned
            .mods
            .iter()
            .filter(|m| m.size_bytes > 100_000 && m.size_bytes < 4_000_000)
            .min_by_key(|m| m.size_bytes)
            .expect("a small mod");
        println!(
            "vaulting {} ({:.1} MB)",
            target.name,
            target.size_bytes as f64 / 1024.0 / 1024.0
        );

        let first = vault::capture(
            Path::new(&target.folder),
            &target.package_id,
            &target.name,
            now_iso(),
        )
        .expect("capture");
        println!("  hash {} over {} files", first.hash, first.files);

        let again = vault::capture(
            Path::new(&target.folder),
            &target.package_id,
            &target.name,
            now_iso(),
        )
        .expect("recapture");
        assert_eq!(first.hash, again.hash, "same build must hash the same");
        assert_eq!(
            first.captured_at, again.captured_at,
            "a build already held must be recognised, not re-copied"
        );

        // The same content hashes the same wherever it lives, which is what makes the vault
        // addressable at all.
        let copy = std::env::temp_dir().join("rimdoc-vault-probe");
        let _ = fs::remove_dir_all(&copy);
        vault::restore(&target.package_id, &first.hash, &copy).expect("restore");
        let (copied, _, files) = vault::hash_folder(&copy).expect("hash the restored copy");
        println!("  restored to {} files, hash {}", files, copied);
        assert_eq!(copied, first.hash, "a restored build must hash identically");

        let _ = fs::remove_dir_all(&copy);
        vault::forget(&target.package_id, &first.hash).expect("forget");
        println!("  vault now holds {} builds", vault::list().unwrap().len());
    }

    /// Read the real saves and report what each was made with. Ignored: needs RimWorld.
    ///
    /// Run with `cargo test --lib -- --ignored dump_saves --nocapture`.
    #[test]
    #[ignore]
    fn dump_saves() {
        let save_data = scan::discover().save_data.expect("save folder");
        let paths = scan::list_saves(Path::new(&save_data));
        println!("{} saves", paths.len());
        for p in &paths {
            match scan::read_save_meta(p) {
                Ok(m) => println!(
                    "  {:<44} {:>4} mods  {}  {}",
                    m.name.chars().take(44).collect::<String>(),
                    m.mod_ids.len(),
                    m.game_version,
                    m.saved_at.unwrap_or_default()
                ),
                Err(e) => println!("  {} FAILED: {e}", p.display()),
            }
        }
    }

    /// Only the installed record goes, never the subscription.
    ///
    /// The manifest lists both, and the id appears in each. Removing the subscription would
    /// unsubscribe the player, which is the opposite of asking Steam to fetch the item again,
    /// so the search is bounded to the installed section.
    #[test]
    fn forgetting_an_item_leaves_the_subscription_alone() {
        let tmp = tempdir().unwrap();
        let acf = tmp.path().join("appworkshop_294100.acf");
        let manifest = concat!(
            "\"AppWorkshop\"\n{\n",
            "\t\"WorkshopItemsInstalled\"\n\t{\n",
            "\t\t\"111\"\n\t\t{\n\t\t\t\"size\"\t\t\"5\"\n\t\t}\n",
            "\t\t\"222\"\n\t\t{\n\t\t\t\"size\"\t\t\"7\"\n\t\t}\n",
            "\t}\n",
            "\t\"WorkshopItemDetails\"\n\t{\n",
            "\t\t\"222\"\n\t\t{\n\t\t\t\"subscribedby\"\t\t\"9\"\n\t\t}\n",
            "\t}\n}\n",
        );
        fs::write(&acf, manifest).unwrap();

        let detail = forget_workshop_item(&acf, "222").unwrap();
        assert!(detail.contains("222"), "{detail}");

        let after = fs::read_to_string(&acf).unwrap();
        let installed = after.find("WorkshopItemsInstalled").unwrap();
        let details = after.find("WorkshopItemDetails").unwrap();

        // Gone from what Steam thinks it has downloaded...
        assert!(!after[installed..details].contains("222"));
        // ...still there as a subscription, which is what makes Steam fetch it again.
        assert!(after[details..].contains("222"));
        // The untouched neighbour survives intact.
        assert!(after[installed..details].contains("111"));
        assert!(after.contains("AppWorkshop"));
    }

    /// An id Steam has no record of installing is not an error: the folder removal beside it
    /// is the part that matters, and a manifest that never mentioned it is already correct.
    #[test]
    fn forgetting_an_unknown_item_is_not_a_failure() {
        let tmp = tempdir().unwrap();
        let acf = tmp.path().join("appworkshop_294100.acf");
        fs::write(&acf, "\"WorkshopItemsInstalled\"\n\t{\n\t}").unwrap();
        assert!(forget_workshop_item(&acf, "999")
            .unwrap()
            .contains("not recorded"));
    }

    /// Rolling back a path nothing backed up is reported, not treated as a failure: the
    /// undo runs over every target a plan named, including those that never changed.
    #[test]
    fn rolling_back_an_untouched_path_is_not_a_failure() {
        let tmp = tempdir().unwrap();
        let missing = tmp.path().join("never-touched.xml");

        let report = rollback(vec![missing.display().to_string()]).unwrap();
        assert_eq!(report.skipped, 1);
        assert_eq!(report.failed, 0);
        assert_eq!(report.outcomes[0].detail, "no backup");
    }
}

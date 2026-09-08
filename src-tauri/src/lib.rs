mod files;
mod scan;
mod vault;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

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
struct ActionOutcome {
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
struct RunReport {
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
    Ok(files::home_dir_for("write backups into")?.join("RimDoc-Backups"))
}

/// Whether a path walks back up through a parent component.
fn climbs(path: &Path) -> bool {
    path.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
}

/// Copy a file or directory beside itself as `.rimdocbak`, once.
///
/// Directories are copied recursively. A plain copy of a directory creates an empty one,
/// which would make removing a duplicate mod folder unrecoverable while looking backed up.
fn backup_once(path: &Path) -> Result<(), String> {
    if !path.exists() {
        // Nothing to copy, but the fact that there was nothing is itself what an undo needs:
        // without it a repair that only creates files was unrollbackable, and the run still
        // told the reader every change could be put back. The marker is what rollback reads
        // to know the file should not exist afterwards.
        let marker = PathBuf::from(format!("{}.rimdocbak.absent", path.display()));
        if !marker.exists() {
            if let Some(dir) = marker.parent() {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            fs::write(&marker, b"").map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let bak = PathBuf::from(format!("{}.rimdocbak", path.display()));
    if bak.exists() {
        return Ok(());
    }
    if path.is_dir() {
        files::copy_dir_all(path, &bak)
    } else {
        fs::copy(path, &bak).map(|_| ()).map_err(|e| e.to_string())
    }
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
            files::copy_dir_all(source, &original.join("Config"))?;
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

/// Whether a folder delete belongs to a workshop item whose manifest edit was refused.
///
/// A workshop folder is named for its item id, which is what pairs the two actions. Deleting
/// the folder while Steam still has the item recorded as installed leaves the mod gone and
/// never re-fetched, which is worse than not repairing it at all. So a refused edit has to
/// cancel its own delete rather than only be reported beside it.
fn paired_with_refused(directory: &str, refused: &[String]) -> bool {
    match Path::new(directory).file_name() {
        Some(name) => refused.iter().any(|id| *id == name.to_string_lossy()),
        None => false,
    }
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

/// A console program, run without flashing its window up.
///
/// This app has no console of its own, so Windows gives every `tasklist` or `reg` it runs a
/// fresh one and it appears on screen. During a supervised run that is a black rectangle
/// blinking over the game every five seconds.
fn console_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Whether a process with this image name is running, or None when it could not be asked.
///
/// Unknown is kept apart from false because the two callers want opposite defaults from it.
/// A repair deciding whether it may edit Steam's record treats unknown as running and
/// declines. A loop waiting for Steam to finish closing has to do the same: treating unknown
/// as gone would start writing that record underneath a Steam still holding it in memory,
/// which is the exact failure the wait exists to prevent.
fn image_running(image: &str) -> Option<bool> {
    let output = console_command("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {image}"), "/NH"])
        .output()
        .ok()?;
    Some(
        String::from_utf8_lossy(&output.stdout)
            .to_lowercase()
            .contains(&image.to_lowercase()),
    )
}

/// Whether the Steam client is running.
///
/// It holds its workshop manifest in memory and rewrites the file on exit, so an edit made
/// while it is up is simply undone. Anything that touches that manifest has to check first.
#[tauri::command(async)]
fn is_steam_running() -> bool {
    // Unknown is treated as running: refusing to edit is recoverable, editing under a live
    // Steam silently loses the change and looks like the repair did nothing.
    image_running("steam.exe").unwrap_or(true)
}

/// The Steam app id of the game Steam is currently running, or None for none.
///
/// Steam keeps this in its own registry key and zeroes it when the game exits, which makes
/// it the one cheap way to ask "is a game up" that covers every game rather than only the
/// one this app knows about. `-shutdown` is headless: it cannot raise Steam's usual "a game
/// is running" prompt, so it would close Steam out from under a live session in silence.
fn running_app_id() -> Option<u32> {
    parse_reg_dword(&steam_registry_value("RunningAppID")?).filter(|id| *id != 0)
}

/// One value out of Steam's own registry key, as `reg` prints it.
///
/// Shelled out to rather than linked against a registry crate: two string reads do not earn
/// a dependency, and `reg` is present on every Windows this app can run on.
fn steam_registry_value(name: &str) -> Option<String> {
    let output = console_command("reg")
        .args(["query", r"HKCU\Software\Valve\Steam", "/v", name])
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The number out of a `reg query` printing one REG_DWORD, which it writes in hex.
fn parse_reg_dword(text: &str) -> Option<u32> {
    let value = text
        .lines()
        .find_map(|line| line.split("REG_DWORD").nth(1))?;
    u32::from_str_radix(value.trim().trim_start_matches("0x"), 16).ok()
}

/// The string out of a `reg query` printing one REG_SZ.
///
/// Taken as everything after the type rather than as the last whitespace-separated word,
/// because the value here is a path and the default one contains spaces: splitting on
/// whitespace yields "(x86)/steam/steam.exe" on the machine of almost every user.
fn parse_reg_sz(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let after = line.split("REG_SZ").nth(1)?.trim();
        (!after.is_empty()).then(|| after.to_string())
    })
}

/// Whether Steam is running a game right now.
///
/// Asked before Steam is closed, because closing it takes the game with it and the button
/// that does so says nothing about that.
#[tauri::command(async)]
fn is_game_running() -> bool {
    running_app_id().is_some()
}

/// Where steam.exe is, according to Steam.
///
/// The registry first, because it is the only source that is right on a machine with Steam
/// installed somewhere other than Program Files. The workshop folder the scan already found
/// is the fallback: on a default setup it sits beneath the install, and the alternative to
/// looking there is asking the player to go and find it themselves.
fn steam_exe(workshop: Option<&str>) -> Result<PathBuf, String> {
    if let Some(recorded) = steam_exe_from_registry() {
        if recorded.is_file() {
            return Ok(recorded);
        }
    }
    if let Some(found) = workshop.and_then(steam_exe_above) {
        return Ok(found);
    }
    Err("Could not find steam.exe on this machine. Close Steam yourself and apply again.".into())
}

/// Steam records its own executable under Software\Valve\Steam.
///
/// Written there with forward slashes and in lower case, which Windows accepts as it stands;
/// normalised anyway so the path reads like a path wherever it is reported back.
fn steam_exe_from_registry() -> Option<PathBuf> {
    let value = parse_reg_sz(&steam_registry_value("SteamExe")?)?;
    Some(PathBuf::from(value.replace('/', "\\")))
}

/// The nearest steam.exe above the workshop content folder.
///
/// Searched upward rather than counted out, because the number of levels is a fact about
/// Steam's layout rather than about this app. A library folder on a second drive has the
/// same shape with no steam.exe above it anywhere, and finding nothing there is the right
/// answer: that install's client lives elsewhere, and the registry is what knows where.
fn steam_exe_above(workshop: &str) -> Option<PathBuf> {
    let mut dir = Path::new(workshop);
    for _ in 0..6 {
        dir = dir.parent()?;
        let candidate = dir.join("steam.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// How long Steam is given to close before the repair is abandoned.
///
/// It flushes its download record on the way out, and on a slow machine with a large library
/// that takes a while. Generous, because the alternative to waiting is writing that record
/// underneath a Steam that is still up, which is the whole thing this exists to avoid.
const STEAM_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(45);
const STEAM_SHUTDOWN_POLL: Duration = Duration::from_millis(500);

/// Close Steam, and return only once it has actually gone.
///
/// Steam's own `-shutdown` rather than killing it, because a kill is precisely the case
/// where the record never gets written: what would be left on disk is whatever Steam last
/// happened to flush, and the repair would be editing a stale file. Waiting for the process
/// to leave is what makes the edit that follows the last word on the subject.
#[derive(Debug, Serialize)]
struct SteamShutdown {
    /// True only when this call actually closed a Steam that was running. Kept apart from
    /// the message because the caller decides whether to start Steam again from it, and
    /// starting a Steam the player did not have open is its own small rudeness.
    closed: bool,
    detail: String,
}

#[tauri::command(async)]
fn stop_steam(workshop: Option<String>) -> Result<SteamShutdown, String> {
    // Located before anything is asked to close, so a machine this app cannot find Steam on
    // fails while Steam is still up rather than after it has been shut down.
    let exe = steam_exe(workshop.as_deref())?;
    if image_running("steam.exe") == Some(false) {
        return Ok(SteamShutdown {
            closed: false,
            detail: "Steam was not running".into(),
        });
    }
    Command::new(&exe)
        .arg("-shutdown")
        .spawn()
        .map_err(|e| format!("Could not ask {} to close: {e}", exe.display()))?;

    let started = Instant::now();
    // Whether the wait ever got a straight answer. A run where every reading failed timed
    // out reporting that Steam would not close, which is a claim about Steam made from no
    // evidence at all: what actually failed was the question.
    let mut ever_answered = false;
    loop {
        std::thread::sleep(STEAM_SHUTDOWN_POLL);
        match image_running("steam.exe") {
            Some(false) => {
                return Ok(SteamShutdown {
                    closed: true,
                    detail: format!(
                        "Steam closed after {:.0} seconds",
                        started.elapsed().as_secs_f32()
                    ),
                })
            }
            Some(true) => ever_answered = true,
            None => {}
        }
        if started.elapsed() >= STEAM_SHUTDOWN_TIMEOUT {
            return Err(if ever_answered {
                format!(
                    "Steam was still running {} seconds after being asked to close, so nothing has been changed. It may be part way through a download, or waiting on a running game. Close it yourself and apply again.",
                    STEAM_SHUTDOWN_TIMEOUT.as_secs()
                )
            } else {
                "Could not tell whether Steam closed, so nothing has been changed. Check it yourself and apply again.".to_string()
            });
        }
    }
}

/// Start Steam again.
///
/// Called whether or not the repair worked. Leaving someone's Steam closed because a file
/// edit failed is a worse state than the one this found.
#[tauri::command(async)]
fn start_steam(workshop: Option<String>) -> Result<String, String> {
    let exe = steam_exe(workshop.as_deref())?;
    let mut command = Command::new(&exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Its own process group and no inherited console, so Steam is not a child that dies
        // with this app or inherits its lifetime. The player closing RimDoc+ afterwards must
        // not take their Steam with it.
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", exe.display()))?;
    Ok(exe.display().to_string())
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
    // Workshop items whose manifest edit was refused. Deleting such a mod's folder is only
    // safe once Steam has stopped believing it is installed: doing it anyway leaves the mod
    // gone and never re-fetched, which is worse than not repairing it at all. One failing
    // action does not stop the rest of a run, so the pairing has to be enforced here.
    let mut refused: Vec<String> = Vec::new();

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
                // Every path this app produces is absolute and built from a scan, so a
                // parent component in one means it was built from something a scan read
                // rather than found: a def name out of a log line, a mod name out of an
                // About.xml. Refused here as well as where it is built, because creating
                // missing parents made a climbing path land somewhere real.
                if climbs(&p) {
                    outcomes.push(ActionOutcome {
                        target: path.clone(),
                        ok: false,
                        detail: "refused: the path climbs out of its folder".into(),
                    });
                    failed += 1;
                    continue;
                }
                // A write to somewhere that does not exist yet is a write, not a failure.
                // Every write until now landed beside a file the scan had already read, so
                // this never came up; a repair that generates a small mod is all folders
                // that do not exist yet.
                let write = p
                    .parent()
                    .map(|dir| fs::create_dir_all(dir).map_err(|e| e.to_string()))
                    .unwrap_or(Ok(()))
                    .and_then(|_| backup_once(&p))
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
            FileAction::DeleteMatching { directory, pattern } => {
                if paired_with_refused(directory, &refused) {
                    (
                        directory.clone(),
                        Ok("nothing there: left alone, because Steam still has it recorded as installed".to_string()),
                    )
                } else {
                    (
                        directory.clone(),
                        delete_matching(Path::new(directory), pattern),
                    )
                }
            }
            FileAction::ForgetWorkshopItem { path, steam_id } => {
                let p = PathBuf::from(path);
                if is_steam_running() {
                    refused.push(steam_id.clone());
                    (
                        path.clone(),
                        Err("Steam is running, and it rewrites this file on exit. Close Steam and try again.".to_string()),
                    )
                } else {
                    let edit = backup_once(&p).and_then(|_| forget_workshop_item(&p, steam_id));
                    if edit.is_err() {
                        refused.push(steam_id.clone());
                    }
                    (path.clone(), edit)
                }
            }
        };

        let (ok, detail) = match result {
            Ok(detail) => {
                if detail.starts_with("already") || detail.starts_with("nothing there") {
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
        let absent = PathBuf::from(format!("{target}.rimdocbak.absent"));

        // The file did not exist before the run, so undoing it means taking it away again.
        if absent.exists() {
            let undo = (|| -> Result<(), String> {
                if path.is_dir() {
                    fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
                } else if path.exists() {
                    fs::remove_file(&path).map_err(|e| e.to_string())?;
                }
                fs::remove_file(&absent).map_err(|e| e.to_string())
            })();
            match undo {
                Ok(()) => {
                    applied += 1;
                    outcomes.push(ActionOutcome {
                        target,
                        ok: true,
                        detail: "removed, it was not there before".into(),
                    });
                }
                Err(e) => {
                    failed += 1;
                    outcomes.push(ActionOutcome {
                        target,
                        ok: false,
                        detail: e,
                    });
                }
            }
            continue;
        }

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
struct SessionLog {
    path: String,
    text: String,
}

/// Read one of the game's two logs.
///
/// RimWorld truncates Player.log on launch and moves what was there to Player-prev.log, so
/// after a crash the run being diagnosed is the previous one and the live file describes the
/// relaunch that went looking for it. Reading only the current file meant the crash was
/// gone by the time anyone opened the app.
///
/// Named rather than given a path, because a command taking an arbitrary path is a
/// file-read primitive and this app does not have one.
///
/// The browser build reads a fixture written at build time, which froze the Session tab at
/// whenever the app was compiled: a fault the player had since fixed stayed on screen, and a
/// new one never appeared. Read lossily on purpose, because logs carry raw bytes from mods
/// with odd encodings and a strict decode would drop the whole file over one of them.
#[tauri::command(async)]
fn read_session_log(previous: Option<bool>) -> Result<Option<SessionLog>, String> {
    let Some(current) = scan::discover().player_log else {
        return Ok(None);
    };
    let path = if previous.unwrap_or(false) {
        // Sits beside the live one under the name RimWorld gives it.
        let renamed = current.replace("Player.log", "Player-prev.log");
        if renamed == current {
            return Ok(None);
        }
        renamed
    } else {
        current
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

/// Hosts a shared log may be fetched from.
///
/// An allowlist rather than a scheme check, because this is the only outbound request the
/// app makes and the point is that it can reach exactly two places. Matched on the whole
/// host segment and never on a suffix: `gist.github.com.example.com` and
/// `gist.github.com@example.com` both have a host that is not equal to either of these, so
/// both are refused without needing to reason about them.
const LOG_HOSTS: &[&str] = &["gist.github.com", "gist.githubusercontent.com"];

/// A shared log is text. Well past any real log and far short of anything worth streaming.
const MAX_SHARED_LOG: usize = 24 * 1024 * 1024;

/// The host of an https URL, exactly as written.
///
/// Hand-parsed rather than pulled through a URL crate, because the only question being asked
/// is whether the host is one of two literal strings, and equality against the raw segment
/// answers it without a dependency that could disagree with the browser about what a host is.
fn https_host(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    (!host.is_empty()).then_some(host)
}

/// The raw form of a gist link, which is what actually holds the log.
///
/// A gist page is HTML. Its `/raw` path redirects to the file itself, and ureq follows that.
fn raw_gist_url(url: &str) -> String {
    let trimmed = url.trim_end_matches('/');
    if trimmed.contains("gist.githubusercontent.com") || trimmed.ends_with("/raw") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/raw")
    }
}

/// Fetch a log someone shared, from a gist link.
///
/// The one request this app makes, and it only happens because a player pasted a link and
/// pressed a button. RimWorld's Share logs uploads to a gist and writes nothing to disk, so
/// there is no local file to read instead; the alternative to this is asking someone to
/// fetch the page themselves and paste it, which is what the paste box is for.
///
/// Nothing is sent but the URL that was pasted. No identifier of the machine goes with it.
#[tauri::command(async)]
fn fetch_shared_log(url: String) -> Result<SessionLog, String> {
    let url = url.trim();
    let Some(host) = https_host(url) else {
        return Err("That is not an https link. A shared log link starts with https://".into());
    };
    if !LOG_HOSTS.contains(&host) {
        return Err(format!(
            "RimDoc+ only fetches from {}. Paste the log itself instead, which needs no request at all.",
            LOG_HOSTS.join(" and ")
        ));
    }

    let target = raw_gist_url(url);
    let mut response = ureq::get(&target)
        .call()
        .map_err(|e| format!("Could not fetch that link: {e}"))?;

    let text = response
        .body_mut()
        .with_config()
        .limit(MAX_SHARED_LOG as u64)
        .read_to_string()
        .map_err(|e| format!("Could not read what came back: {e}"))?;

    if text.trim().is_empty() {
        return Err("That link returned nothing.".into());
    }

    Ok(SessionLog { path: target, text })
}

/// What the probe reports about one Harmony patch class.
///
/// Passed straight through rather than interpreted here: deciding what a verdict means is
/// analysis, and analysis does not live in the shell.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbePatch {
    assembly: String,
    patch_class: String,
    target_type: Option<String>,
    target_method: Option<String>,
    kinds: Vec<String>,
    verdict: String,
    detail: String,
    moved_to: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeReport {
    game_assemblies: usize,
    game_types: usize,
    assemblies_read: usize,
    assemblies_unreadable: Vec<String>,
    patches: Vec<ProbePatch>,
}

#[derive(Debug, Serialize)]
struct ProbeRequest<'a> {
    managed: String,
    assemblies: &'a [String],
}

/// Where the probe lives.
///
/// Tauri copies a sidecar next to the app executable, so that is the first place to look.
/// The development build is not bundled, so the publish output is the fallback: without it
/// this would only ever work from an installer, which is a poor way to develop the feature
/// that needs the most iterating against a real install.
fn patch_probe() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "rimdoc-patchprobe.exe"
    } else {
        "rimdoc-patchprobe"
    };

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let beside = dir.join(name);
            if beside.is_file() {
                return Some(beside);
            }
            // `cargo tauri dev` runs from target/debug, four levels under the repo root.
            let published = dir
                .ancestors()
                .nth(3)
                .map(|root| {
                    root.join("sidecar/PatchProbe/bin/Release/net10.0/win-x64/publish")
                        .join(name)
                })
                .filter(|path| path.is_file());
            if published.is_some() {
                return published;
            }
        }
    }
    None
}

/// The assemblies a mod actually loads, and only those.
///
/// RimWorld loads `<mod>/Assemblies` and `<mod>/<cycle>/Assemblies`. Nothing else, however
/// it is named.
///
/// This was a walk of everything under the mod with exclusions bolted on, and every pass
/// found another thing to exclude: folders for older game versions, then build output under
/// a shipped `Source` tree, then SimpleSidearms' own `v1.5` archive folders which look
/// nothing like `1.5`. Each one reported faults in code the game never runs. Naming the two
/// folders that load is a rule that cannot be surprised by a naming convention nobody
/// thought of.
///
/// A mod with a LoadFolders.xml can redirect this, which is rare and not read here. The
/// cost of missing one is a patch that goes unchecked, which the report already accounts
/// for; the cost of guessing wrongly was telling someone their mods were broken.
fn mod_assemblies(folders: &[String], cycle: &str) -> Vec<String> {
    let mut found = Vec::new();
    for folder in folders {
        let root = PathBuf::from(folder);
        for dir in [root.join("Assemblies"), root.join(cycle).join("Assemblies")] {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path
                    .extension()
                    .map(|e| e.eq_ignore_ascii_case("dll"))
                    .unwrap_or(false)
                {
                    found.push(path.display().to_string());
                }
            }
        }
    }
    found.sort();
    found.dedup();
    found
}

/// Ask the probe whether each mod's Harmony patches still have something to patch.
///
/// Takes several seconds over a large install, which is why it is asked for rather than run
/// on every scan. Nothing in any mod executes: the probe reads metadata and never loads an
/// assembly.
#[tauri::command(async)]
fn probe_patches(folders: Vec<String>, cycle: String) -> Result<ProbeReport, String> {
    let exe = patch_probe().ok_or(
        "The patch probe is not installed beside the app. Build it with `pnpm probe:build` \
         and stage it with `pnpm probe:stage`.",
    )?;

    let managed = scan::discover()
        .game
        .map(|dir| {
            PathBuf::from(dir)
                .join("RimWorldWin64_Data")
                .join("Managed")
                .display()
                .to_string()
        })
        .ok_or("No RimWorld install found to check against.")?;

    let assemblies = mod_assemblies(&folders, &cycle);
    if assemblies.is_empty() {
        return Err("None of these mods ship an assembly, so there is nothing to check.".into());
    }

    let request = serde_json::to_string(&ProbeRequest {
        managed,
        assemblies: &assemblies,
    })
    .map_err(|e| e.to_string())?;

    let mut child = console_command(&exe.to_string_lossy())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start the patch probe: {e}"))?;

    {
        use std::io::Write;
        let mut stdin = child.stdin.take().ok_or("The probe took no input.")?;
        stdin
            .write_all(request.as_bytes())
            .map_err(|e| format!("Could not send the request: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("The patch probe did not finish: {e}"))?;

    if !output.status.success() {
        // The probe writes prose to stderr and JSON to stdout, so a failure never arrives
        // as half a document.
        let why = String::from_utf8_lossy(&output.stderr);
        return Err(if why.trim().is_empty() {
            "The patch probe failed without saying why.".to_string()
        } else {
            format!("The patch probe failed: {}", why.trim())
        });
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Could not read the probe's report: {e}"))
}

/// The folder the companion mod is installed into, inside the game's own Mods directory.
///
/// A local mod rather than a Workshop one: it is installed by this app, versioned with this
/// app, and removed by this app. Putting it on the Workshop would make its version a separate
/// thing to keep in step with the game and with RimDoc+, for no gain to anyone.
const PROBE_MOD_FOLDER: &str = "RimDocProbe";

/// The package id the mod declares, which is what the load order refers to it by.
const PROBE_MOD_ID: &str = "w1ck3ds0d4.rimdocprobe";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeModState {
    installed: bool,
    /// Where it is, or would go.
    path: String,
    /// Whether the copy on disk matches the one this build of the app ships.
    current: bool,
    package_id: String,
}

fn probe_mod_source(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve("resources/probe-mod", BaseDirectory::Resource)
        .map_err(|e| format!("The companion mod is not bundled with this build: {e}"))
}

fn probe_mod_target(game_dir: &str) -> PathBuf {
    PathBuf::from(game_dir).join("Mods").join(PROBE_MOD_FOLDER)
}

/// Whether the installed copy is the one this build ships.
///
/// Compared byte for byte. Length was the obvious cheaper test and it is wrong: the first
/// rebuild after adding a dependency declaration to this mod produced a different assembly
/// of exactly the same size, so a length check would have reported it up to date. The file
/// is thirteen kilobytes and this runs when a panel opens.
fn same_bytes(a: &Path, b: &Path) -> bool {
    match (fs::read(a), fs::read(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

#[tauri::command(async)]
fn probe_mod_state(app: AppHandle, game_dir: String) -> Result<ProbeModState, String> {
    let target = probe_mod_target(&game_dir);
    let installed = target.join("About").join("About.xml").is_file();
    let current = installed
        && probe_mod_source(&app)
            .map(|source| {
                same_bytes(
                    &source.join("Assemblies").join("RimDocProbe.dll"),
                    &target.join("Assemblies").join("RimDocProbe.dll"),
                )
            })
            .unwrap_or(false);

    Ok(ProbeModState {
        installed,
        path: target.display().to_string(),
        current,
        package_id: PROBE_MOD_ID.to_string(),
    })
}

/// Put the companion mod into the game's Mods folder.
///
/// Copied whole and overwritten, because there is nothing of the player's in it: every file
/// there came from this app and a stale one is only ever this app's own older build.
#[tauri::command(async)]
fn install_probe_mod(app: AppHandle, game_dir: String) -> Result<String, String> {
    let source = probe_mod_source(&app)?;
    if !source.join("About").join("About.xml").is_file() {
        return Err(
            "The companion mod is not bundled with this build. Build it with \
             `pnpm probe-mod:build` and stage it with `pnpm probe-mod:stage`."
                .into(),
        );
    }

    let target = probe_mod_target(&game_dir);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| format!("Could not replace the old copy: {e}"))?;
    }
    files::copy_dir_all(&source, &target)?;
    Ok(target.display().to_string())
}

/// Take it out again.
///
/// Removed rather than disabled, so nothing of this app's is left in someone's install after
/// they have said they do not want it. The load order still names it until the player's
/// modpack is applied again, which is theirs to decide and not something to do behind them.
#[tauri::command(async)]
fn remove_probe_mod(game_dir: String) -> Result<String, String> {
    let target = probe_mod_target(&game_dir);
    if !target.exists() {
        return Ok("It was not installed".into());
    }
    fs::remove_dir_all(&target).map_err(|e| format!("Could not remove it: {e}"))?;
    Ok(format!("Removed {}", target.display()))
}

/// What the companion mod last wrote, if it is running.
///
/// Returned as text rather than parsed here, because reading it is analysis and the shell
/// does not do analysis. Null when the mod has never run, which is not an error: it is the
/// ordinary state of an install that has not been asked to measure anything.
#[tauri::command(async)]
fn read_probe_report() -> Result<Option<String>, String> {
    let Some(save_data) = scan::discover().save_data else {
        return Ok(None);
    };
    let path = PathBuf::from(save_data).join("RimDoc").join("probe.json");
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(_) => Ok(None),
    }
}

/// RimWorld's Steam app id. Subscribing needs Steam to believe it is talking to the game.
const RIMWORLD_APP_ID: &str = "294100";

/// Where the game keeps Valve's library.
///
/// The player's own copy, loaded from their install, rather than one shipped here. That
/// avoids redistributing Valve's binary entirely, and it means the version in use is always
/// the one the game itself was built against.
fn steam_api_dll(game_dir: &str) -> Option<PathBuf> {
    let plugins = PathBuf::from(game_dir)
        .join("RimWorldWin64_Data")
        .join("Plugins");
    // Named directly first, then looked for, because Unity has moved this between versions
    // and an install that puts it elsewhere should still work.
    let direct = plugins.join("x86_64").join("steam_api64.dll");
    if direct.is_file() {
        return Some(direct);
    }
    let mut stack = vec![plugins];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .file_name()
                .map(|n| n.eq_ignore_ascii_case("steam_api64.dll"))
                .unwrap_or(false)
            {
                return Some(path);
            }
        }
    }
    None
}

/// Ask Steam to subscribe to a Workshop item.
///
/// The one thing in this app that presents itself to Steam as RimWorld. Subscribing goes
/// through the Steamworks API, that API authenticates by app id, and there is no protocol
/// URL or web endpoint that will do it: `steam://` can open a Workshop page and nothing more.
/// So for as long as this call runs, Steam counts the app id as in use and will show the
/// player as playing RimWorld. That is disclosed where the button is, because it is visible
/// to their friends and nothing else this app does is.
///
/// Refused while the game is running. Two processes initialising the API under one app id is
/// not a thing this can test on every machine, and the cost of being wrong is someone's
/// session, so it does not try.
#[tauri::command(async)]
fn steam_subscribe(game_dir: String, workshop_id: String) -> Result<String, String> {
    if !workshop_id.chars().all(|c| c.is_ascii_digit()) || workshop_id.is_empty() {
        return Err("That is not a Workshop item id.".into());
    }
    let id: u64 = workshop_id
        .parse()
        .map_err(|_| "That Workshop item id is out of range.".to_string())?;

    if running_app_id().is_some() {
        return Err(
            "Steam is running a game. Subscribing has to talk to Steam as RimWorld, and doing \
             that alongside a running game is not something this will risk. Quit the game and \
             try again."
                .into(),
        );
    }
    if image_running("steam.exe") != Some(true) {
        return Err("Steam is not running. Start it, sign in, and try again.".into());
    }

    let dll = steam_api_dll(&game_dir).ok_or(
        "No steam_api64.dll in this RimWorld install, so there is nothing to ask. \
         Subscribe from the Workshop page instead.",
    )?;

    // Safety: the library is Valve's own, loaded from the player's game install, and every
    // symbol below is called with the signature Valve's flat API documents for it.
    unsafe {
        std::env::set_var("SteamAppId", RIMWORLD_APP_ID);
        std::env::set_var("SteamGameId", RIMWORLD_APP_ID);

        let lib = libloading::Library::new(&dll)
            .map_err(|e| format!("Could not load {}: {e}", dll.display()))?;

        let init: libloading::Symbol<unsafe extern "C" fn() -> bool> = lib
            .get(b"SteamAPI_Init\0")
            .map_err(|e| format!("That steam_api64.dll has no SteamAPI_Init: {e}"))?;
        if !init() {
            return Err(
                "Steam would not start a session. It has to be running and signed in, and it \
                 has to own RimWorld on this account."
                    .into(),
            );
        }

        let shutdown: libloading::Symbol<unsafe extern "C" fn()> = lib
            .get(b"SteamAPI_Shutdown\0")
            .map_err(|e| format!("That steam_api64.dll has no SteamAPI_Shutdown: {e}"))?;

        let outcome = subscribe_through(&lib, id);

        // Callbacks are pumped briefly so Steam has somewhere to deliver the result before
        // the session is torn down. Subscribing is asynchronous; this does not wait for the
        // download, only for Steam to have taken the request.
        if let Ok(run) = lib.get::<unsafe extern "C" fn()>(b"SteamAPI_RunCallbacks\0") {
            for _ in 0..20 {
                run();
                std::thread::sleep(Duration::from_millis(50));
            }
        }

        shutdown();
        outcome
    }
}

/// Find whichever ISteamUGC this copy of the library exposes, and subscribe through it.
///
/// The accessor is versioned into its own name, `SteamAPI_SteamUGC_v016` on the build this
/// was written against. Hardcoding that would work on one machine and fail on the next, so
/// the versions are tried in turn and the first that resolves is used. Newest first, because
/// a library that has several should be asked for its most recent.
unsafe fn subscribe_through(lib: &libloading::Library, id: u64) -> Result<String, String> {
    let mut ugc: *mut std::ffi::c_void = std::ptr::null_mut();
    let mut which = String::new();

    for version in (10..=30).rev() {
        let name = format!("SteamAPI_SteamUGC_v{version:03}\0");
        if let Ok(accessor) =
            lib.get::<unsafe extern "C" fn() -> *mut std::ffi::c_void>(name.as_bytes())
        {
            let found = accessor();
            if !found.is_null() {
                ugc = found;
                which = name.trim_end_matches('\0').to_string();
                break;
            }
        }
    }

    if ugc.is_null() {
        return Err(
            "This copy of steam_api64.dll exposes no Workshop interface this understands. \
             Subscribe from the Workshop page instead."
                .into(),
        );
    }

    let subscribe: libloading::Symbol<unsafe extern "C" fn(*mut std::ffi::c_void, u64) -> u64> =
        lib.get(b"SteamAPI_ISteamUGC_SubscribeItem\0")
            .map_err(|e| format!("No SubscribeItem in {which}: {e}"))?;

    subscribe(ugc, id);
    Ok(format!(
        "Asked Steam to subscribe to {id}. It downloads on its own; the mod appears once it has."
    ))
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
    let out = console_command("taskkill")
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

/// How many of those polls pass between memory readings.
///
/// Reading it costs a `tasklist` process, about 200ms, which at the log's own rate would eat
/// most of every cycle and spawn some fourteen thousand processes an hour across a session.
/// Peak working set does not move fast enough to be worth that: this is every five seconds,
/// and it is a peak rather than a series, so the only cost of looking less often is missing
/// a spike shorter than the interval.
const MEMORY_EVERY: u32 = 20;

/// Current working set of a process, in megabytes.
///
/// Read through tasklist rather than a Windows API binding: it is one poll every quarter
/// second against a process that is loading gigabytes of textures, so the cost of spawning
/// it is irrelevant next to what it is measuring.
fn memory_mb(pid: u32) -> Option<u64> {
    let out = console_command("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    memory_kb(&String::from_utf8_lossy(&out.stdout)).map(|kb| kb / 1024)
}

/// The kilobytes out of one CSV row of `tasklist`.
///
/// Split on the quoted separator, not on the comma. `tasklist` writes the memory field with
/// thousands separators inside the quotes, so splitting on `,` took the last group of a
/// three-group number: `"3,214,880 K"` read as 880 KB, and every run recorded 0 MB because
/// anything under a megabyte truncates to nothing. Only a process using less than 1000 KB
/// ever parsed correctly, which no game does.
fn memory_kb(text: &str) -> Option<u64> {
    // "name","pid","session","n","3,214,880 K". A line with no quoted field at all is
    // tasklist saying it matched nothing, and has no number in it worth reading.
    let row = text.lines().find(|l| l.starts_with('"'))?;
    let field = row.rsplit("\",\"").next()?.trim_end_matches('"').trim();
    let digits: String = field.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameExit {
    /// Highest working set seen while the run was watched.
    peak_memory_mb: u64,
    /// The process's exit code.
    ///
    /// Option because `ExitStatus::code` is, not because it is ever absent here: on Windows
    /// every process that ends has a code, including one that was killed. This used to say
    /// None meant terminated, and the branch reading it could not fire.
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
        let mut ticks: u32 = 0;

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

            ticks = ticks.wrapping_add(1);
            if ticks % MEMORY_EVERY == 0 {
                if let Some(mb) = memory_mb(pid) {
                    peak_memory_mb = peak_memory_mb.max(mb);
                }
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
            fetch_shared_log,
            probe_patches,
            probe_mod_state,
            install_probe_mod,
            remove_probe_mod,
            read_probe_report,
            is_steam_running,
            list_saves,
            launch_supervised,
            stop_game,
            vault_capture,
            vault_list,
            vault_restore,
            vault_forget,
            is_game_running,
            stop_steam,
            start_steam,
            steam_subscribe,
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
    fn a_shared_log_link_is_matched_on_the_whole_host() {
        assert_eq!(
            https_host("https://gist.github.com/x/abc"),
            Some("gist.github.com")
        );
        assert_eq!(
            https_host("https://gist.githubusercontent.com/x/abc/raw"),
            Some("gist.githubusercontent.com")
        );

        // Every one of these has a host that is not equal to an allowed one, which is the
        // whole reason the check is equality on the segment rather than a suffix test.
        for hostile in [
            "https://gist.github.com.example.com/x",
            "https://gist.github.com@example.com/x",
            "https://evil.gist.github.com.co/x",
            "https://gist.github.com:8443/x",
        ] {
            let host = https_host(hostile).expect("a host");
            assert!(
                !LOG_HOSTS.contains(&host),
                "{hostile} resolved to {host}, which was allowed"
            );
        }

        // Not https at all, so there is nothing to check against.
        assert_eq!(https_host("http://gist.github.com/x"), None);
        assert_eq!(https_host("file:///etc/passwd"), None);
        assert_eq!(https_host("https://"), None);
    }

    #[test]
    fn a_gist_page_link_becomes_the_raw_one() {
        assert_eq!(
            raw_gist_url("https://gist.github.com/HugsLibRecordKeeper/abc123"),
            "https://gist.github.com/HugsLibRecordKeeper/abc123/raw"
        );
        // Already raw, or already the content host: left as it is rather than doubled up.
        assert_eq!(
            raw_gist_url("https://gist.github.com/x/abc/raw"),
            "https://gist.github.com/x/abc/raw"
        );
        assert_eq!(
            raw_gist_url("https://gist.githubusercontent.com/x/abc/raw/f/Player.log"),
            "https://gist.githubusercontent.com/x/abc/raw/f/Player.log"
        );
        // A trailing slash is a link someone copied out of a browser bar.
        assert_eq!(
            raw_gist_url("https://gist.github.com/x/abc/"),
            "https://gist.github.com/x/abc/raw"
        );
    }

    #[test]
    fn only_the_assemblies_the_game_would_load_are_read() {
        let tmp = tempdir().unwrap();
        let m = tmp.path().join("mod");
        // The two the game loads.
        write(&m.join("Assemblies/Live.dll"), "");
        write(&m.join("1.6/Assemblies/Also.dll"), "");
        // A folder for an older game version.
        write(&m.join("1.4/Assemblies/Old.dll"), "");
        // SimpleSidearms' own archive convention, which is not a RimWorld version folder.
        write(&m.join("v1.5/Assemblies/Archived.dll"), "");
        // Build output inside a shipped source tree.
        write(&m.join("Source/Thing/obj/Debug/Build.dll"), "");
        // A DLL loose in the mod root, which the game does not load either.
        write(&m.join("Loose.dll"), "");

        let found = mod_assemblies(&[m.display().to_string()], "1.6");
        let names: Vec<String> = found
            .iter()
            .map(|p| {
                Path::new(p)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();

        assert_eq!(names, vec!["Also.dll", "Live.dll"]);
    }

    #[test]
    fn steam_paths_survive_the_spaces_in_them() {
        // Exactly what `reg query` printed here: lower case, forward slashes, and a space
        // in "program files (x86)" that a whitespace split would break the path on.
        let output = "\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamExe    REG_SZ    c:/program files (x86)/steam/steam.exe\r\n\r\n";
        assert_eq!(
            parse_reg_sz(output).as_deref(),
            Some("c:/program files (x86)/steam/steam.exe")
        );
        assert_eq!(parse_reg_sz("ERROR: The system was unable to find"), None);
    }

    #[test]
    fn a_running_game_is_read_out_of_steams_own_record() {
        let none = "\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    RunningAppID    REG_DWORD    0x0\r\n\r\n";
        let rimworld = "    RunningAppID    REG_DWORD    0x47cd4\r\n";
        assert_eq!(parse_reg_dword(none), Some(0));
        assert_eq!(parse_reg_dword(rimworld), Some(294_100));
        assert_eq!(parse_reg_dword("nothing here"), None);
    }

    #[test]
    fn steam_is_found_above_its_own_workshop_folder() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let content = root.join("steamapps/workshop/content/294100");
        fs::create_dir_all(&content).expect("layout");
        // No steam.exe yet: a library folder on a second drive has this exact shape and no
        // client anywhere above it, and inventing one there would be a wrong answer.
        assert_eq!(steam_exe_above(&content.to_string_lossy()), None);

        write(&root.join("steam.exe"), "");
        assert_eq!(
            steam_exe_above(&content.to_string_lossy()),
            Some(root.join("steam.exe"))
        );
    }

    #[test]
    fn a_refused_manifest_edit_cancels_its_own_folder_delete() {
        let refused = vec!["2917566333".to_string()];
        // The item that could not be forgotten: its folder has to survive.
        assert!(paired_with_refused(
            "C:/Steam/steamapps/workshop/content/294100/2917566333",
            &refused
        ));
        // A different item in the same run is unaffected: one refusal must not abandon the rest.
        assert!(!paired_with_refused(
            "C:/Steam/steamapps/workshop/content/294100/818773962",
            &refused
        ));
        // A local mod folder is not named for a workshop id and cannot be paired with one.
        assert!(!paired_with_refused("C:/RimWorld/Mods/MyMod", &refused));
        assert!(!paired_with_refused(
            "C:/Steam/steamapps/workshop/content/294100/2917566333",
            &[]
        ));
    }

    #[test]
    fn forgetting_an_unknown_item_is_not_a_failure() {
        let tmp = tempdir().unwrap();
        let acf = tmp.path().join("appworkshop_294100.acf");
        fs::write(&acf, "\"WorkshopItemsInstalled\"\n\t{\n\t}").unwrap();
        assert!(forget_workshop_item(&acf, "999")
            .unwrap()
            .contains("not recorded"));
    }

    /// A write that created the file is undone by removing it.
    ///
    /// backup_once has nothing to copy when the file is not there, and used to say so and
    /// stop. Rollback then found no backup, called the target "no backup", and left the file
    /// where it was, while the run still told the reader every change could be put back. A
    /// repair that only creates files, which the stub-def repair is, was unrollbackable.
    #[test]
    fn rolling_back_a_created_file_takes_it_away() {
        let tmp = tempdir().unwrap();
        let made = tmp.path().join("generated").join("Stub.xml");

        backup_once(&made).unwrap();
        fs::create_dir_all(made.parent().unwrap()).unwrap();
        fs::write(&made, "<Defs/>").unwrap();
        assert!(made.exists());

        let report = rollback(vec![made.display().to_string()]).unwrap();

        assert_eq!(report.applied, 1);
        assert_eq!(report.failed, 0);
        assert!(!made.exists(), "the file should be gone");
        assert!(!PathBuf::from(format!("{}.rimdocbak.absent", made.display())).exists());
    }

    /// A file that was already there is restored rather than removed.
    #[test]
    fn rolling_back_an_edited_file_puts_the_old_one_back() {
        let tmp = tempdir().unwrap();
        let existing = tmp.path().join("Config.xml");
        fs::write(&existing, "before").unwrap();

        backup_once(&existing).unwrap();
        fs::write(&existing, "after").unwrap();

        rollback(vec![existing.display().to_string()]).unwrap();

        assert_eq!(fs::read_to_string(&existing).unwrap(), "before");
    }

    /// No path this app builds walks back up through a parent, and one that does was built
    /// from something a scan read rather than found.
    #[test]
    fn a_climbing_path_is_recognised() {
        assert!(climbs(&PathBuf::from(
            "C:/game/Mods/Stubs/Defs/../../../../evil.xml"
        )));
        assert!(climbs(&PathBuf::from("../evil.xml")));
        assert!(!climbs(&PathBuf::from(
            "C:/game/Mods/Stubs/Defs/SoundDef_Fine.xml"
        )));
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

    /// The parse that made every recorded run report 0 MB.
    ///
    /// tasklist puts thousands separators inside the quoted memory field, so splitting the
    /// row on `,` returned the last group of the number rather than the number.
    #[test]
    fn memory_reads_the_whole_number_not_its_last_group() {
        assert_eq!(
            memory_kb(r#""RimWorldWin64.exe","76652","Console","1","3,214,880 K""#),
            Some(3_214_880)
        );
        assert_eq!(
            memory_kb(r#""RimWorldWin64.exe","76652","Console","1","60 K""#),
            Some(60)
        );
    }

    /// tasklist matching nothing prints a sentence, not a row. There is no number in it.
    #[test]
    fn memory_of_a_process_that_is_gone_is_unknown_not_zero() {
        assert_eq!(
            memory_kb("INFO: No tasks are running which match the specified criteria."),
            None
        );
        assert_eq!(memory_kb(""), None);
    }
}

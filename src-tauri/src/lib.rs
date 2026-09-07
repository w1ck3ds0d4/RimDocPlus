mod scan;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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
#[tauri::command(async)]
fn scan_install() -> Result<scan::ScanResult, String> {
    scan::scan_install(None)
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

/// Start RimWorld.
///
/// Spawned detached rather than waited on: the point is to hand the player their game,
/// and supervising the process is the next slice rather than this one.
#[tauri::command]
fn launch_game(game_dir: String) -> Result<String, String> {
    let exe = ["RimWorldWin64.exe", "RimWorld.exe", "RimWorldWin.exe"]
        .iter()
        .map(|name| Path::new(&game_dir).join(name))
        .find(|candidate| candidate.exists())
        .ok_or_else(|| format!("No RimWorld executable in {game_dir}"))?;

    Command::new(&exe)
        .current_dir(&game_dir)
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", exe.display()))?;

    Ok(exe.display().to_string())
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
            scan_install
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

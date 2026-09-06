use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

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
fn save_original(config_dir: Option<&str>) -> Result<PathBuf, String> {
    let root = backups_root()?;
    let original = root.join("original-version");
    if original.exists() {
        return Ok(original);
    }
    fs::create_dir_all(&original).map_err(|e| e.to_string())?;
    if let Some(config) = config_dir {
        let source = Path::new(config);
        if source.exists() {
            copy_dir(source, &original.join("Config"))?;
        }
    }
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
    Ok(format!("{}x{} to {}x{}", w, h, resized.width(), resized.height()))
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
#[tauri::command]
fn run_file_actions(actions: Vec<FileAction>, config_dir: Option<String>) -> Result<RunReport, String> {
    let backup_dir = save_original(config_dir.as_deref())?;
    let mut outcomes = Vec::new();
    let (mut applied, mut failed, mut skipped) = (0, 0, 0);

    for action in actions {
        let (target, result) = match &action {
            FileAction::AddSupportedVersion { path, cycle } => {
                let p = PathBuf::from(path);
                (path.clone(), backup_once(&p).and_then(|_| add_supported_version(&p, cycle)))
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
                (path.clone(), backup_once(&p).and_then(|_| downscale(&p, *max_px)))
            }
            FileAction::DeleteMatching { directory, pattern } => {
                (directory.clone(), delete_matching(Path::new(directory), pattern))
            }
        };

        match result {
            Ok(detail) => {
                if detail.starts_with("already") || detail == "nothing there" {
                    skipped += 1;
                } else {
                    applied += 1;
                }
                outcomes.push(ActionOutcome { target, ok: true, detail });
            }
            Err(detail) => {
                failed += 1;
                outcomes.push(ActionOutcome { target, ok: false, detail });
            }
        }
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
#[tauri::command]
fn rollback(targets: Vec<String>) -> Result<RunReport, String> {
    let mut outcomes = Vec::new();
    let (mut applied, mut failed, mut skipped) = (0, 0, 0);

    for target in targets {
        let path = PathBuf::from(&target);
        let bak = PathBuf::from(format!("{target}.rimdocbak"));
        if !bak.exists() {
            skipped += 1;
            outcomes.push(ActionOutcome { target, ok: true, detail: "no backup".into() });
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
                outcomes.push(ActionOutcome { target, ok: true, detail: "restored".into() });
            }
            Err(detail) => {
                failed += 1;
                outcomes.push(ActionOutcome { target, ok: false, detail });
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
            launch_game
        ])
        .run(tauri::generate_context!())
        .expect("error while running RimDoc+");
}

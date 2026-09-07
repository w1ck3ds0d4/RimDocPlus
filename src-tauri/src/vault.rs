//! A content-addressed store of mod folders.
//!
//! Steam updates a Workshop mod by overwriting it in place, so the version that worked is
//! simply gone. The vault keeps a copy addressed by what is in it, which means a modpack can
//! record not only which mods it used but which builds of them, and an update that breaks
//! something can be undone rather than only regretted.
//!
//! Addressed by content and not by a version string, because a mod's About.xml version is
//! whatever the author last remembered to change and frequently does not move between
//! releases. What is on disk is the only description of a build that cannot be wrong.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub package_id: String,
    pub name: String,
    /// First 16 hex characters of the folder's content hash.
    pub hash: String,
    pub size_bytes: u64,
    pub files: usize,
    /// When this build was taken into the vault, ISO 8601.
    pub captured_at: String,
    /// Where the copy lives.
    pub path: String,
}

fn vault_root() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "No home directory to keep a vault in".to_string())?;
    Ok(PathBuf::from(home).join("RimDoc-Vault"))
}

/// Files that say nothing about the mod, and would otherwise change its identity.
///
/// `.rimdocbak` is this app's own backup, and a Workshop folder carries Steam's bookkeeping.
/// Including either would give the same build two different hashes depending on what had
/// happened to it since, which is the one thing a content address must not do.
fn is_ignored(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".rimdocbak") || lower == "publishedfileid.txt"
}

/// Every file under a folder, relative to it, sorted.
///
/// Sorted because directory order is whatever the filesystem feels like and must not change
/// the hash, and relative because the absolute path differs between installs while the mod
/// does not.
fn walk(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_ignored(&name) {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(relative) = path.strip_prefix(dir) {
                found.push((relative.to_string_lossy().replace('\\', "/"), path));
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

/// What is actually in a mod folder, as one hash.
///
/// Contents, not metadata. Sizes and modification times are cheaper to read but both change
/// for reasons that have nothing to do with the mod: a copy moves every mtime, and two builds
/// can differ by a byte at the same length. A build that behaves differently must hash
/// differently, and only the bytes guarantee that.
pub fn hash_folder(dir: &Path) -> Result<(String, u64, usize), String> {
    let files = walk(dir);
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = vec![0u8; 64 * 1024];

    for (relative, path) in &files {
        // The path goes in as well as the content: moving a file without editing it still
        // makes a different mod.
        hasher.update(relative.as_bytes());
        hasher.update([0u8]);

        let mut file = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        loop {
            let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            total += read as u64;
        }
    }

    let digest = hasher.finalize();
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Ok((hex, total, files.len()))
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_ignored(&name) {
            continue;
        }
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Take a build into the vault, or recognise that it is already there.
///
/// Keyed by hash, so vaulting the same build twice costs one walk and no copy. That is what
/// makes it safe to offer over a whole modpack: only what has actually changed is written.
pub fn capture(
    folder: &Path,
    package_id: &str,
    name: &str,
    now: String,
) -> Result<VaultEntry, String> {
    if !folder.exists() {
        return Err(format!("{} is not on disk", folder.display()));
    }
    let (hash, size_bytes, files) = hash_folder(folder)?;
    let destination = vault_root()?.join(package_id).join(&hash);
    let manifest = destination.join("entry.json");

    if manifest.exists() {
        let text = fs::read_to_string(&manifest).map_err(|e| e.to_string())?;
        return serde_json::from_str(&text).map_err(|e| e.to_string());
    }

    let payload = destination.join("mod");
    copy_dir(folder, &payload)?;

    let entry = VaultEntry {
        package_id: package_id.to_string(),
        name: name.to_string(),
        hash,
        size_bytes,
        files,
        captured_at: now,
        path: payload.display().to_string(),
    };
    fs::write(
        &manifest,
        serde_json::to_string_pretty(&entry).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(entry)
}

/// Everything the vault holds, newest first.
pub fn list() -> Result<Vec<VaultEntry>, String> {
    let root = vault_root()?;
    let Ok(mods) = fs::read_dir(&root) else {
        return Ok(Vec::new());
    };

    let mut entries = Vec::new();
    for package in mods.flatten() {
        let Ok(builds) = fs::read_dir(package.path()) else {
            continue;
        };
        for build in builds.flatten() {
            let manifest = build.path().join("entry.json");
            // A half-written capture leaves a folder with no manifest. Skipped rather than
            // reported: it describes nothing, and the next capture will replace it.
            if let Ok(text) = fs::read_to_string(&manifest) {
                if let Ok(entry) = serde_json::from_str::<VaultEntry>(&text) {
                    entries.push(entry);
                }
            }
        }
    }
    entries.sort_by(|a, b| b.captured_at.cmp(&a.captured_at));
    Ok(entries)
}

/// Put a vaulted build back where the mod lives.
///
/// The folder being replaced is backed up beside itself first, exactly as a repair would,
/// so restoring the wrong build is as undoable as anything else this app does.
pub fn restore(package_id: &str, hash: &str, target: &Path) -> Result<String, String> {
    let payload = vault_root()?.join(package_id).join(hash).join("mod");
    if !payload.exists() {
        return Err(format!("{package_id} at {hash} is not in the vault"));
    }

    if target.exists() {
        let backup = PathBuf::from(format!("{}.rimdocbak", target.display()));
        if !backup.exists() {
            copy_dir(target, &backup)?;
        }
        fs::remove_dir_all(target).map_err(|e| e.to_string())?;
    }
    copy_dir(&payload, target)?;
    Ok(format!("Restored {package_id} at {hash}"))
}

/// Remove one build from the vault permanently.
pub fn forget(package_id: &str, hash: &str) -> Result<String, String> {
    let build = vault_root()?.join(package_id).join(hash);
    if !build.exists() {
        return Ok(format!("{package_id} at {hash} was not in the vault"));
    }
    fs::remove_dir_all(&build).map_err(|e| e.to_string())?;
    Ok(format!("Removed {package_id} at {hash}"))
}

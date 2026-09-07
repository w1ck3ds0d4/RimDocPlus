//! Filesystem work the rest of the shell shares.
//!
//! Both of these existed three times over with small differences between the copies, and in
//! one case the difference was a bug rather than a decision.

use std::fs;
use std::path::{Path, PathBuf};

/// The user's home directory, or None when there is not one to speak of.
///
/// Filtered for emptiness, not only for absence. An environment where `USERPROFILE` is set
/// to nothing gives `PathBuf::from("")`, and joining onto that yields a relative path, so
/// the vault and the backups would have been written into whatever directory the app
/// happened to be launched from. Absent and empty mean the same thing here and both have to
/// be refused.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// The same, with a message naming what it was wanted for.
pub fn home_dir_for(purpose: &str) -> Result<PathBuf, String> {
    home_dir().ok_or_else(|| format!("No home directory to {purpose}"))
}

/// Copy a directory and everything under it, leaving out whatever the caller says to.
///
/// The filter is the reason this is one function rather than two. A backup has to be
/// byte-complete, or restoring from it would quietly drop files. A vault capture must leave
/// out this app's own backups and Steam's bookkeeping, or the same build would hash
/// differently depending on what had happened to it since, which is the one thing a content
/// address must never do. Same walk, two ideas of what belongs in it.
///
/// The entry's own file type decides directory or file, rather than asking the filesystem
/// again through `is_dir`. `read_dir` already knows, and a mod folder is thousands of
/// entries deep.
pub fn copy_dir(from: &Path, to: &Path, skip: &dyn Fn(&str) -> bool) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if skip(&name.to_string_lossy()) {
            continue;
        }
        let source = entry.path();
        let target = to.join(&name);
        let is_dir = match entry.file_type() {
            Ok(kind) => kind.is_dir(),
            // A symlink whose target has gone answers neither. Asking the path directly is
            // the slower answer but it is still an answer.
            Err(_) => source.is_dir(),
        };
        if is_dir {
            copy_dir(&source, &target, skip)?;
        } else {
            fs::copy(&source, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Copy a directory whole, keeping every last file. What a backup needs.
pub fn copy_dir_all(from: &Path, to: &Path) -> Result<(), String> {
    copy_dir(from, to, &|_| false)
}

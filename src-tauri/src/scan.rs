//! Reads a live RimWorld install and produces the same [`ScanResult`] shape the Node
//! reference scanner (`scripts/scan.mjs`) writes to `src/dev-data/scan.json`.
//!
//! Node stays the reference implementation for exercising the parsing and rule layers
//! without building the desktop shell; this module is the second reader of the same
//! install, running inside the shipped app instead of against a checked-in fixture. The
//! two must agree field for field, because the TypeScript analysis layer consumes
//! whichever one produced the JSON without knowing which it was.
//!
//! Every quirk below has a one-line reason attached because each one was a real bug
//! found against a real 253-mod install; see `docs/HOW-IT-WORKS.md` section 1 for the
//! fuller account.
//!
//! XML here is read the same tolerant way scan.mjs reads it: substring and manual
//! scanning rather than a parser, so a malformed Workshop `About.xml` (stray ampersand, a
//! BOM mid-file, an unclosed tag) yields a partial read instead of losing the mod
//! outright. No XML or regex crate is used, on purpose.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------------
// Output types. Field names are camelCase to match src/lib/types.ts exactly; Option
// fields that scan.mjs can leave `undefined` skip serialisation instead of writing null,
// which is how JSON.stringify treats an undefined property.
// ---------------------------------------------------------------------------------

/// Where a mod's files came from. Drives update behaviour and vault provenance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModSource {
    Official,
    Steam,
    Local,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModDependency {
    pub package_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// One texture large enough to be worth naming.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OversizedTexture {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureStats {
    pub count: u32,
    /// Sum of width x height x 4 across every texture read. Computed from dimensions,
    /// never file size: Unity uploads textures decoded, so on-disk PNG compression buys
    /// nothing at runtime.
    pub estimated_vram_bytes: u64,
    /// Textures above the downscale target, largest first, capped at MAX_OVERSIZED.
    pub oversized: Vec<OversizedTexture>,
    /// True when the walk hit its directory-entry budget, so the numbers are a floor.
    pub truncated: bool,
}

/// One xpath-targeting operation from a mod's Patches folder.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchOperation {
    /// PatchOperationReplace, PatchOperationAdd, a mod-defined class, or "unknown".
    pub op: String,
    /// Normalised xpath the operation targets.
    pub xpath: String,
    /// Patch file, relative to the mod folder, forward-slashed.
    pub file: String,
}

/// One mod as it exists on disk, independent of whether it is enabled.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModEntry {
    pub package_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Absolute folder path the mod was read from.
    pub folder: String,
    pub source: ModSource,
    /// Workshop file id, when the mod came from Steam.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steam_id: Option<String>,
    pub supported_versions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_path: Option<String>,
    pub dependencies: Vec<ModDependency>,
    pub incompatible_with: Vec<String>,
    pub load_after: Vec<String>,
    pub load_before: Vec<String>,
    pub has_assemblies: bool,
    pub has_patches: bool,
    pub size_bytes: u64,
    /// The scan always reads textures and patches in the same pass, so unlike the
    /// TypeScript type (which leaves room for a producer that skips them) this
    /// implementation always populates both.
    pub textures: TextureStats,
    pub patches: Vec<PatchOperation>,
    /// Set from ModsConfig.xml, not from the mod folder.
    pub active: bool,
    pub load_index: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPaths {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workshop: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_mods: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub save_data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_log: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub scanned_at: String,
    /// Version string from ModsConfig.xml, e.g. "1.6.4871 rev590".
    pub game_version: String,
    /// Major.minor only, e.g. "1.6". This is what About.xml files match against.
    pub game_cycle: String,
    pub paths: ScanPaths,
    pub mods: Vec<ModEntry>,
    /// packageIds in ModsConfig load order, lowercased. May include ids with no folder.
    pub active_order: Vec<String>,
}

// ---------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------

/// Steam library locations scan.mjs checks. Not read from `libraryfolders.vdf`: the
/// reference scanner hardcodes the common drive letters instead, so this matches it
/// rather than doing more than the spec does.
const GAME_CANDIDATES: &[&[&str]] = &[
    &["C:/Program Files (x86)/Steam/steamapps/common/RimWorld"],
    &["C:/Program Files/Steam/steamapps/common/RimWorld"],
    &["D:/SteamLibrary/steamapps/common/RimWorld"],
    &["E:/SteamLibrary/steamapps/common/RimWorld"],
];

/// Join path segments one at a time so the result uses the platform's own separator
/// throughout, rather than embedding a literal "/" that `Path::join` would otherwise
/// carry through unchanged inside an appended component.
fn join_all(base: &Path, parts: &[&str]) -> PathBuf {
    parts
        .iter()
        .fold(base.to_path_buf(), |acc, part| acc.join(part))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// Collapse `..` components lexically, without touching the filesystem. `Path::join`
/// does not do this, so `game/../../workshop/...` would otherwise carry its `..`
/// segments straight into the path this app stores and displays.
fn normalize_path(path: &Path) -> PathBuf {
    let mut stack: Vec<Component> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(stack.last(), Some(Component::Normal(_))) {
                    stack.pop();
                } else {
                    stack.push(component);
                }
            }
            other => stack.push(other),
        }
    }
    let mut result = PathBuf::new();
    for component in stack {
        result.push(component.as_os_str());
    }
    result
}

fn first_existing(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|p| p.exists())
}

/// Probe the same fixed candidate locations `scripts/scan.mjs` does: the game folder
/// across the common Steam library drives, the Workshop content folder that sits beside
/// `steamapps/common` rather than inside the game folder, local `Mods`, the save-data
/// `Config` folder, and `Player.log`.
pub fn discover() -> ScanPaths {
    let home = home_dir();

    let mut game_candidates: Vec<PathBuf> = GAME_CANDIDATES
        .iter()
        .map(|segs| PathBuf::from(segs[0]))
        .collect();
    if let Some(home) = &home {
        game_candidates.push(join_all(
            home,
            &[".steam", "steam", "steamapps", "common", "RimWorld"],
        ));
    }
    let game = first_existing(game_candidates);

    let save_candidates: Vec<PathBuf> = match &home {
        Some(home) => vec![
            join_all(
                home,
                &[
                    "AppData",
                    "LocalLow",
                    "Ludeon Studios",
                    "RimWorld by Ludeon Studios",
                ],
            ),
            join_all(home, &["Library", "Application Support", "RimWorld"]),
            join_all(
                home,
                &[
                    ".config",
                    "unity3d",
                    "Ludeon Studios",
                    "RimWorld by Ludeon Studios",
                ],
            ),
        ],
        None => Vec::new(),
    };
    let save_data = first_existing(save_candidates);

    // The workshop content folder sits beside `common`, not inside the game folder.
    let workshop = game.as_ref().and_then(|g| {
        let candidate =
            normalize_path(&join_all(g, &["..", "..", "workshop", "content", "294100"]));
        candidate.exists().then_some(candidate)
    });
    let local_mods = game.as_ref().and_then(|g| {
        let candidate = g.join("Mods");
        candidate.exists().then_some(candidate)
    });
    let player_log = save_data.as_ref().and_then(|s| {
        let candidate = s.join("Player.log");
        candidate.exists().then_some(candidate)
    });

    ScanPaths {
        // Normalised so every path uses one separator style throughout: the game
        // candidates above are written with '/' for readability, and joining a native
        // `Mods` or `Player.log` segment onto one would otherwise mix '/' and '\' in a
        // single displayed path on Windows.
        game: game.map(|p| normalize_path(&p).display().to_string()),
        workshop: workshop.map(|p| p.display().to_string()),
        local_mods: local_mods.map(|p| normalize_path(&p).display().to_string()),
        save_data: save_data.map(|p| normalize_path(&p).display().to_string()),
        player_log: player_log.map(|p| normalize_path(&p).display().to_string()),
    }
}

// ---------------------------------------------------------------------------------
// The scan itself
// ---------------------------------------------------------------------------------

/// Textures at or above this in either dimension are worth naming individually.
/// Textures above this are recorded individually.
/// The downscale target, not the oversize threshold: anything at or below the target cannot
/// be made smaller, and anything above it might be worth resizing. Which of them actually
/// count is a setting the player owns, applied when the rules run, so moving that setting
/// re-decides the answer without another walk of the disk.
const RECORD_ABOVE_PX: u32 = 512;
/// Named textures kept per mod.
///
/// This list is what the downscale repair works from, so the cap bounds how much of the
/// problem one pass can fix rather than only how much is shown. The heaviest mod on the
/// reference install carries 359 above the target, so 400 clears it while still bounding a
/// pathological one.
const MAX_OVERSIZED: usize = 400;
/// Directory entries walked per mod for the size/texture pass. A mod that hits this is
/// marked truncated rather than silently reported smaller than it is.
const SIZE_WALK_BUDGET: usize = 6000;

/// The suffix a repair leaves beside anything it changes.
const BACKUP_SUFFIX: &str = ".rimdocbak";

/// Whether a directory entry is RimDoc+'s own backup rather than part of the install.
///
/// A repair writes its backups beside their originals, which puts them inside the very tree
/// the next scan walks. Left alone, removing a duplicate mod folder leaves
/// `<id>.rimdocbak` behind carrying the same packageId, so the rescan reports the duplicate
/// the repair just resolved. Backed-up files also inflate a mod's size on disk, which made
/// a texture pass look like it had made the install larger.
fn is_backup(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy()
        .to_lowercase()
        .ends_with(BACKUP_SUFFIX)
}
/// Patch files read per mod.
const MAX_PATCH_FILES: usize = 400;
/// Operations stored per mod. Past this a mod is patching too much to list usefully.
const MAX_PATCH_OPS: usize = 1500;

/// Run the scan against either the auto-detected install or a caller-supplied override.
///
/// `paths_override` overrides individual fields rather than replacing the whole
/// discovery result: a caller that only knows the game folder (e.g. from a file-picker)
/// can supply just that and still get the workshop/local/save-data paths this would have
/// found on its own.
/// One folder read, for a caller that wants to show the walk happening.
pub struct ScanProgress<'a> {
    pub done: usize,
    pub total: usize,
    pub label: &'a str,
}

pub fn scan_install(paths_override: Option<ScanPaths>) -> Result<ScanResult, String> {
    scan_install_with(paths_override, &mut |_| {})
}

/// The scan, reporting each mod folder as it finishes with it.
///
/// A 252-mod install takes about four seconds, which is a long time for a window to sit
/// blank. The callback keeps that reporting in the caller's hands rather than making this
/// file know anything about how the app talks to its own UI.
pub fn scan_install_with(
    paths_override: Option<ScanPaths>,
    progress: &mut dyn FnMut(ScanProgress),
) -> Result<ScanResult, String> {
    let discovered = discover();
    let paths = match paths_override {
        Some(o) => ScanPaths {
            game: o.game.or(discovered.game),
            workshop: o.workshop.or(discovered.workshop),
            local_mods: o.local_mods.or(discovered.local_mods),
            save_data: o.save_data.or(discovered.save_data),
            player_log: o.player_log.or(discovered.player_log),
        },
        None => discovered,
    };

    let game = paths.game.clone().ok_or_else(|| {
        let checked: Vec<&str> = GAME_CANDIDATES.iter().map(|segs| segs[0]).collect();
        format!(
            "No RimWorld install found. Checked:\n  {}",
            checked.join("\n  ")
        )
    })?;

    let save_data = paths
        .save_data
        .clone()
        .ok_or_else(|| "No RimWorld save-data folder found".to_string())?;
    let mods_config_path = Path::new(&save_data).join("Config").join("ModsConfig.xml");
    if !mods_config_path.exists() {
        return Err(format!("No ModsConfig.xml under {save_data}"));
    }
    let mods_config_bytes = fs::read(&mods_config_path).map_err(|e| e.to_string())?;
    let mods_config_xml = String::from_utf8_lossy(&mods_config_bytes).into_owned();

    let (game_version, active_order) = parse_mods_config(&mods_config_xml);
    let game_cycle = game_cycle_of(&game_version);

    let data_dir = Path::new(&game).join("Data");
    let total = count_candidates(&data_dir)
        + paths
            .local_mods
            .as_ref()
            .map_or(0, |p| count_candidates(Path::new(p)))
        + paths
            .workshop
            .as_ref()
            .map_or(0, |p| count_candidates(Path::new(p)));

    let mut done = 0usize;
    let mut report = |label: &str| {
        done += 1;
        progress(ScanProgress {
            done: done.min(total),
            total,
            label,
        });
    };

    let mut mods = Vec::new();
    mods.extend(scan_mod_dir(&data_dir, ModSource::Official, &mut report));
    if let Some(local) = &paths.local_mods {
        mods.extend(scan_mod_dir(
            Path::new(local),
            ModSource::Local,
            &mut report,
        ));
    }
    if let Some(workshop) = &paths.workshop {
        mods.extend(scan_mod_dir(
            Path::new(workshop),
            ModSource::Steam,
            &mut report,
        ));
    }

    let position: HashMap<&str, usize> = active_order
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    for m in mods.iter_mut() {
        match position.get(m.package_id.as_str()) {
            Some(&idx) => {
                m.active = true;
                m.load_index = Some(idx as i64);
            }
            None => {
                m.active = false;
                m.load_index = None;
            }
        }
    }

    Ok(ScanResult {
        scanned_at: iso8601(SystemTime::now()).unwrap_or_default(),
        game_version,
        game_cycle,
        paths,
        mods,
        active_order,
    })
}

/// Walk one mod root (`Data`, local `Mods`, or the Workshop content folder) and build a
/// `ModEntry` for every subfolder that has a readable About.xml.
/// How many folders in a root could hold a mod.
///
/// A shallow count, so it costs one readdir per root rather than a second full walk. It can
/// exceed the mods actually returned, since a folder without an About.xml is skipped later,
/// which is why the bar is clamped rather than trusted to land exactly on its total.
fn count_candidates(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| {
            !is_backup(&e.file_name()) && e.file_type().map(|t| t.is_dir()).unwrap_or(false)
        })
        .count()
}

fn scan_mod_dir(dir: &Path, source: ModSource, progress: &mut dyn FnMut(&str)) -> Vec<ModEntry> {
    let mut mods = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return mods,
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        if is_backup(&entry.file_name()) {
            continue;
        }
        let folder = entry.path();
        let xml = match read_about(&folder) {
            Some(xml) => xml,
            None => continue,
        };
        let measured = measure_mod(&folder, SIZE_WALK_BUDGET);
        let steam_id = matches!(source, ModSource::Steam)
            .then(|| entry.file_name().to_string_lossy().into_owned());

        let input = AboutInput {
            xml,
            folder: folder.display().to_string(),
            source,
            steam_id,
            has_assemblies: has_subdir(&folder, "Assemblies"),
            has_patches: has_subdir(&folder, "Patches"),
            size_bytes: measured.size_bytes,
            updated_at: folder_mtime(&folder),
        };

        if let Some(mut mod_entry) = parse_about(input) {
            mod_entry.textures = measured.textures;
            mod_entry.patches = read_patches(&folder);
            mod_entry.preview_path = find_preview(&folder);
            progress(&mod_entry.name);
            mods.push(mod_entry);
        } else {
            // Still counted: the bar tracks folders looked at, not mods kept, or it would
            // stall on every folder that turns out not to hold a mod.
            progress(&entry.file_name().to_string_lossy());
        }
    }
    mods
}

/// RimWorld looks for `About/About.xml` case-insensitively, and some Workshop mods ship
/// it uppercased or mixed-case.
fn read_about(folder: &Path) -> Option<String> {
    for candidate in ["About/About.xml", "about/about.xml", "About/about.xml"] {
        let path = folder.join(candidate);
        if path.exists() {
            // A path that exists but fails to read is not retried against the other
            // casings, matching the reference scanner: an unreadable file means the mod
            // is skipped, not that another spelling is guessed at.
            return fs::read(&path)
                .ok()
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    None
}

struct MeasuredMod {
    size_bytes: u64,
    textures: TextureStats,
}

/// One pass over a mod folder producing both its on-disk size and its texture footprint.
/// Walking twice would double the IO on a 253-mod install for no extra information.
fn measure_mod(dir: &Path, budget: usize) -> MeasuredMod {
    let mut total: u64 = 0;
    let mut seen: usize = 0;
    let mut count: u32 = 0;
    let mut vram: u64 = 0;
    let mut oversized: Vec<OversizedTexture> = Vec::new();
    let mut truncated = false;
    let mut stack = vec![dir.to_path_buf()];

    loop {
        if stack.is_empty() {
            break;
        }
        if seen >= budget {
            truncated = true;
            break;
        }
        // Non-empty per the check above, so this pop cannot fail.
        let current = stack.pop().expect("stack checked non-empty");
        let entries = match fs::read_dir(&current) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if is_backup(&entry.file_name()) {
                continue;
            }
            seen += 1;
            let full = entry.path();
            let is_dir = match entry.file_type() {
                Ok(t) => t.is_dir(),
                Err(_) => continue,
            };
            if is_dir {
                stack.push(full);
                continue;
            }
            let size = match entry.metadata() {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            total += size;

            let name = entry.file_name().to_string_lossy().to_lowercase();
            if !name.ends_with(".png") {
                continue;
            }
            let Some((width, height)) = png_size(&full) else {
                continue;
            };
            count += 1;
            vram += (width as u64) * (height as u64) * 4;
            if width > RECORD_ABOVE_PX || height > RECORD_ABOVE_PX {
                oversized.push(OversizedTexture {
                    path: full.display().to_string(),
                    width,
                    height,
                });
            }
        }
    }

    oversized.sort_by_key(|t| std::cmp::Reverse(t.width as u64 * t.height as u64));
    oversized.truncate(MAX_OVERSIZED);

    MeasuredMod {
        size_bytes: total,
        textures: TextureStats {
            count,
            estimated_vram_bytes: vram,
            oversized,
            truncated,
        },
    }
}

/// Read a PNG's dimensions from its header.
///
/// Only the first 24 bytes are needed: signature, IHDR length, the IHDR tag, then width
/// and height as big-endian u32. Never decode the image: reading the whole file would be
/// thousands of times more IO for the two numbers that determine VRAM cost.
fn png_size(path: &Path) -> Option<(u32, u32)> {
    let mut file = fs::File::open(path).ok()?;
    let mut head = [0u8; 24];
    file.read_exact(&mut head).ok()?;
    if &head[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes([head[16], head[17], head[18], head[19]]);
    let height = u32::from_be_bytes([head[20], head[21], head[22], head[23]]);
    Some((width, height))
}

/// True for `Assemblies`/`Patches` either at the mod root or under a versioned cycle
/// folder like `1.6/Assemblies`.
fn has_subdir(folder: &Path, name: &str) -> bool {
    if folder.join(name).exists() {
        return true;
    }
    let Ok(entries) = fs::read_dir(folder) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
            && is_cycle_folder_name(&entry.file_name().to_string_lossy())
            && entry.path().join(name).exists()
    })
}

/// The mod's banner image, matched case-insensitively rather than by a fixed name:
/// across a 253-mod install it appears as Preview.png, preview.png, Preview.PNG and
/// Preview.jpg.
fn find_preview(folder: &Path) -> Option<String> {
    for about in ["About", "about"] {
        let dir = folder.join(about);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name == "preview.png" || name == "preview.jpg" || name == "preview.jpeg" {
                return Some(entry.path().display().to_string());
            }
        }
    }
    None
}

/// Folder mtime, which Steam bumps on update, so it stands in for "last updated".
/// When the mod folder last changed, to the second.
///
/// Truncated deliberately. The two scanners round sub-millisecond mtimes differently, and
/// this value is compared between scans to decide whether Steam replaced a mod: at
/// millisecond precision 117 of 253 mods reported as updated purely from which scanner had
/// taken the previous snapshot. Nothing about "did this mod change" is meaningful below a
/// second anyway.
fn folder_mtime(folder: &Path) -> Option<String> {
    let modified = fs::metadata(folder).ok()?.modified().ok()?;
    iso8601(modified)
}

/// Format a `SystemTime` as an RFC 3339 / ISO 8601 UTC string, e.g.
/// `2026-09-06T12:34:56.789Z`, using only integer arithmetic. No date/time crate is
/// available here, and one mtime stamp per mod does not justify adding one.
fn iso8601(time: SystemTime) -> Option<String> {
    let duration = time.duration_since(std::time::UNIX_EPOCH).ok()?;
    let secs = duration.as_secs() as i64;
    let millis = 0;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (hour, min, sec) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (year, month, day) = civil_from_days(days);
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z"
    ))
}

/// Howard Hinnant's `civil_from_days`: converts a day count since the Unix epoch into a
/// (year, month, day) proleptic-Gregorian civil date using pure integer arithmetic.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if month <= 2 { y + 1 } else { y };
    (year, month, day)
}

/// `^\d+\.\d+$`: a versioned payload folder such as `1.6`, but not `1.6.2` or `1.6-beta`.
fn is_cycle_folder_name(name: &str) -> bool {
    let mut parts = name.splitn(2, '.');
    match (parts.next(), parts.next()) {
        (Some(a), Some(b)) => {
            !a.is_empty()
                && !b.is_empty()
                && !b.contains('.')
                && a.chars().all(|c| c.is_ascii_digit())
                && b.chars().all(|c| c.is_ascii_digit())
        }
        _ => false,
    }
}

fn is_all_digits(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

// ---------------------------------------------------------------------------------
// About.xml -> ModEntry
// ---------------------------------------------------------------------------------

/// Container elements whose children shadow the top-level scalar fields read from them.
const NESTED_BLOCKS: &[&str] = &[
    "modDependencies",
    "modDependenciesByVersion",
    "incompatibleWith",
    "incompatibleWithByVersion",
    "loadAfter",
    "loadAfterByVersion",
    "loadBefore",
    "loadBeforeByVersion",
    "descriptionsByVersion",
];

/// Package ids shipped by Ludeon. These must load before any third-party content.
const OFFICIAL_PACKAGE_IDS: &[&str] = &[
    "ludeon.rimworld",
    "ludeon.rimworld.royalty",
    "ludeon.rimworld.ideology",
    "ludeon.rimworld.biotech",
    "ludeon.rimworld.anomaly",
    "ludeon.rimworld.odyssey",
];

struct AboutInput {
    xml: String,
    folder: String,
    source: ModSource,
    steam_id: Option<String>,
    has_assemblies: bool,
    has_patches: bool,
    size_bytes: u64,
    updated_at: Option<String>,
}

/// Build a `ModEntry` from an About.xml. RimWorld compares packageIds case-insensitively,
/// so everything id-shaped is lowercased here once and compared raw everywhere else.
///
/// `textures`, `patches` and `previewPath` are filled in by the caller after this
/// returns, mirroring the reference scanner, which measures and reads patches once per
/// mod folder outside the parser rather than inside it.
fn parse_about(input: AboutInput) -> Option<ModEntry> {
    // Identity fields are read from the document with dependency (and other nested)
    // blocks stripped, so a nested packageId can never be mistaken for the mod's own:
    // a mod declaring <modDependencies> above its own <packageId> would otherwise
    // report its dependency's id as its identity.
    let own = strip_blocks(&input.xml, NESTED_BLOCKS);
    let package_id = tag_text(&own, "packageId")?.to_lowercase();

    // Ludeon's own About.xml files carry no <name>, and the game falls back to the
    // folder name for them. A Workshop folder is named after its numeric file id, which
    // labels nothing, so that case falls through to the package id instead.
    let name = tag_text(&own, "name")
        .or_else(|| folder_name(&input.folder))
        .unwrap_or_else(|| package_id.clone());

    let author = tag_text(&own, "author").or_else(|| {
        let authors = tag_list(&own, "authors");
        (!authors.is_empty()).then(|| authors.join(", "))
    });

    let source = if OFFICIAL_PACKAGE_IDS.contains(&package_id.as_str()) {
        ModSource::Official
    } else {
        input.source
    };

    // The two dependency blocks routinely list the same mod, so a raw concat would make
    // every rule that walks dependencies fire twice for one relationship.
    let mut dependencies = dependency_list(&input.xml, "modDependencies");
    dependencies.extend(dependency_list(&input.xml, "modDependenciesByVersion"));
    let dependencies = dedupe_by_id(dependencies);

    let lower = |ids: Vec<String>| {
        ids.into_iter()
            .map(|s| s.to_lowercase())
            .collect::<Vec<_>>()
    };

    Some(ModEntry {
        package_id,
        name,
        author,
        folder: input.folder,
        source,
        steam_id: input.steam_id,
        supported_versions: tag_list(&input.xml, "supportedVersions"),
        // Descriptions run to essays; enough to tell mods apart, not enough to bloat the scan.
        description: trim_description(tag_text(&own, "description")),
        updated_at: input.updated_at,
        preview_path: None,
        dependencies,
        incompatible_with: lower(tag_list(&input.xml, "incompatibleWith")),
        // force* is the hard form of the same constraint and Ludeon's Core uses it, so
        // both spellings have to feed the ordering rules or official content sorts wrong.
        load_after: lower(concat(
            tag_list(&input.xml, "loadAfter"),
            tag_list(&input.xml, "forceLoadAfter"),
        )),
        load_before: lower(concat(
            tag_list(&input.xml, "loadBefore"),
            tag_list(&input.xml, "forceLoadBefore"),
        )),
        has_assemblies: input.has_assemblies,
        has_patches: input.has_patches,
        size_bytes: input.size_bytes,
        textures: TextureStats {
            count: 0,
            estimated_vram_bytes: 0,
            oversized: Vec::new(),
            truncated: false,
        },
        patches: Vec::new(),
        active: false,
        load_index: None,
    })
}

fn concat(mut a: Vec<String>, b: Vec<String>) -> Vec<String> {
    a.extend(b);
    a
}

/// First entry per packageId wins, so the richer displayName from the primary block
/// (`modDependencies` before `modDependenciesByVersion`) survives.
fn dedupe_by_id(deps: Vec<ModDependency>) -> Vec<ModDependency> {
    let mut seen = HashSet::new();
    let mut result = Vec::with_capacity(deps.len());
    for dep in deps {
        if seen.insert(dep.package_id.to_lowercase()) {
            result.push(dep);
        }
    }
    result
}

/// Collapse the markup and whitespace authors put in descriptions, then cap the length.
fn trim_description(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let text = collapse_whitespace(&strip_html_ish_tags(&raw));
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    // Counted in UTF-16 code units rather than characters, because the cap has to land in
    // the same place as the JavaScript reference, where an astral-plane character counts as
    // two. A Chinese description on the reference install truncated differently otherwise.
    if text.encode_utf16().count() > 600 {
        let mut units = 0usize;
        let mut end = text.len();
        for (offset, ch) in text.char_indices() {
            if units + ch.len_utf16() > 600 {
                end = offset;
                break;
            }
            units += ch.len_utf16();
        }
        Some(format!("{}...", text[..end].trim_end()))
    } else {
        Some(text.to_string())
    }
}

/// Last path segment, unless it is a Steam Workshop file id, which labels nothing.
fn folder_name(folder: &str) -> Option<String> {
    let segment = folder.split(['\\', '/']).rfind(|s| !s.is_empty())?;
    (!is_all_digits(segment)).then(|| segment.to_string())
}

// ---------------------------------------------------------------------------------
// ModsConfig.xml
// ---------------------------------------------------------------------------------

/// Active mod list from ModsConfig.xml, in load order, plus the running game version.
fn parse_mods_config(xml: &str) -> (String, Vec<String>) {
    let game_version = tag_text(xml, "version").unwrap_or_else(|| "unknown".to_string());
    let active_order = tag_list(xml, "activeMods")
        .into_iter()
        .map(|s| s.to_lowercase())
        .collect();
    (game_version, active_order)
}

/// "1.6.4871 rev590" -> "1.6". About.xml supportedVersions are major.minor only.
fn game_cycle_of(game_version: &str) -> String {
    let trimmed = game_version.trim();
    let bytes = trimmed.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 || bytes.get(i) != Some(&b'.') {
        return "unknown".to_string();
    }
    let mut j = i + 1;
    while j < bytes.len() && bytes[j].is_ascii_digit() {
        j += 1;
    }
    if j == i + 1 {
        return "unknown".to_string();
    }
    trimmed[..j].to_string()
}

// ---------------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------------

/// Pull xpath-targeting operations out of a mod's Patches folder(s).
///
/// Extraction anchors on the `<xpath>` element and walks backwards to the nearest
/// `Class` attribute, rather than anchoring on `<Operation>`: operations nest inside
/// `PatchOperationSequence` and `PatchOperationConditional`, and `Class` also appears on
/// def elements inside a `<value>` block, so matching `Class=` directly would pick up
/// things that are not operations at all. Every xpath belongs to the nearest `Class`
/// above it, whatever the nesting.
fn read_patches(mod_folder: &Path) -> Vec<PatchOperation> {
    // Versioned mods nest their payload under a cycle folder, so Patches lives at either
    // <mod>/Patches or <mod>/1.6/Patches. Looking only at the top level missed three
    // quarters of the mods that ship patches at all.
    let mut roots = vec![mod_folder.join("Patches")];
    if let Ok(entries) = fs::read_dir(mod_folder) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
                && is_cycle_folder_name(&entry.file_name().to_string_lossy())
            {
                roots.push(entry.path().join("Patches"));
            }
        }
    }

    let mut stack: Vec<PathBuf> = roots.into_iter().filter(|r| r.exists()).collect();
    if stack.is_empty() {
        return Vec::new();
    }

    let mut files: Vec<PathBuf> = Vec::new();
    while !stack.is_empty() && files.len() < MAX_PATCH_FILES {
        let dir = stack.pop().expect("stack checked non-empty");
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let full = entry.path();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                stack.push(full);
            } else if entry
                .file_name()
                .to_string_lossy()
                .to_lowercase()
                .ends_with(".xml")
            {
                files.push(full);
            }
        }
    }

    let mut ops = Vec::new();
    for file in files {
        if ops.len() >= MAX_PATCH_OPS {
            break;
        }
        let Ok(bytes) = fs::read(&file) else { continue };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let rel = file
            .strip_prefix(mod_folder)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");

        for (op_start, content_start, content_end) in find_all_tag_matches(&text, "xpath") {
            if ops.len() >= MAX_PATCH_OPS {
                break;
            }
            let op = last_class_attr(&text[..op_start]).unwrap_or_else(|| "unknown".to_string());
            ops.push(PatchOperation {
                op,
                xpath: normalise_xpath(&text[content_start..content_end]),
                file: rel.clone(),
            });
        }
    }
    ops
}

/// Same target written two ways must compare equal, or collisions go unnoticed.
fn normalise_xpath(raw: &str) -> String {
    let text = collapse_whitespace(raw);
    let text = text.trim();
    if text.starts_with('/') {
        text.to_string()
    } else {
        format!("/{text}")
    }
}

/// Every `Class="..."` attribute in `text`, in document order. Case-sensitive on
/// purpose: RimWorld's own attribute is spelled with a capital C, and folding case here
/// would risk matching an unrelated `class=` some mod's custom XML happens to use.
fn all_class_attrs(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut result = Vec::new();
    let mut idx = 0;
    while let Some(rel) = text[idx..].find("Class") {
        let pos = idx + rel;
        let mut i = pos + "Class".len();
        while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
            i += 1;
        }
        if bytes.get(i) == Some(&b'=') {
            i += 1;
            while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
                i += 1;
            }
            if bytes.get(i) == Some(&b'"') {
                let start = i + 1;
                let mut end = start;
                while bytes.get(end).is_some_and(|c| *c != b'"') {
                    end += 1;
                }
                if end > start && bytes.get(end) == Some(&b'"') {
                    result.push(text[start..end].to_string());
                    idx = end + 1;
                    continue;
                }
            }
        }
        idx = pos + "Class".len();
    }
    result
}

/// The nearest `Class` attribute above a given point: the last one that appears before it.
fn last_class_attr(preceding: &str) -> Option<String> {
    all_class_attrs(preceding).into_iter().next_back()
}

// ---------------------------------------------------------------------------------
// Tolerant XML primitives
//
// A meaningful share of Workshop About.xml files are malformed: stray ampersands, a BOM
// mid-file, unclosed tags, inconsistent casing. A strict parser rejects the whole
// document and the mod vanishes from the list, so these extractors pull the few fields
// that matter with case-insensitive substring scanning and ignore everything else. This
// is a direct port of src/lib/analysis/xml.ts's regex approach; no XML or regex crate is
// introduced, so the same tolerance (and the same edge-case behaviour) carries over.
// ---------------------------------------------------------------------------------

/// Find the next `<tag` (case-insensitive) at or after `from` whose name is not itself a
/// prefix of a longer tag name, and return `(tag_start, content_start)`, where
/// `content_start` is the index right after the opening tag's closing `>`.
///
/// `lower` must be the ASCII-lowercased form of the same string `content_start`/`tag_start`
/// will be used to index into; `to_ascii_lowercase` never changes a string's byte length,
/// so offsets computed against it stay valid against the original.
fn find_open_tag(lower: &str, tag_lower: &str, from: usize) -> Option<(usize, usize)> {
    let bytes = lower.as_bytes();
    let needle = format!("<{tag_lower}");
    let mut search_from = from;
    loop {
        let rel = lower.get(search_from..)?.find(&needle)?;
        let start = search_from + rel;
        let after = start + needle.len();
        match bytes.get(after) {
            Some(b'>') => return Some((start, after + 1)),
            Some(c) if c.is_ascii_whitespace() => {
                let close_rel = lower.get(after..)?.find('>')?;
                return Some((start, after + close_rel + 1));
            }
            _ => search_from = start + 1,
        }
    }
}

/// Find the next `</tag\s*>` (case-insensitive) at or after `from`, returning
/// `(close_start, close_end)` where `close_start` is the index of `<` and `close_end` is
/// the index right after `>`.
fn find_close_tag(lower: &str, tag_lower: &str, from: usize) -> Option<(usize, usize)> {
    let bytes = lower.as_bytes();
    let needle = format!("</{tag_lower}");
    let mut search_from = from;
    loop {
        let rel = lower.get(search_from..)?.find(&needle)?;
        let idx = search_from + rel;
        let mut end = idx + needle.len();
        while bytes.get(end).is_some_and(u8::is_ascii_whitespace) {
            end += 1;
        }
        if bytes.get(end) == Some(&b'>') {
            return Some((idx, end + 1));
        }
        search_from = idx + 1;
    }
}

/// The first `<tag>...</tag>` in `xml`, as a byte range into `xml` for its inner content.
/// Lazy, like the regex it replaces: the content ends at the first closing tag found
/// after the opening one, however much of the document that spans.
fn first_tag_range(xml: &str, tag: &str) -> Option<(usize, usize)> {
    let lower = xml.to_ascii_lowercase();
    let tag_lower = tag.to_ascii_lowercase();
    let (_, content_start) = find_open_tag(&lower, &tag_lower, 0)?;
    let (close_start, _) = find_close_tag(&lower, &tag_lower, content_start)?;
    Some((content_start, close_start))
}

/// Every `<tag>...</tag>` in `text`, as `(open_start, content_start, content_end)`
/// triples in document order. `open_start` is the index of the whole match's leading
/// `<`, needed by the patch reader to slice everything before an operation.
fn find_all_tag_matches(text: &str, tag: &str) -> Vec<(usize, usize, usize)> {
    let lower = text.to_ascii_lowercase();
    let tag_lower = tag.to_ascii_lowercase();
    let mut result = Vec::new();
    let mut from = 0;
    while let Some((open_start, content_start)) = find_open_tag(&lower, &tag_lower, from) {
        match find_close_tag(&lower, &tag_lower, content_start) {
            Some((close_start, close_end)) => {
                result.push((open_start, content_start, close_start));
                from = close_end;
            }
            None => break,
        }
    }
    result
}

/// Remove every whole `<tag>...</tag>` block, for each tag in `tags`, case-insensitively.
///
/// Scalar fields have to be read from a document with the container blocks stripped out:
/// a dependency entry nests its own `<packageId>`, so a mod whose About.xml declares
/// `<modDependencies>` above its own `<packageId>` would otherwise report its
/// dependency's id as its identity.
fn strip_blocks(xml: &str, tags: &[&str]) -> String {
    tags.iter()
        .fold(xml.to_string(), |acc, tag| strip_tag(&acc, tag))
}

fn strip_tag(text: &str, tag: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let tag_lower = tag.to_ascii_lowercase();
    let mut result = String::with_capacity(text.len());
    let mut from = 0;
    while let Some((open_start, content_start)) = find_open_tag(&lower, &tag_lower, from) {
        let Some((_, close_end)) = find_close_tag(&lower, &tag_lower, content_start) else {
            break;
        };
        result.push_str(&text[from..open_start]);
        from = close_end;
    }
    result.push_str(&text[from..]);
    result
}

/// First text value of `tag`, trimmed and entity-decoded. Case-insensitive on the tag name.
fn tag_text(xml: &str, tag: &str) -> Option<String> {
    let (start, end) = first_tag_range(xml, tag)?;
    let value = decode_entities(&xml[start..end]);
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// `<li>` values inside the first `<tag>` block. Returns `[]` when the tag is absent.
fn tag_list(xml: &str, tag: &str) -> Vec<String> {
    let Some((start, end)) = first_tag_range(xml, tag) else {
        return Vec::new();
    };
    let block = &xml[start..end];
    find_all_tag_matches(block, "li")
        .into_iter()
        .filter_map(|(_, s, e)| {
            let value = decode_entities(&block[s..e]);
            let value = value.trim().to_string();
            (!value.is_empty()).then_some(value)
        })
        .collect()
}

/// Dependency blocks carry a nested packageId, so a flat `<li>` read would return the
/// whole child element. Pull the packageId out and keep the display name when present.
fn dependency_list(xml: &str, tag: &str) -> Vec<ModDependency> {
    let Some((start, end)) = first_tag_range(xml, tag) else {
        return Vec::new();
    };
    let block = &xml[start..end];
    find_all_tag_matches(block, "li")
        .into_iter()
        .filter_map(|(_, s, e)| {
            let li_inner = &block[s..e];
            let package_id = tag_text(li_inner, "packageId")?;
            Some(ModDependency {
                package_id,
                display_name: tag_text(li_inner, "displayName"),
            })
        })
        .collect()
}

fn decode_entities(s: &str) -> String {
    let mut out = strip_cdata(s);
    for (from, to) in [
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&apos;", "'"),
        ("&amp;", "&"),
    ] {
        out = out.replace(from, to);
    }
    out.replace('\u{FEFF}', "")
}

fn strip_cdata(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let Some(start) = rest.find("<![CDATA[") else {
            result.push_str(rest);
            break;
        };
        result.push_str(&rest[..start]);
        let after = &rest[start + "<![CDATA[".len()..];
        match after.find("]]>") {
            Some(end) => {
                result.push_str(&after[..end]);
                rest = &after[end + "]]>".len()..];
            }
            None => {
                // No closing marker: the regex this replaces would not match here either,
                // so the literal text (including the opening marker) is left in place.
                result.push_str(&rest[start..]);
                break;
            }
        }
    }
    result
}

/// Strip anything that looks like an HTML/XML tag: `<`, optional `/`, a letter, then
/// anything up to `>`. Descriptions occasionally carry `<i>`/`<br>`-style markup that
/// isn't part of the RimWorld schema; this mirrors the reference scanner's regex rather
/// than trying to be a real markup parser.
fn strip_html_ish_tags(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut result = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if bytes[i] == b'<' {
            let mut j = i + 1;
            if bytes.get(j) == Some(&b'/') {
                j += 1;
            }
            if bytes.get(j).is_some_and(u8::is_ascii_alphabetic) {
                if let Some(close_rel) = s[j..].find('>') {
                    result.push(' ');
                    i = j + close_rel + 1;
                    continue;
                }
            }
        }
        let ch = s[i..].chars().next().expect("i is a char boundary");
        result.push(ch);
        i += ch.len_utf8();
    }
    result
}

fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    out
}

// ---------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------

/// Dump a real scan to disk so it can be diffed against the Node scanner's output.
///
/// Ignored by default: it needs RimWorld installed and takes the better part of a minute.
/// Run with `cargo test -- --ignored dump_real_scan --nocapture`.
#[cfg(test)]
#[test]
#[ignore]
fn dump_real_scan() {
    let result = scan_install(None).expect("scan the real install");
    let json = serde_json::to_string_pretty(&result).expect("serialise");
    let out = std::env::temp_dir().join("rimdoc-rust-scan.json");
    std::fs::write(&out, json).expect("write");
    println!("wrote {}", out.display());
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

    /// A dependency entry nests its own <packageId>. Before this was ported correctly,
    /// mods declaring <modDependencies> above their own identity collapsed 24 unrelated
    /// mods into brrainz.harmony.
    #[test]
    fn identity_ignores_a_nested_dependency_packageid() {
        let xml = r#"<ModMetaData>
            <modDependencies>
                <li><packageId>brrainz.harmony</packageId><displayName>Harmony</displayName></li>
            </modDependencies>
            <packageId>author.realmod</packageId>
            <name>Real Mod</name>
        </ModMetaData>"#;
        let input = AboutInput {
            xml: xml.to_string(),
            folder: "C:/Mods/RealMod".to_string(),
            source: ModSource::Local,
            steam_id: None,
            has_assemblies: false,
            has_patches: false,
            size_bytes: 0,
            updated_at: None,
        };
        let mod_entry = parse_about(input).unwrap();
        assert_eq!(mod_entry.package_id, "author.realmod");
        assert_eq!(mod_entry.dependencies.len(), 1);
        assert_eq!(mod_entry.dependencies[0].package_id, "brrainz.harmony");
    }

    /// Ludeon's own About.xml has no <name>; the game falls back to the folder name. A
    /// Workshop folder is named after its numeric file id, which is no use as a label.
    #[test]
    fn missing_name_falls_back_to_folder_then_package_id() {
        let named_folder = AboutInput {
            xml: "<ModMetaData><packageId>ludeon.rimworld</packageId></ModMetaData>".to_string(),
            folder: "C:/RimWorld/Data/Core".to_string(),
            source: ModSource::Official,
            steam_id: None,
            has_assemblies: false,
            has_patches: false,
            size_bytes: 0,
            updated_at: None,
        };
        assert_eq!(parse_about(named_folder).unwrap().name, "Core");

        let numeric_folder = AboutInput {
            xml: "<ModMetaData><packageId>author.somemod</packageId></ModMetaData>".to_string(),
            folder: "C:/Workshop/2009463077".to_string(),
            source: ModSource::Steam,
            steam_id: Some("2009463077".to_string()),
            has_assemblies: false,
            has_patches: false,
            size_bytes: 0,
            updated_at: None,
        };
        assert_eq!(parse_about(numeric_folder).unwrap().name, "author.somemod");
    }

    /// forceLoadBefore/forceLoadAfter are the hard form of the ordering constraint and
    /// Core uses them; reading only loadBefore/loadAfter sorts official content wrong.
    #[test]
    fn force_load_order_merges_with_the_soft_form() {
        let xml = r#"<ModMetaData>
            <packageId>ludeon.rimworld</packageId>
            <loadAfter><li>some.mod</li></loadAfter>
            <forceLoadBefore><li>Some.OtherMod</li></forceLoadBefore>
        </ModMetaData>"#;
        let input = AboutInput {
            xml: xml.to_string(),
            folder: "C:/RimWorld/Data/Core".to_string(),
            source: ModSource::Official,
            steam_id: None,
            has_assemblies: false,
            has_patches: false,
            size_bytes: 0,
            updated_at: None,
        };
        let mod_entry = parse_about(input).unwrap();
        assert_eq!(mod_entry.load_after, vec!["some.mod"]);
        assert_eq!(mod_entry.load_before, vec!["some.othermod"]);
    }

    /// Patches live in both <mod>/Patches and <mod>/<cycle>/Patches.
    #[test]
    fn patches_are_read_from_both_the_root_and_the_versioned_folder() {
        let tmp = tempdir().unwrap();
        let mod_dir = tmp.path().join("SomeMod");
        write(
            &mod_dir.join("Patches/Root.xml"),
            r#"<Patch><Operation Class="PatchOperationAdd"><xpath>/Defs/ThingDef[0]</xpath></Operation></Patch>"#,
        );
        write(
            &mod_dir.join("1.6/Patches/Versioned.xml"),
            r#"<Patch><Operation Class="PatchOperationReplace"><xpath>/Defs/ThingDef[1]</xpath></Operation></Patch>"#,
        );

        let ops = read_patches(&mod_dir);
        assert_eq!(ops.len(), 2);
        assert!(ops
            .iter()
            .any(|o| o.op == "PatchOperationAdd" && o.file == "Patches/Root.xml"));
        assert!(ops
            .iter()
            .any(|o| o.op == "PatchOperationReplace" && o.file == "1.6/Patches/Versioned.xml"));
    }

    /// Anchoring on <Operation> breaks under PatchOperationSequence nesting; anchoring on
    /// <xpath> and walking back to the nearest Class does not.
    #[test]
    fn xpath_extraction_finds_the_nearest_class_through_nesting() {
        let xml = r#"<Patch>
            <Operation Class="PatchOperationSequence">
                <operations>
                    <li Class="PatchOperationAdd">
                        <xpath>/Defs/ThingDef[defName="A"]</xpath>
                        <value><ThingDef Class="SomeDef"><defName>Unrelated</defName></ThingDef></value>
                    </li>
                </operations>
            </Operation>
        </Patch>"#;
        let matches = find_all_tag_matches(xml, "xpath");
        assert_eq!(matches.len(), 1);
        let (op_start, content_start, content_end) = matches[0];
        assert_eq!(
            last_class_attr(&xml[..op_start]).unwrap(),
            "PatchOperationAdd"
        );
        assert_eq!(
            normalise_xpath(&xml[content_start..content_end]),
            "/Defs/ThingDef[defName=\"A\"]"
        );
    }

    /// Only the first 24 bytes matter; VRAM comes from dimensions, never file size.
    #[test]
    fn png_dimensions_read_from_the_header_only() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("Big.png");
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]; // signature
        bytes.extend_from_slice(&[0, 0, 0, 13]); // IHDR length
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&2048u32.to_be_bytes()); // width
        bytes.extend_from_slice(&1024u32.to_be_bytes()); // height
        bytes.extend_from_slice(&[0u8; 100]); // not a real PNG past the header, and that's fine
        fs::write(&path, &bytes).unwrap();

        let (w, h) = png_size(&path).unwrap();
        assert_eq!((w, h), (2048, 1024));
    }

    /// Tolerant reading: a stray ampersand and mixed casing must not lose the fields
    /// that matter, even though the document as a whole is not valid XML.
    #[test]
    fn malformed_xml_still_yields_the_fields_that_matter() {
        let xml =
            "<ModMetaData><PackageId>Author.Mod</PackageId><name>Rock & Stone</name></ModMetaData>";
        assert_eq!(tag_text(xml, "packageId").unwrap(), "Author.Mod");
        assert_eq!(tag_text(xml, "name").unwrap(), "Rock & Stone");
    }

    #[test]
    fn cycle_folder_names_match_major_dot_minor_only() {
        assert!(is_cycle_folder_name("1.6"));
        assert!(!is_cycle_folder_name("1.6.2"));
        assert!(!is_cycle_folder_name("v1.6"));
        assert!(!is_cycle_folder_name("Assemblies"));
    }

    #[test]
    fn a_purely_numeric_folder_name_is_not_a_display_name() {
        assert_eq!(folder_name("C:/Workshop/2009463077"), None);
        assert_eq!(
            folder_name("C:/Mods/HospitalityContinued"),
            Some("HospitalityContinued".to_string())
        );
    }

    #[test]
    fn game_cycle_takes_major_minor_only() {
        assert_eq!(game_cycle_of("1.6.4871 rev590"), "1.6");
        assert_eq!(game_cycle_of("garbage"), "unknown");
    }

    /// Same target written two ways must compare equal, or collisions go unnoticed.
    #[test]
    fn xpath_normalisation_makes_equivalent_targets_compare_equal() {
        assert_eq!(normalise_xpath("  /Defs/ThingDef  "), "/Defs/ThingDef");
        assert_eq!(normalise_xpath("Defs/ThingDef"), "/Defs/ThingDef");
        assert_eq!(normalise_xpath("/Defs/\n  ThingDef"), "/Defs/ ThingDef");
    }
}

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::UNIX_EPOCH;
use tauri::Manager;
use walkdir::WalkDir;

const MAX_INDEX_SIZE: usize = 50_000;
const MAX_INDEX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SCAN_DEPTH: usize = 20;
// Yield CPU every N entries so bg build can't peg a core.
const SCAN_YIELD_EVERY: usize = 256;
const SCAN_YIELD_MS: u64 = 2;

static FILE_INDEX: std::sync::LazyLock<Arc<RwLock<FileIndex>>> =
    std::sync::LazyLock::new(|| Arc::new(RwLock::new(FileIndex::default())));

static BUILD_CANCEL: AtomicBool = AtomicBool::new(false);
static INDEXER_ENABLED: AtomicBool = AtomicBool::new(true);

static BUILD_MUTEX: std::sync::LazyLock<Mutex<()>> = std::sync::LazyLock::new(|| Mutex::new(()));
// Serializes the tiny cancellation/commit critical section. The filesystem
// walk never takes this lock, so cancellation remains responsive while the
// final publication cannot race a cancel request.
static BUILD_COMMIT_MUTEX: std::sync::LazyLock<Mutex<()>> =
    std::sync::LazyLock::new(|| Mutex::new(()));

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub name: String,
    // Lowercased name for search; not persisted, repopulated on load/build.
    #[serde(skip)]
    pub name_lower: String,
    pub path: String,
    pub is_directory: bool,
    pub is_file: bool,
    #[serde(default)]
    pub is_hidden: bool,
    pub size: u64,
    pub modified: f64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct IndexFileData {
    #[serde(default)]
    index: Vec<IndexEntry>,
    #[serde(default)]
    last_index_time: Option<f64>,
    #[serde(default)]
    version: u32,
}

#[derive(Default)]
pub struct FileIndex {
    pub entries: Vec<IndexEntry>,
    pub is_building: bool,
    pub last_built: Option<String>,
}

fn exclude_segments() -> HashSet<&'static str> {
    [
        "node_modules",
        ".git",
        ".cache",
        ".trash",
        "trash",
        "$recycle.bin",
        "system volume information",
        ".npm",
        ".docker",
        ".snap",
        "appdata",
        "programdata",
        "windows",
        "program files",
        "program files (x86)",
        "$windows.~bt",
        "$windows.~ws",
        "recovery",
        "perflogs",
        "$winreagent",
        "config.msi",
        "msocache",
        "intel",
        "nvidia",
        "amd",
        "lost+found",
        ".spotlight-v100",
        ".trashes",
        ".fseventsd",
        ".documentrevisions-v100",
    ]
    .into_iter()
    .collect()
}

fn exclude_files() -> HashSet<&'static str> {
    [
        "pagefile.sys",
        "hiberfil.sys",
        "swapfile.sys",
        "dumpstack.log.tmp",
        "dumpstack.log",
        ".ds_store",
        "thumbs.db",
        "desktop.ini",
        "ntuser.dat",
        "ntuser.dat.log",
        "ntuser.dat.log1",
        "ntuser.dat.log2",
    ]
    .into_iter()
    .collect()
}

fn should_exclude(path: &Path, excl_segments: &HashSet<&str>, excl_files: &HashSet<&str>) -> bool {
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if excl_files.contains(name.to_lowercase().as_str()) {
            return true;
        }
    }
    for component in path.components() {
        if let std::path::Component::Normal(seg) = component {
            if let Some(s) = seg.to_str() {
                if excl_segments.contains(s.to_lowercase().as_str()) {
                    return true;
                }
            }
        }
    }
    false
}

fn get_index_locations() -> Vec<PathBuf> {
    let mut locations = Vec::new();

    if let Some(user_dirs) = directories::UserDirs::new() {
        let home = user_dirs.home_dir();
        for dir in &[
            "Desktop",
            "Documents",
            "Downloads",
            "Pictures",
            "Music",
            "Videos",
        ] {
            let p = home.join(dir);
            if p.exists() {
                locations.push(p);
            }
        }

        #[cfg(target_os = "macos")]
        {
            let movies = home.join("Movies");
            if movies.exists() {
                locations.push(movies);
            }
            // Skip /Applications + /Volumes: deep .app trees, external mounts. Opt-in later.
        }

        #[cfg(target_os = "linux")]
        {
            for p in &["/usr", "/opt"] {
                let path = Path::new(p);
                if path.exists() {
                    locations.push(path.to_path_buf());
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        for letter in b'C'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).exists() {
                locations.push(PathBuf::from(drive));
            }
        }
    }

    locations
}

fn name_lower_of(name: &str) -> String {
    name.to_lowercase()
}

fn compute_is_hidden(name: &str, meta: &fs::Metadata) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x2 != 0 {
            return true;
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = meta;
    name.starts_with('.')
}

fn populate_name_lower(entries: &mut [IndexEntry]) {
    for entry in entries.iter_mut() {
        if entry.name_lower.is_empty() {
            entry.name_lower = name_lower_of(&entry.name);
        }
    }
}

fn build_index_sync() -> Vec<IndexEntry> {
    let excl_segments = exclude_segments();
    let excl_files = exclude_files();
    let locations = get_index_locations();
    let mut entries = Vec::new();
    let mut scanned = 0usize;

    for location in &locations {
        if is_build_cancelled() {
            break;
        }

        for entry in WalkDir::new(location)
            .max_depth(MAX_SCAN_DEPTH)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !should_exclude(e.path(), &excl_segments, &excl_files))
            .filter_map(|e| {
                e.map_err(|err| log::warn!("[Indexer] walk error: {}", err))
                    .ok()
            })
        {
            if is_build_cancelled() || entries.len() >= MAX_INDEX_SIZE {
                break;
            }

            // Throttle: sleep every SCAN_YIELD_EVERY entries; re-check cancel.
            scanned += 1;
            if scanned.is_multiple_of(SCAN_YIELD_EVERY) {
                if is_build_cancelled() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(SCAN_YIELD_MS));
            }

            let path = entry.path();
            // WalkDir does not descend through links, but metadata() can
            // still follow a replaced final component on some platforms.
            // Index only real regular files/directories so search results do
            // not disclose target metadata from symlink entries.
            let meta = match fs::symlink_metadata(path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() || (!meta.is_file() && !meta.is_dir()) {
                continue;
            }

            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64() * 1000.0)
                .unwrap_or(0.0);

            let name_lower = name_lower_of(&name);
            let is_hidden = compute_is_hidden(&name, &meta);
            entries.push(IndexEntry {
                name,
                name_lower,
                path: path.to_string_lossy().to_string(),
                is_directory: meta.is_dir(),
                is_file: meta.is_file(),
                is_hidden,
                size: meta.len(),
                modified,
            });
        }

        if entries.len() >= MAX_INDEX_SIZE {
            break;
        }
    }

    entries
}

fn is_build_cancelled() -> bool {
    BUILD_CANCEL.load(Ordering::Relaxed)
}

fn set_build_cancelled(val: bool) {
    BUILD_CANCEL.store(val, Ordering::Relaxed);
}

fn index_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    crate::ensure_real_directory_tree(&dir, "Index directory")?;
    Ok(dir.join("file-index.json"))
}

fn load_index_from_disk(path: &Path) -> Option<IndexFileData> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_INDEX_FILE_BYTES
    {
        log::warn!("Ignoring unsafe or oversized index file {}", path.display());
        return None;
    }
    let file = crate::file_operations::open_regular_read(path).ok()?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    use std::io::Read;
    file.take(MAX_INDEX_FILE_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_INDEX_FILE_BYTES {
        return None;
    }
    let data = String::from_utf8(bytes).ok()?;
    let mut parsed: IndexFileData = serde_json::from_str(&data).ok()?;
    if parsed.version != 1 {
        log::info!("Ignoring unsupported file index version {}", parsed.version);
        return None;
    }
    // v1 index files predate the is_hidden field; restore dotfile hiddenness.
    for entry in parsed.index.iter_mut() {
        if entry.name.starts_with('.') {
            entry.is_hidden = true;
        }
    }
    Some(parsed)
}

fn save_index_to_disk(path: &Path, entries: &[IndexEntry]) -> Result<(), String> {
    #[derive(serde::Serialize)]
    struct IndexFileDataRef<'a> {
        index: &'a [IndexEntry],
        last_index_time: Option<f64>,
        version: u32,
    }

    let data = IndexFileDataRef {
        index: entries,
        last_index_time: Some(
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64()
                * 1000.0,
        ),
        version: 1,
    };

    let json = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    if json.len() as u64 > MAX_INDEX_FILE_BYTES {
        return Err(format!(
            "File index exceeds {} byte limit",
            MAX_INDEX_FILE_BYTES
        ));
    }
    let (tmp, mut file) = crate::create_secure_temp_file(path, "index")?;
    let write_result = (|| -> Result<(), String> {
        file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }

    if let Err(e) = crate::atomic_replace_file(&tmp, path) {
        if let Err(cleanup_err) = fs::remove_file(&tmp) {
            log::warn!(
                "[Indexer] Failed to clean up temp file {}: {}",
                tmp.display(),
                cleanup_err
            );
        }
        return Err(e);
    }

    Ok(())
}

pub fn initialize_index(app: &tauri::AppHandle) {
    let idx_path = match index_path(app) {
        Ok(p) => p,
        Err(_) => return,
    };

    if let Some(data) = load_index_from_disk(&idx_path) {
        if let Ok(mut index) = FILE_INDEX.write() {
            index.entries = data.index;
            populate_name_lower(&mut index.entries);
            index.last_built = data.last_index_time.map(|t| {
                chrono::DateTime::from_timestamp_millis(t as i64)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default()
            });
            log::info!("Loaded {} index entries from disk", index.entries.len());
        }
    }

    // No auto-build: post-launch fs walk looks like idle CPU spike.
    // Built lazily on first search (ensure_index_built) or explicit rebuild.
}

/// Build once in bg if enabled but empty. No-op if populated or building.
pub fn ensure_index_built(app: &tauri::AppHandle) {
    if !INDEXER_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let (empty, building) = match FILE_INDEX.read() {
        Ok(idx) => (idx.entries.is_empty(), idx.is_building),
        Err(_) => return,
    };
    if !empty || building {
        return;
    }
    let app_handle = app.clone();
    std::thread::spawn(move || {
        run_index_build(&app_handle, false);
    });
}

fn run_index_build(app: &tauri::AppHandle, force: bool) {
    let _guard = BUILD_MUTEX.lock().unwrap_or_else(|poisoned| {
        log::warn!("[Indexer] build mutex poisoned; recovering");
        poisoned.into_inner()
    });

    // A disable/cancel request may arrive while this build is waiting for the
    // mutex. Never clear that request and publish a build after the indexer was
    // disabled.
    if !INDEXER_ENABLED.load(Ordering::Relaxed) {
        return;
    }

    if !force {
        if let Ok(index) = FILE_INDEX.read() {
            if !index.entries.is_empty() || index.is_building {
                return;
            }
        }
    }

    {
        let _commit_guard = match BUILD_COMMIT_MUTEX.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                log::warn!("[Indexer] commit mutex poisoned, recovering");
                poisoned.into_inner()
            }
        };
        set_build_cancelled(false);
    }

    if let Ok(mut index) = FILE_INDEX.write() {
        index.is_building = true;
    }

    log::info!("Starting file index build...");
    let entries = build_index_sync();
    if is_build_cancelled() || !INDEXER_ENABLED.load(Ordering::Relaxed) {
        if let Ok(mut index) = FILE_INDEX.write() {
            index.is_building = false;
        }
        log::info!("Discarding cancelled or disabled file index build");
        return;
    }
    let count = entries.len();

    {
        let _commit_guard = match BUILD_COMMIT_MUTEX.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                log::warn!("[Indexer] commit mutex poisoned, recovering");
                poisoned.into_inner()
            }
        };
        if let Ok(mut index) = FILE_INDEX.write() {
            if is_build_cancelled() || !INDEXER_ENABLED.load(Ordering::Relaxed) {
                index.is_building = false;
                log::info!("Discarding cancelled or disabled file index build");
                return;
            }
            index.entries = entries;
            index.is_building = false;
            index.last_built = Some(chrono::Utc::now().to_rfc3339());
        }
    }

    // Keep disk publication in the same short commit section as the in-memory
    // commit. Disabling the indexer can then never clear/remove the file and
    // have this build recreate it afterward.
    let _commit_guard = match BUILD_COMMIT_MUTEX.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log::warn!("[Indexer] commit mutex poisoned, recovering");
            poisoned.into_inner()
        }
    };
    if INDEXER_ENABLED.load(Ordering::Relaxed) && !is_build_cancelled() {
        if let Ok(idx_path) = index_path(app) {
            if let Ok(index) = FILE_INDEX.read() {
                if let Err(e) = save_index_to_disk(&idx_path, &index.entries) {
                    log::warn!("Failed to save index to disk: {}", e);
                }
            }
        }
    }

    log::info!("Index build complete: {} entries", count);
}

/// Optional filters applied to index entries during search.
pub struct IndexSearchFilters {
    pub include_hidden: bool,
    pub regex: Option<regex::Regex>,
    pub file_type: Option<String>,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
    pub date_from_ms: Option<f64>,
    pub date_to_ms: Option<f64>,
}

impl Default for IndexSearchFilters {
    // Legacy defaults keep the pre-filter behavior: no filters, hidden included.
    fn default() -> Self {
        Self {
            include_hidden: true,
            regex: None,
            file_type: None,
            min_size: None,
            max_size: None,
            date_from_ms: None,
            date_to_ms: None,
        }
    }
}

fn index_entry_matches_search(
    entry: &IndexEntry,
    query_lower: &str,
    filters: &IndexSearchFilters,
) -> bool {
    if !filters.include_hidden && (entry.is_hidden || entry.name.starts_with('.')) {
        return false;
    }

    let name_matches = match &filters.regex {
        Some(regex) => regex.is_match(&entry.name),
        None => entry.name_lower.contains(query_lower),
    };
    if !name_matches {
        return false;
    }

    if let Some(file_type) = &filters.file_type {
        if entry.is_directory {
            return false;
        }
        let extension = Path::new(&entry.path)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if extension != file_type.trim_start_matches('.').to_ascii_lowercase() {
            return false;
        }
    }

    if let Some(min_size) = filters.min_size {
        if entry.is_file && entry.size < min_size {
            return false;
        }
    }

    if let Some(max_size) = filters.max_size {
        if entry.is_file && entry.size > max_size {
            return false;
        }
    }

    if let Some(date_from) = filters.date_from_ms {
        if entry.modified < date_from {
            return false;
        }
    }

    if let Some(date_to) = filters.date_to_ms {
        if entry.modified > date_to {
            return false;
        }
    }

    true
}

pub fn search_in_index_filtered_cancellable(
    query: &str,
    filters: &IndexSearchFilters,
    is_cancelled: impl Fn() -> bool,
) -> Vec<IndexEntry> {
    if !INDEXER_ENABLED.load(Ordering::Relaxed) {
        return Vec::new();
    }
    let query_lower = query.to_lowercase();
    let index = match FILE_INDEX.read() {
        Ok(idx) => idx,
        Err(_) => return Vec::new(),
    };
    if is_cancelled() {
        return Vec::new();
    }

    let mut results = Vec::new();
    for entry in index.entries.iter() {
        if is_cancelled() {
            break;
        }
        if index_entry_matches_search(entry, &query_lower, filters) {
            results.push(entry.clone());
            if results.len() >= 10_000 {
                break;
            }
        }
    }
    results
}

// Legacy unfiltered entry point kept for existing callers and tests.
#[allow(dead_code)]
pub fn search_in_index_cancellable(
    query: &str,
    is_cancelled: impl Fn() -> bool,
) -> Vec<IndexEntry> {
    search_in_index_filtered_cancellable(query, &IndexSearchFilters::default(), is_cancelled)
}

pub fn get_status() -> (bool, usize, Option<String>) {
    match FILE_INDEX.read() {
        Ok(idx) => (idx.is_building, idx.entries.len(), idx.last_built.clone()),
        Err(_) => (false, 0, None),
    }
}

pub async fn trigger_rebuild(app: &tauri::AppHandle) {
    request_build_cancel();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let app_handle = app.clone();
    std::thread::spawn(move || {
        run_index_build(&app_handle, true);
    });
}

pub fn cancel_build() {
    request_build_cancel();
}

fn request_build_cancel() {
    let _guard = match BUILD_COMMIT_MUTEX.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log::warn!("[Indexer] commit mutex poisoned, recovering");
            poisoned.into_inner()
        }
    };
    set_build_cancelled(true);
}

pub fn set_enabled(enabled: bool, app: Option<&tauri::AppHandle>) {
    INDEXER_ENABLED.store(enabled, Ordering::Relaxed);
    if enabled {
        return;
    }
    request_build_cancel();
    if let Ok(mut index) = FILE_INDEX.write() {
        index.entries.clear();
        index.is_building = false;
        index.last_built = None;
    }
    if let Some(app) = app {
        if let Ok(path) = index_path(app) {
            let _ = fs::remove_file(path);
        }
    }
}

pub fn is_enabled() -> bool {
    INDEXER_ENABLED.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn should_exclude_skips_node_modules() {
        let segs = exclude_segments();
        let files = exclude_files();
        let p = Path::new("/home/u/proj/node_modules/pkg/index.js");
        assert!(should_exclude(p, &segs, &files));
    }

    #[test]
    fn should_not_exclude_plain_cache_folder_name() {
        let segs = exclude_segments();
        let files = exclude_files();
        let p = Path::new("/home/u/proj/build/cache/output.bin");
        assert!(!should_exclude(p, &segs, &files));
    }

    #[test]
    fn should_exclude_dot_cache() {
        let segs = exclude_segments();
        let files = exclude_files();
        let p = Path::new("/home/u/.cache/foo");
        assert!(should_exclude(p, &segs, &files));
    }

    #[test]
    fn should_not_exclude_macos_library_tree() {
        let segs = exclude_segments();
        let files = exclude_files();
        let p = Path::new("/Users/dev/Library/Fonts/Arial.ttf");
        assert!(!should_exclude(p, &segs, &files));
    }

    #[test]
    fn should_exclude_dot_snap() {
        let segs = exclude_segments();
        let files = exclude_files();
        let p = Path::new("/home/u/.snap/somepkg");
        assert!(should_exclude(p, &segs, &files));
    }

    #[test]
    fn search_in_index_stops_when_cancelled() {
        let mut index = FILE_INDEX.write().unwrap();
        index.entries = vec![
            IndexEntry {
                name: "alpha.txt".to_string(),
                name_lower: "alpha.txt".to_string(),
                path: "/tmp/alpha.txt".to_string(),
                is_directory: false,
                is_file: true,
                is_hidden: false,
                size: 1,
                modified: 0.0,
            },
            IndexEntry {
                name: "alpine.txt".to_string(),
                name_lower: "alpine.txt".to_string(),
                path: "/tmp/alpine.txt".to_string(),
                is_directory: false,
                is_file: true,
                is_hidden: false,
                size: 1,
                modified: 0.0,
            },
        ];
        drop(index);

        let results = search_in_index_cancellable("al", || true);
        assert!(results.is_empty());

        FILE_INDEX.write().unwrap().entries.clear();
    }

    fn index_entry(
        name: &str,
        is_directory: bool,
        size: u64,
        modified: f64,
        is_hidden: bool,
    ) -> IndexEntry {
        IndexEntry {
            name: name.to_string(),
            name_lower: name.to_lowercase(),
            path: format!("/tmp/{}", name),
            is_directory,
            is_file: !is_directory,
            is_hidden,
            size,
            modified,
        }
    }

    fn matched_names<'a>(
        entries: &'a [IndexEntry],
        query: &str,
        filters: &IndexSearchFilters,
    ) -> Vec<&'a str> {
        let query_lower = query.to_lowercase();
        entries
            .iter()
            .filter(|entry| index_entry_matches_search(entry, &query_lower, filters))
            .map(|entry| entry.name.as_str())
            .collect()
    }

    #[test]
    fn index_entry_hidden_flag_uses_dot_names_and_windows_attribute() {
        let temp = tempfile::tempdir().unwrap();
        let visible = temp.path().join("visible.txt");
        fs::write(&visible, "visible").unwrap();
        let meta = fs::symlink_metadata(&visible).unwrap();
        assert!(!compute_is_hidden("visible.txt", &meta));
        assert!(compute_is_hidden(".secret", &meta));

        #[cfg(target_os = "windows")]
        {
            crate::native_windows::update_file_attributes(&visible, None, Some(true), None)
                .unwrap();
            let hidden_meta = fs::symlink_metadata(&visible).unwrap();
            assert!(compute_is_hidden("visible.txt", &hidden_meta));
        }
    }

    #[test]
    fn legacy_index_files_recompute_dotfile_hidden_flag() {
        let temp = tempfile::tempdir().unwrap();
        let index_path = temp.path().join("file-index.json");
        fs::write(
            &index_path,
            r#"{"index":[
                {"name":"plain.txt","path":"/tmp/plain.txt","isDirectory":false,"isFile":true,"size":1,"modified":0.0},
                {"name":".secret","path":"/tmp/.secret","isDirectory":false,"isFile":true,"size":1,"modified":0.0}
            ],"lastIndexTime":0.0,"version":1}"#,
        )
        .unwrap();

        let data = load_index_from_disk(&index_path).expect("legacy index file should load");
        let plain = data
            .index
            .iter()
            .find(|entry| entry.name == "plain.txt")
            .unwrap();
        assert!(!plain.is_hidden);
        let secret = data
            .index
            .iter()
            .find(|entry| entry.name == ".secret")
            .unwrap();
        assert!(secret.is_hidden);
    }

    #[test]
    fn index_search_excludes_hidden_entries_unless_include_hidden() {
        let entries = [
            index_entry("notes.txt", false, 1, 0.0, false),
            index_entry(".secret.txt", false, 1, 0.0, true),
            index_entry("hidden-by-attribute.txt", false, 1, 0.0, true),
            // Entries written before the flag existed still hide by dot name.
            index_entry(".legacy.txt", false, 1, 0.0, false),
        ];

        let visible_only = IndexSearchFilters {
            include_hidden: false,
            ..IndexSearchFilters::default()
        };
        assert_eq!(matched_names(&entries, "txt", &visible_only), ["notes.txt"]);

        let with_hidden = IndexSearchFilters {
            include_hidden: true,
            ..IndexSearchFilters::default()
        };
        assert_eq!(matched_names(&entries, "txt", &with_hidden).len(), 4);
    }

    #[test]
    fn index_search_file_type_filter_skips_directories_and_other_extensions() {
        let entries = [
            index_entry("photo.PNG", false, 1, 0.0, false),
            index_entry("photo.txt", false, 1, 0.0, false),
            index_entry("photo.png", true, 1, 0.0, false),
        ];
        let filters = IndexSearchFilters {
            file_type: Some(".PNG".to_string()),
            ..IndexSearchFilters::default()
        };
        assert_eq!(matched_names(&entries, "photo", &filters), ["photo.PNG"]);
    }

    #[test]
    fn index_search_size_filters_bound_files_only() {
        let entries = [
            index_entry("small.bin", false, 10, 0.0, false),
            index_entry("medium.bin", false, 100, 0.0, false),
            index_entry("large.bin", false, 1000, 0.0, false),
            index_entry("folder.bin", true, 1000, 0.0, false),
        ];

        let min_filters = IndexSearchFilters {
            min_size: Some(100),
            ..IndexSearchFilters::default()
        };
        assert_eq!(
            matched_names(&entries, "bin", &min_filters),
            ["medium.bin", "large.bin", "folder.bin"]
        );

        let max_filters = IndexSearchFilters {
            max_size: Some(100),
            ..IndexSearchFilters::default()
        };
        assert_eq!(
            matched_names(&entries, "bin", &max_filters),
            ["small.bin", "medium.bin", "folder.bin"]
        );
    }

    #[test]
    fn index_search_date_filters_bound_modified_time() {
        let entries = [
            index_entry("old.txt", false, 1, 1_000.0, false),
            index_entry("current.txt", false, 1, 2_000.0, false),
            index_entry("future.txt", false, 1, 3_000.0, false),
        ];

        let from_filters = IndexSearchFilters {
            date_from_ms: Some(2_000.0),
            ..IndexSearchFilters::default()
        };
        assert_eq!(
            matched_names(&entries, "txt", &from_filters),
            ["current.txt", "future.txt"]
        );

        let to_filters = IndexSearchFilters {
            date_to_ms: Some(2_000.0),
            ..IndexSearchFilters::default()
        };
        assert_eq!(
            matched_names(&entries, "txt", &to_filters),
            ["old.txt", "current.txt"]
        );
    }

    #[test]
    fn index_search_regex_filter_matches_entry_names() {
        let entries = [
            index_entry("report-12.pdf", false, 1, 0.0, false),
            index_entry("report-x.pdf", false, 1, 0.0, false),
            index_entry("annual-report-3.pdf", false, 1, 0.0, false),
        ];
        let filters = IndexSearchFilters {
            regex: Some(regex::Regex::new(r"^report-\d+\.pdf$").unwrap()),
            ..IndexSearchFilters::default()
        };
        assert_eq!(matched_names(&entries, "txt", &filters), ["report-12.pdf"]);
    }
}

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::Manager;
use walkdir::WalkDir;

const MAX_INDEX_SIZE: usize = 50_000;
const MAX_INDEX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SCAN_DEPTH: usize = 20;
const MAX_ADDITIONAL_INDEX_LOCATIONS: usize = 64;
const MAX_ADDITIONAL_INDEX_LOCATION_BYTES: usize = 32 * 1024;
const MAX_ADDITIONAL_INDEX_LOCATIONS_BYTES: usize = 64 * 1024;
const INDEX_REFRESH_INTERVAL: Duration = Duration::from_secs(5 * 60);
const BUILD_WAIT_INTERVAL: Duration = Duration::from_millis(25);
// Yield CPU every N entries so bg build can't peg a core.
const SCAN_YIELD_EVERY: usize = 256;
const SCAN_YIELD_MS: u64 = 2;

static FILE_INDEX: std::sync::LazyLock<Arc<RwLock<FileIndex>>> =
    std::sync::LazyLock::new(|| Arc::new(RwLock::new(FileIndex::default())));

static BUILD_CANCEL: AtomicBool = AtomicBool::new(false);
static INDEXER_ENABLED: AtomicBool = AtomicBool::new(true);
static ADDITIONAL_INDEX_LOCATIONS: std::sync::LazyLock<RwLock<Vec<String>>> =
    std::sync::LazyLock::new(|| RwLock::new(Vec::new()));

static INDEX_BUILD_COORDINATOR: std::sync::LazyLock<IndexBuildCoordinator> =
    std::sync::LazyLock::new(IndexBuildCoordinator::default);
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

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexMetadata {
    pub truncated: bool,
    pub truncation_reasons: Vec<String>,
    pub indexed_roots: Vec<String>,
}

struct IndexBuildResult {
    entries: Vec<IndexEntry>,
    metadata: IndexMetadata,
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
    #[serde(default)]
    metadata: IndexMetadata,
}

#[derive(Default)]
pub struct FileIndex {
    pub entries: Vec<IndexEntry>,
    pub last_built: Option<String>,
    pub metadata: IndexMetadata,
}

type StatusCheck = Arc<dyn Fn() -> bool + Send + Sync>;
type BuildPreparation = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

#[derive(Default)]
struct BuildLifecycle {
    generation: u64,
    running_generation: Option<u64>,
    completed_generation: u64,
    last_result: Option<(u64, Result<(), String>)>,
    last_successful_at: Option<Instant>,
    refresh_on_first_search: bool,
}

#[derive(Clone)]
struct IndexBuildCoordinator {
    state: Arc<Mutex<BuildLifecycle>>,
    changed: Arc<Condvar>,
}

impl Default for IndexBuildCoordinator {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(BuildLifecycle {
                refresh_on_first_search: true,
                ..BuildLifecycle::default()
            })),
            changed: Arc::new(Condvar::new()),
        }
    }
}

impl IndexBuildCoordinator {
    fn lifecycle(&self) -> std::sync::MutexGuard<'_, BuildLifecycle> {
        self.state.lock().unwrap_or_else(|poisoned| {
            log::warn!("[Indexer] lifecycle mutex poisoned; recovering");
            poisoned.into_inner()
        })
    }

    fn mark_stale(&self) {
        self.lifecycle().refresh_on_first_search = true;
        self.changed.notify_all();
    }

    fn is_running(&self) -> bool {
        self.lifecycle().running_generation.is_some()
    }

    fn wait_until_idle(&self, is_enabled: impl Fn() -> bool) -> Result<(), String> {
        let mut state = self.lifecycle();
        loop {
            if !is_enabled() {
                return Err("Indexer is disabled".to_string());
            }
            if state.running_generation.is_none() {
                return Ok(());
            }
            state = self.changed.wait(state).unwrap_or_else(|poisoned| {
                log::warn!("[Indexer] lifecycle wait poisoned; recovering");
                poisoned.into_inner()
            });
        }
    }

    fn notify_waiters(&self) {
        self.changed.notify_all();
    }

    // The callbacks are injected so lifecycle tests can use temporary roots
    // and independently control query/build cancellation.
    #[allow(clippy::too_many_arguments)]
    fn ensure_ready<T, B, P>(
        &self,
        force: bool,
        is_enabled: StatusCheck,
        is_build_cancelled: StatusCheck,
        prepare: BuildPreparation,
        is_query_cancelled: impl Fn() -> bool,
        build: B,
        publish: P,
    ) -> Result<(), String>
    where
        T: Send + 'static,
        B: FnOnce() -> Result<T, String> + Send + 'static,
        P: FnOnce(T) -> Result<(), String> + Send + 'static,
    {
        if !is_enabled() {
            return Err("Indexer is disabled".to_string());
        }
        if is_query_cancelled() {
            return Err("Search cancelled".to_string());
        }
        let (generation, should_start) = {
            let mut state = self.lifecycle();
            if let Some(generation) = state.running_generation {
                if is_build_cancelled() {
                    return Err("Index build was cancelled".to_string());
                }
                (generation, false)
            } else {
                let stale = force
                    || state.refresh_on_first_search
                    || state.last_successful_at.is_none_or(|last| {
                        Instant::now().saturating_duration_since(last) >= INDEX_REFRESH_INTERVAL
                    });
                if !stale {
                    return Ok(());
                }

                prepare()?;
                if !is_enabled() {
                    return Err("Indexer is disabled".to_string());
                }
                if is_query_cancelled() {
                    return Err("Search cancelled".to_string());
                }
                if is_build_cancelled() {
                    return Err("Index build was cancelled".to_string());
                }

                state.generation = state.generation.wrapping_add(1).max(1);
                let generation = state.generation;
                state.running_generation = Some(generation);
                (generation, true)
            }
        };

        if should_start {
            let coordinator = self.clone();
            let worker_enabled = Arc::clone(&is_enabled);
            let worker_cancelled = Arc::clone(&is_build_cancelled);
            let spawn_result = std::thread::Builder::new()
                .name("file-index-build".to_string())
                .spawn(move || {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        if !worker_enabled() {
                            return Err("Indexer is disabled".to_string());
                        }
                        if worker_cancelled() {
                            return Err("Index build was cancelled".to_string());
                        }
                        let entries = build()?;
                        if !worker_enabled() {
                            return Err("Indexer is disabled".to_string());
                        }
                        if worker_cancelled() {
                            return Err("Index build was cancelled".to_string());
                        }
                        publish(entries)
                    }))
                    .unwrap_or_else(|_| Err("Index build failed unexpectedly".to_string()));
                    coordinator.complete(generation, result);
                });
            if let Err(error) = spawn_result {
                self.complete(
                    generation,
                    Err(format!("Could not start index build: {error}")),
                );
            }
        }

        loop {
            if !is_enabled() {
                return Err("Indexer is disabled".to_string());
            }
            if is_query_cancelled() {
                return Err("Search cancelled".to_string());
            }
            if is_build_cancelled() {
                return Err("Index build was cancelled".to_string());
            }

            let state = self.lifecycle();
            if let Some((completed_generation, result)) = &state.last_result {
                if *completed_generation >= generation {
                    return result.clone();
                }
            }
            let (state, _) = self
                .changed
                .wait_timeout(state, BUILD_WAIT_INTERVAL)
                .unwrap_or_else(|poisoned| {
                    log::warn!("[Indexer] lifecycle wait poisoned; recovering");
                    poisoned.into_inner()
                });
            drop(state);
        }
    }

    fn complete(&self, generation: u64, result: Result<(), String>) {
        let mut state = self.lifecycle();
        if state.running_generation == Some(generation) {
            state.running_generation = None;
            state.completed_generation = generation;
            if result.is_ok() {
                state.last_successful_at = Some(Instant::now());
                state.refresh_on_first_search = false;
            } else {
                state.refresh_on_first_search = true;
            }
            state.last_result = Some((generation, result));
        }
        drop(state);
        self.changed.notify_all();
    }
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

    // Explicit user roots are highest priority so a large default folder set
    // cannot consume the entry budget before a newly selected folder is read.
    let additional = ADDITIONAL_INDEX_LOCATIONS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    locations.extend(additional.into_iter().map(PathBuf::from));

    if let Some(user_dirs) = directories::UserDirs::new() {
        for path in [
            user_dirs.desktop_dir(),
            user_dirs.document_dir(),
            user_dirs.download_dir(),
            user_dirs.picture_dir(),
            user_dirs.audio_dir(),
            user_dirs.video_dir(),
        ]
        .into_iter()
        .flatten()
        {
            if path.exists() {
                locations.push(path.to_path_buf());
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(user_dirs) = directories::UserDirs::new() {
            let movies = user_dirs.home_dir().join("Movies");
            if movies.exists() {
                locations.push(movies);
            }
        }
        // Skip /Applications + /Volumes: deep .app trees, external mounts. Opt-in later.
    }

    // No system-wide roots (Windows drive letters or Linux /usr, /opt) are
    // indexed by default. They are large, rarely user-owned, and conflict with
    // the user-folder-and-explicit-roots contract. Users can add such folders
    // through ADDITIONAL_INDEX_LOCATIONS.

    let mut seen_roots = HashSet::new();
    locations.retain(|location| {
        let identity = fs::canonicalize(location).unwrap_or_else(|_| location.to_path_buf());
        seen_roots.insert(normalized_path_key(&identity))
    });

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

fn build_index_sync() -> IndexBuildResult {
    build_index_from_locations_with_limits(&get_index_locations(), MAX_INDEX_SIZE, MAX_SCAN_DEPTH)
}

#[cfg(test)]
fn build_index_from_locations(locations: &[PathBuf]) -> Vec<IndexEntry> {
    build_index_from_locations_with_limits(locations, MAX_INDEX_SIZE, MAX_SCAN_DEPTH).entries
}

fn canonical_path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn normalized_path_key(path: &Path) -> String {
    #[cfg(target_os = "windows")]
    {
        canonical_path_string(path)
            .replace('/', "\\")
            .to_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        canonical_path_string(path)
    }
}

fn path_key_is_within(candidate: &str, parent: &str) -> bool {
    if candidate == parent {
        return true;
    }
    #[cfg(target_os = "windows")]
    let separator = '\\';
    #[cfg(not(target_os = "windows"))]
    let separator = '/';
    if parent.ends_with(separator) {
        candidate.starts_with(parent)
    } else {
        candidate.starts_with(&format!("{parent}{separator}"))
    }
}

fn validate_additional_index_location(location: &str) -> Result<PathBuf, String> {
    if location.len() > MAX_ADDITIONAL_INDEX_LOCATION_BYTES {
        return Err(format!(
            "Index location exceeds the {} byte limit",
            MAX_ADDITIONAL_INDEX_LOCATION_BYTES
        ));
    }
    let path = crate::validate_path(location, "Index location")?;
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Index location path contains a parent traversal".to_string());
    }

    let mut existing = path.as_path();
    loop {
        match fs::symlink_metadata(existing) {
            Ok(_) => {
                crate::ensure_no_symlink_components(existing, "Index location")?;
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                existing = existing.parent().ok_or_else(|| {
                    format!(
                        "Cannot find an existing parent for index location {}",
                        path.display()
                    )
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "Cannot inspect index location {}: {}",
                    existing.display(),
                    error
                ));
            }
        }
    }
    Ok(path)
}

/// Validate user-selected index roots without requiring them to exist. Missing
/// removable roots are kept so the subsequent scan can report them as partial.
pub fn validate_additional_index_locations(locations: &[String]) -> Result<(), String> {
    if locations.len() > MAX_ADDITIONAL_INDEX_LOCATIONS {
        return Err(format!(
            "At most {} additional index locations are allowed",
            MAX_ADDITIONAL_INDEX_LOCATIONS
        ));
    }
    let mut total_bytes = 0usize;
    for location in locations {
        total_bytes = total_bytes
            .checked_add(location.len())
            .ok_or_else(|| "Additional index locations exceed the size limit".to_string())?;
        if total_bytes > MAX_ADDITIONAL_INDEX_LOCATIONS_BYTES {
            return Err(format!(
                "Additional index locations exceed the {} byte limit",
                MAX_ADDITIONAL_INDEX_LOCATIONS_BYTES
            ));
        }
        validate_additional_index_location(location)?;
    }
    Ok(())
}

fn additional_index_location_key(location: &str) -> String {
    let path = Path::new(location);
    let identity = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    normalized_path_key(&identity)
}

/// Replace the user-selected roots and stale the current index only if the
/// ordered, canonical root set changed.
pub fn set_additional_index_locations(locations: Vec<String>) -> Result<bool, String> {
    validate_additional_index_locations(&locations)?;

    let mut unique_locations = Vec::with_capacity(locations.len());
    let mut unique_keys = HashSet::new();
    for location in locations {
        if unique_keys.insert(additional_index_location_key(&location)) {
            unique_locations.push(location);
        }
    }

    let current_keys: Vec<_> = ADDITIONAL_INDEX_LOCATIONS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .map(|location| additional_index_location_key(location))
        .collect();
    let next_keys: Vec<_> = unique_locations
        .iter()
        .map(|location| additional_index_location_key(location))
        .collect();
    if current_keys == next_keys {
        return Ok(false);
    }

    *ADDITIONAL_INDEX_LOCATIONS
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = unique_locations;
    request_build_cancel();
    INDEX_BUILD_COORDINATOR.mark_stale();
    Ok(true)
}

fn add_truncation_reason(metadata: &mut IndexMetadata, reason: &str) {
    metadata.truncated = true;
    if !metadata
        .truncation_reasons
        .iter()
        .any(|existing| existing == reason)
    {
        metadata.truncation_reasons.push(reason.to_string());
    }
}

fn directory_has_unindexed_scannable_child(
    path: &Path,
    already_indexed: &HashSet<String>,
    excl_segments: &HashSet<&str>,
    excl_files: &HashSet<&str>,
) -> Result<bool, ()> {
    let children = fs::read_dir(path).map_err(|_| ())?;
    for child in children {
        let child = child.map_err(|_| ())?;
        let child_path = child.path();
        if should_exclude(&child_path, excl_segments, excl_files) {
            continue;
        }
        let metadata = fs::symlink_metadata(&child_path).map_err(|_| ())?;
        if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
            continue;
        }
        if !already_indexed.contains(&normalized_path_key(&child_path)) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn build_index_from_locations_with_limits(
    locations: &[PathBuf],
    max_entries: usize,
    max_depth: usize,
) -> IndexBuildResult {
    let excl_segments = exclude_segments();
    let excl_files = exclude_files();
    let mut entries = Vec::new();
    let mut metadata = IndexMetadata::default();
    let mut seen_roots = HashSet::new();
    let mut completed_roots: Vec<String> = Vec::new();
    let mut seen_entries = HashSet::new();
    let mut scanned = 0usize;

    for location in locations {
        if is_build_cancelled() {
            break;
        }

        let canonical_root = match fs::canonicalize(location) {
            Ok(path) => path,
            Err(error) => {
                log::warn!(
                    "[Indexer] could not resolve root {}: {}",
                    location.display(),
                    error
                );
                let missing_key = normalized_path_key(location);
                if seen_roots.insert(missing_key) {
                    add_truncation_reason(&mut metadata, "readErrors");
                }
                continue;
            }
        };
        let root_key = normalized_path_key(&canonical_root);
        if !seen_roots.insert(root_key.clone()) {
            continue;
        }
        if completed_roots
            .iter()
            .any(|completed| path_key_is_within(&root_key, completed))
        {
            continue;
        }

        metadata
            .indexed_roots
            .push(canonical_path_string(&canonical_root));
        let mut root_complete = true;
        let mut entry_limit_hit = false;

        for entry in WalkDir::new(&canonical_root)
            .max_depth(max_depth)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                if entry.depth() > 0 {
                    let entry_key = normalized_path_key(entry.path());
                    if completed_roots
                        .iter()
                        .any(|completed| completed == &entry_key)
                    {
                        return false;
                    }
                }
                !should_exclude(entry.path(), &excl_segments, &excl_files)
            })
        {
            if is_build_cancelled() {
                break;
            }

            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    log::warn!("[Indexer] walk error: {}", error);
                    add_truncation_reason(&mut metadata, "readErrors");
                    root_complete = false;
                    continue;
                }
            };

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
                Err(error) => {
                    log::warn!("[Indexer] could not inspect {}: {}", path.display(), error);
                    add_truncation_reason(&mut metadata, "readErrors");
                    root_complete = false;
                    continue;
                }
            };
            if meta.file_type().is_symlink() || (!meta.is_file() && !meta.is_dir()) {
                continue;
            }

            let path_key = normalized_path_key(path);
            let already_indexed = seen_entries.contains(&path_key);
            if entries.len() >= max_entries && !already_indexed {
                add_truncation_reason(&mut metadata, "entryLimit");
                root_complete = false;
                entry_limit_hit = true;
                break;
            }

            if entry.depth() == max_depth && meta.is_dir() {
                match directory_has_unindexed_scannable_child(
                    path,
                    &seen_entries,
                    &excl_segments,
                    &excl_files,
                ) {
                    Ok(true) => {
                        add_truncation_reason(&mut metadata, "depthLimit");
                        root_complete = false;
                    }
                    Ok(false) => {}
                    Err(()) => {
                        add_truncation_reason(&mut metadata, "readErrors");
                        root_complete = false;
                    }
                }
            }

            if already_indexed {
                continue;
            }
            seen_entries.insert(path_key);

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

        if root_complete && !is_build_cancelled() {
            completed_roots.push(root_key);
        }
        if entry_limit_hit {
            break;
        }
    }

    IndexBuildResult { entries, metadata }
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
    let dir = crate::ensure_app_state_directory(&dir, "Index directory")?;
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

fn save_index_to_disk(
    path: &Path,
    entries: &[IndexEntry],
    metadata: &IndexMetadata,
) -> Result<(), String> {
    #[derive(serde::Serialize)]
    struct IndexFileDataRef<'a> {
        index: &'a [IndexEntry],
        last_index_time: Option<f64>,
        version: u32,
        metadata: &'a IndexMetadata,
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
        metadata,
    };

    let json = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    if json.len() as u64 > MAX_INDEX_FILE_BYTES {
        return Err(format!(
            "File index exceeds {} byte limit",
            MAX_INDEX_FILE_BYTES
        ));
    }
    let (tmp, mut file) = crate::create_secure_temp_file(path, "index")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Restrict the staging file before any payload is written so a crash
        // cannot leave index data readable under the process umask.
        if let Err(error) = file.set_permissions(fs::Permissions::from_mode(0o600)) {
            drop(file);
            let _ = fs::remove_file(&tmp);
            return Err(format!("Failed to secure index temporary file: {}", error));
        }
    }
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
    INDEX_BUILD_COORDINATOR.mark_stale();
    let idx_path = match index_path(app) {
        Ok(p) => p,
        Err(_) => return,
    };

    if let Some(data) = load_index_from_disk(&idx_path) {
        if let Ok(mut index) = FILE_INDEX.write() {
            index.entries = data.index;
            index.metadata = data.metadata;
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
    // The first indexed search or an explicit rebuild starts the scan.
}

fn prepare_index_build() -> Result<(), String> {
    if !INDEXER_ENABLED.load(Ordering::Relaxed) {
        return Err("Indexer is disabled".to_string());
    }
    // Only a new build may clear a previous cancellation. The coordinator
    // ensures no other build is running when this callback is called.
    set_build_cancelled(false);
    Ok(())
}

fn publish_index(app: &tauri::AppHandle, build: IndexBuildResult) -> Result<(), String> {
    let _commit_guard = BUILD_COMMIT_MUTEX.lock().unwrap_or_else(|poisoned| {
        log::warn!("[Indexer] commit mutex poisoned; recovering");
        poisoned.into_inner()
    });
    if !INDEXER_ENABLED.load(Ordering::Relaxed) {
        return Err("Indexer is disabled".to_string());
    }
    if is_build_cancelled() {
        return Err("Index build was cancelled".to_string());
    }

    let count = build.entries.len();
    {
        let mut index = FILE_INDEX
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        index.entries = build.entries;
        index.metadata = build.metadata;
        index.last_built = Some(chrono::Utc::now().to_rfc3339());
    }

    // Keep disk publication in the same short commit section as the in-memory
    // commit. Disabling the indexer can then never recreate the file afterward.
    if INDEXER_ENABLED.load(Ordering::Relaxed) && !is_build_cancelled() {
        if let Ok(idx_path) = index_path(app) {
            let index = FILE_INDEX
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Err(error) = save_index_to_disk(&idx_path, &index.entries, &index.metadata) {
                log::warn!("Failed to save index to disk: {}", error);
            }
        }
    }

    log::info!("Index build complete: {} entries", count);
    Ok(())
}

fn ensure_index_ready(
    app: &tauri::AppHandle,
    force: bool,
    is_query_cancelled: impl Fn() -> bool,
) -> Result<(), String> {
    let app = app.clone();
    let is_enabled: StatusCheck = Arc::new(|| INDEXER_ENABLED.load(Ordering::Relaxed));
    let is_build_cancelled: StatusCheck = Arc::new(is_build_cancelled);
    let prepare: BuildPreparation = Arc::new(prepare_index_build);
    INDEX_BUILD_COORDINATOR.ensure_ready(
        force,
        is_enabled,
        is_build_cancelled,
        prepare,
        is_query_cancelled,
        || Ok(build_index_sync()),
        move |entries| publish_index(&app, entries),
    )
}

/// Wait until the indexed search view reflects a successful session build.
/// Persisted entries refresh on the first search after launch; later refreshes
/// occur after five minutes of successful session freshness.
pub fn ensure_search_index_ready(
    app: &tauri::AppHandle,
    is_query_cancelled: impl Fn() -> bool,
) -> Result<(), String> {
    ensure_index_ready(app, false, is_query_cancelled)
}

/// Queue a lazy freshness check for existing enable/settings callers.
pub fn ensure_index_built(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let result = INDEX_BUILD_COORDINATOR
            .wait_until_idle(|| INDEXER_ENABLED.load(Ordering::Relaxed))
            .and_then(|()| ensure_index_ready(&app, false, || false));
        if let Err(error) = result {
            log::warn!("Background index refresh failed: {}", error);
        }
    });
}

fn build_index_for_explicit_refresh(app: &tauri::AppHandle) {
    request_build_cancel();
    let result = INDEX_BUILD_COORDINATOR
        .wait_until_idle(|| INDEXER_ENABLED.load(Ordering::Relaxed))
        .and_then(|()| ensure_index_ready(app, true, || false));
    if let Err(error) = result {
        log::warn!("Explicit index rebuild failed: {}", error);
    }
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

pub fn get_status() -> (bool, usize, Option<String>, IndexMetadata) {
    let is_building = INDEX_BUILD_COORDINATOR.is_running();
    match FILE_INDEX.read() {
        Ok(idx) => (
            is_building,
            idx.entries.len(),
            idx.last_built.clone(),
            idx.metadata.clone(),
        ),
        Err(_) => (is_building, 0, None, IndexMetadata::default()),
    }
}

pub async fn trigger_rebuild(app: &tauri::AppHandle) {
    let app_handle = app.clone();
    std::thread::spawn(move || {
        build_index_for_explicit_refresh(&app_handle);
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
    drop(_guard);
    INDEX_BUILD_COORDINATOR.notify_waiters();
}

pub fn set_enabled(enabled: bool, app: Option<&tauri::AppHandle>) {
    let was_enabled = INDEXER_ENABLED.swap(enabled, Ordering::Relaxed);
    if was_enabled != enabled {
        INDEX_BUILD_COORDINATOR.mark_stale();
    }
    if enabled {
        return;
    }
    request_build_cancel();
    if let Ok(mut index) = FILE_INDEX.write() {
        index.entries.clear();
        index.last_built = None;
        index.metadata = IndexMetadata::default();
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
        assert!(!data.metadata.truncated);
        assert!(data.metadata.truncation_reasons.is_empty());
        assert!(data.metadata.indexed_roots.is_empty());
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
    fn index_scan_skips_overlapping_roots_and_deduplicates_canonical_entries() {
        let temp = tempfile::tempdir().unwrap();
        let child = temp.path().join("child");
        fs::create_dir_all(&child).unwrap();
        fs::write(child.join("needle.txt"), "x").unwrap();
        fs::write(temp.path().join("other.txt"), "y").unwrap();

        let result = build_index_from_locations_with_limits(
            &[temp.path().to_path_buf(), child.clone()],
            MAX_INDEX_SIZE,
            MAX_SCAN_DEPTH,
        );

        let paths: HashSet<_> = result
            .entries
            .iter()
            .map(|entry| normalized_path_key(Path::new(&entry.path)))
            .collect();
        assert_eq!(paths.len(), result.entries.len());
        assert!(!result.metadata.truncated);
        assert!(result.metadata.truncation_reasons.is_empty());
        assert_eq!(
            result.metadata.indexed_roots,
            [canonical_path_string(
                &temp.path().canonicalize().expect("canonical temp root")
            )]
        );
    }

    #[test]
    fn index_scan_reports_entry_limit_only_when_an_unique_entry_is_omitted() {
        let exact = tempfile::tempdir().unwrap();
        fs::write(exact.path().join("only.txt"), "x").unwrap();
        let exact_result = build_index_from_locations_with_limits(
            &[exact.path().to_path_buf()],
            2,
            MAX_SCAN_DEPTH,
        );
        assert_eq!(exact_result.entries.len(), 2);
        assert!(!exact_result.metadata.truncated);
        assert!(exact_result.metadata.truncation_reasons.is_empty());

        let over = tempfile::tempdir().unwrap();
        fs::write(over.path().join("one.txt"), "x").unwrap();
        fs::write(over.path().join("two.txt"), "y").unwrap();
        let over_result =
            build_index_from_locations_with_limits(&[over.path().to_path_buf()], 2, MAX_SCAN_DEPTH);
        assert_eq!(over_result.entries.len(), 2);
        assert!(over_result.metadata.truncated);
        assert_eq!(over_result.metadata.truncation_reasons, ["entryLimit"]);
    }

    #[test]
    fn index_scan_reports_depth_and_filesystem_errors_as_partial() {
        let deep = tempfile::tempdir().unwrap();
        let mut directory = deep.path().to_path_buf();
        for level in 0..3 {
            directory.push(format!("level-{level}"));
        }
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("deep.txt"), "x").unwrap();
        let depth_result =
            build_index_from_locations_with_limits(&[deep.path().to_path_buf()], MAX_INDEX_SIZE, 2);
        assert!(depth_result.metadata.truncated);
        assert_eq!(depth_result.metadata.truncation_reasons, ["depthLimit"]);

        let parent = tempfile::tempdir().unwrap();
        let missing = parent.path().join("missing-root");
        let error_result =
            build_index_from_locations_with_limits(&[missing], MAX_INDEX_SIZE, MAX_SCAN_DEPTH);
        assert!(error_result.metadata.truncated);
        assert_eq!(error_result.metadata.truncation_reasons, ["readErrors"]);
    }

    #[test]
    fn index_metadata_persists_and_legacy_index_loads_with_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("file-index.json");
        let metadata = IndexMetadata {
            truncated: true,
            truncation_reasons: vec!["entryLimit".to_string(), "readErrors".to_string()],
            indexed_roots: vec![canonical_path_string(temp.path())],
        };

        save_index_to_disk(&path, &[], &metadata).unwrap();
        let data = load_index_from_disk(&path).expect("new metadata should load");
        assert_eq!(data.metadata.truncated, metadata.truncated);
        assert_eq!(
            data.metadata.truncation_reasons,
            metadata.truncation_reasons
        );
        assert_eq!(data.metadata.indexed_roots, metadata.indexed_roots);
    }

    #[test]
    fn index_locations_include_existing_os_resolved_user_directories() {
        let user_dirs = directories::UserDirs::new().expect("user directories are available");
        let expected: Vec<_> = [
            user_dirs.desktop_dir(),
            user_dirs.document_dir(),
            user_dirs.download_dir(),
            user_dirs.picture_dir(),
            user_dirs.audio_dir(),
            user_dirs.video_dir(),
        ]
        .into_iter()
        .flatten()
        .filter(|path| path.exists())
        .map(canonical_path_string)
        .collect();
        let actual: HashSet<_> = get_index_locations()
            .iter()
            .filter_map(|path| path.canonicalize().ok())
            .map(|path| canonical_path_string(&path))
            .collect();

        // Minimal CI homes may not have any of the standard user folders.
        // In that case there is nothing this host can prove about them.
        if expected.is_empty() {
            return;
        }
        for path in expected {
            assert!(
                actual.contains(&path),
                "missing OS-resolved location {path}"
            );
        }
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

#[cfg(test)]
mod index_lifecycle_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Barrier};
    use std::thread;
    use std::time::{Duration, Instant};

    // Failure modes covered before implementing the lifecycle: initial search
    // reads before a scan publishes; a persisted cache is treated as fresh;
    // an empty successful scan is rebuilt forever; concurrent queries launch
    // duplicate scans; one query's cancellation kills another query's shared
    // scan; disable/build failure leaves waiters hanging or serves stale data;
    // explicit refresh and the five-minute freshness boundary are ignored.
    fn enabled() -> Arc<dyn Fn() -> bool + Send + Sync> {
        Arc::new(|| true)
    }

    fn build_cancelled() -> Arc<dyn Fn() -> bool + Send + Sync> {
        Arc::new(|| false)
    }

    fn prepare() -> Arc<dyn Fn() -> Result<(), String> + Send + Sync> {
        Arc::new(|| Ok(()))
    }

    fn scan(root: PathBuf) -> impl FnOnce() -> Result<Vec<IndexEntry>, String> + Send + 'static {
        move || Ok(build_index_from_locations(&[root]))
    }

    fn publish_to(
        destination: Arc<RwLock<Vec<IndexEntry>>>,
    ) -> impl FnOnce(Vec<IndexEntry>) -> Result<(), String> + Send + 'static {
        move |entries| {
            *destination.write().unwrap() = entries;
            Ok(())
        }
    }

    fn names(entries: &[IndexEntry]) -> Vec<String> {
        entries
            .iter()
            .filter(|entry| entry.is_file)
            .map(|entry| entry.name.clone())
            .collect()
    }

    fn temp_index_root() -> tempfile::TempDir {
        tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap()
    }

    fn test_index_entry(name: &str) -> IndexEntry {
        IndexEntry {
            name: name.to_string(),
            name_lower: name.to_lowercase(),
            path: format!("/tmp/{name}"),
            is_directory: false,
            is_file: true,
            is_hidden: false,
            size: 1,
            modified: 0.0,
        }
    }

    #[test]
    fn first_query_waits_for_temp_filesystem_scan_before_reading_results() {
        let root = temp_index_root();
        fs::write(root.path().join("needle.txt"), "x").unwrap();
        let coordinator = Arc::new(IndexBuildCoordinator::default());
        let published = Arc::new(RwLock::new(Vec::new()));
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let (tx, rx) = mpsc::channel();

        let thread_coordinator = Arc::clone(&coordinator);
        let thread_published = Arc::clone(&published);
        let thread_entered = Arc::clone(&entered);
        let thread_release = Arc::clone(&release);
        let root = root.path().to_path_buf();
        let search = thread::spawn(move || {
            let result = thread_coordinator.ensure_ready(
                false,
                enabled(),
                build_cancelled(),
                prepare(),
                || false,
                move || {
                    thread_entered.wait();
                    thread_release.wait();
                    Ok(build_index_from_locations(&[root]))
                },
                publish_to(thread_published),
            );
            tx.send(result).unwrap();
        });

        entered.wait();
        assert!(
            rx.try_recv().is_err(),
            "search returned before index publication"
        );
        assert!(published.read().unwrap().is_empty());
        release.wait();
        rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        search.join().unwrap();
        assert_eq!(names(&published.read().unwrap()), ["needle.txt"]);
    }

    #[test]
    fn first_session_refresh_reconciles_persisted_additions_and_removals_once() {
        let root = temp_index_root();
        let removed = root.path().join("removed.txt");
        fs::write(&removed, "old").unwrap();
        let published = Arc::new(RwLock::new(vec![test_index_entry("stale.txt")]));
        fs::remove_file(&removed).unwrap();
        fs::write(root.path().join("added.txt"), "new").unwrap();
        let coordinator = IndexBuildCoordinator::default();
        let scans = Arc::new(AtomicUsize::new(0));
        let root_path = root.path().to_path_buf();

        let first_scans = Arc::clone(&scans);
        coordinator
            .ensure_ready(
                false,
                enabled(),
                build_cancelled(),
                prepare(),
                || false,
                move || {
                    first_scans.fetch_add(1, Ordering::SeqCst);
                    scan(root_path)()
                },
                publish_to(Arc::clone(&published)),
            )
            .unwrap();

        assert_eq!(names(&published.read().unwrap()), ["added.txt"]);
        coordinator
            .ensure_ready(
                false,
                enabled(),
                build_cancelled(),
                prepare(),
                || false,
                {
                    let scans = Arc::clone(&scans);
                    move || {
                        scans.fetch_add(1, Ordering::SeqCst);
                        Ok(Vec::new())
                    }
                },
                publish_to(Arc::clone(&published)),
            )
            .unwrap();
        assert_eq!(scans.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn successful_empty_index_is_ready_and_does_not_rebuild_repeatedly() {
        let published = Arc::new(RwLock::new(Vec::new()));
        let coordinator = IndexBuildCoordinator::default();
        let scans = Arc::new(AtomicUsize::new(0));

        for _ in 0..2 {
            let scans = Arc::clone(&scans);
            coordinator
                .ensure_ready(
                    false,
                    enabled(),
                    build_cancelled(),
                    prepare(),
                    || false,
                    move || {
                        scans.fetch_add(1, Ordering::SeqCst);
                        Ok(Vec::new())
                    },
                    publish_to(Arc::clone(&published)),
                )
                .unwrap();
        }
        assert!(published.read().unwrap().is_empty());
        assert_eq!(scans.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn concurrent_queries_share_one_build_and_receive_the_published_index() {
        let root = temp_index_root();
        fs::write(root.path().join("shared.txt"), "x").unwrap();
        let coordinator = Arc::new(IndexBuildCoordinator::default());
        let published = Arc::new(RwLock::new(Vec::new()));
        let started = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let build_count = Arc::new(AtomicUsize::new(0));
        let (first_tx, first_rx) = mpsc::channel();
        let (second_tx, second_rx) = mpsc::channel();

        let first_coordinator = Arc::clone(&coordinator);
        let first_published = Arc::clone(&published);
        let first_started = Arc::clone(&started);
        let first_release = Arc::clone(&release);
        let first_count = Arc::clone(&build_count);
        let first_root = root.path().to_path_buf();
        let first = thread::spawn(move || {
            let result = first_coordinator.ensure_ready(
                false,
                enabled(),
                build_cancelled(),
                prepare(),
                || false,
                move || {
                    first_count.fetch_add(1, Ordering::SeqCst);
                    first_started.wait();
                    first_release.wait();
                    Ok(build_index_from_locations(&[first_root]))
                },
                publish_to(first_published),
            );
            first_tx.send(result).unwrap();
        });

        started.wait();
        let second_coordinator = Arc::clone(&coordinator);
        let second_published = Arc::clone(&published);
        let second_count = Arc::clone(&build_count);
        let second_root = root.path().to_path_buf();
        let second = thread::spawn(move || {
            let result = second_coordinator.ensure_ready(
                false,
                enabled(),
                build_cancelled(),
                prepare(),
                || false,
                move || {
                    second_count.fetch_add(1, Ordering::SeqCst);
                    Ok(build_index_from_locations(&[second_root]))
                },
                publish_to(second_published),
            );
            second_tx.send(result).unwrap();
        });

        thread::sleep(Duration::from_millis(30));
        assert_eq!(build_count.load(Ordering::SeqCst), 1);
        release.wait();
        first_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        second_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        first.join().unwrap();
        second.join().unwrap();
        assert_eq!(build_count.load(Ordering::SeqCst), 1);
        assert_eq!(names(&published.read().unwrap()), ["shared.txt"]);
    }

    #[test]
    fn cancelling_one_waiter_does_not_cancel_the_shared_build_for_another() {
        let root = temp_index_root();
        fs::write(root.path().join("shared.txt"), "x").unwrap();
        let coordinator = Arc::new(IndexBuildCoordinator::default());
        let published = Arc::new(RwLock::new(Vec::new()));
        let started = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let caller_cancelled = Arc::new(AtomicBool::new(false));
        let (owner_tx, owner_rx) = mpsc::channel();
        let (cancelled_tx, cancelled_rx) = mpsc::channel();

        let owner_coordinator = Arc::clone(&coordinator);
        let owner_published = Arc::clone(&published);
        let owner_started = Arc::clone(&started);
        let owner_release = Arc::clone(&release);
        let owner_root = root.path().to_path_buf();
        let owner = thread::spawn(move || {
            let result = owner_coordinator.ensure_ready(
                false,
                enabled(),
                build_cancelled(),
                prepare(),
                || false,
                move || {
                    owner_started.wait();
                    owner_release.wait();
                    Ok(build_index_from_locations(&[owner_root]))
                },
                publish_to(owner_published),
            );
            owner_tx.send(result).unwrap();
        });
        started.wait();

        let waiting_coordinator = Arc::clone(&coordinator);
        let waiting_published = Arc::clone(&published);
        let waiting_cancelled = Arc::clone(&caller_cancelled);
        let waiter = thread::spawn(move || {
            let result = waiting_coordinator.ensure_ready(
                false,
                enabled(),
                build_cancelled(),
                prepare(),
                move || waiting_cancelled.load(Ordering::SeqCst),
                || panic!("a waiter must not start another build"),
                publish_to(waiting_published),
            );
            cancelled_tx.send(result).unwrap();
        });

        thread::sleep(Duration::from_millis(30));
        caller_cancelled.store(true, Ordering::SeqCst);
        assert!(cancelled_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_err());
        assert!(
            owner_rx.try_recv().is_err(),
            "cancelled waiter stopped shared work"
        );
        release.wait();
        owner_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        owner.join().unwrap();
        waiter.join().unwrap();
        assert_eq!(names(&published.read().unwrap()), ["shared.txt"]);
    }

    #[test]
    fn disabling_during_build_releases_waiter_and_never_publishes_stale_entries() {
        let root = temp_index_root();
        fs::write(root.path().join("stale.txt"), "x").unwrap();
        let enabled_state = Arc::new(AtomicBool::new(true));
        let enabled_check: Arc<dyn Fn() -> bool + Send + Sync> = {
            let enabled_state = Arc::clone(&enabled_state);
            Arc::new(move || enabled_state.load(Ordering::SeqCst))
        };
        let coordinator = Arc::new(IndexBuildCoordinator::default());
        let published = Arc::new(RwLock::new(vec![test_index_entry("persisted-stale.txt")]));
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let (tx, rx) = mpsc::channel();

        let thread_coordinator = Arc::clone(&coordinator);
        let thread_published = Arc::clone(&published);
        let thread_entered = Arc::clone(&entered);
        let thread_release = Arc::clone(&release);
        let thread_enabled = Arc::clone(&enabled_state);
        let root = root.path().to_path_buf();
        let search = thread::spawn(move || {
            let result = thread_coordinator.ensure_ready(
                false,
                enabled_check,
                build_cancelled(),
                prepare(),
                || false,
                move || {
                    thread_entered.wait();
                    thread_release.wait();
                    Ok(build_index_from_locations(&[root]))
                },
                move |entries| {
                    if !thread_enabled.load(Ordering::SeqCst) {
                        return Err("Indexer is disabled".to_string());
                    }
                    *thread_published.write().unwrap() = entries;
                    Ok(())
                },
            );
            tx.send(result).unwrap();
        });

        entered.wait();
        enabled_state.store(false, Ordering::SeqCst);
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap().is_err());
        assert_eq!(names(&published.read().unwrap()), ["persisted-stale.txt"]);
        release.wait();
        search.join().unwrap();
    }

    #[test]
    fn build_failure_returns_error_and_a_later_search_can_retry() {
        let coordinator = IndexBuildCoordinator::default();
        let published = Arc::new(RwLock::new(Vec::new()));
        let failed = coordinator.ensure_ready(
            false,
            enabled(),
            build_cancelled(),
            prepare(),
            || false,
            || Err("injected scan failure".to_string()),
            publish_to(Arc::clone(&published)),
        );
        assert_eq!(failed, Err("injected scan failure".to_string()));

        coordinator
            .ensure_ready(
                false,
                enabled(),
                build_cancelled(),
                prepare(),
                || false,
                || Ok(vec![test_index_entry("recovered.txt")]),
                publish_to(Arc::clone(&published)),
            )
            .unwrap();
        assert_eq!(names(&published.read().unwrap()), ["recovered.txt"]);
    }

    #[test]
    fn cancelling_a_shared_build_releases_waiters_without_publishing_cached_entries() {
        let root = temp_index_root();
        fs::write(root.path().join("fresh.txt"), "x").unwrap();
        let build_cancelled_state = Arc::new(AtomicBool::new(false));
        let cancelled_check: Arc<dyn Fn() -> bool + Send + Sync> = {
            let build_cancelled_state = Arc::clone(&build_cancelled_state);
            Arc::new(move || build_cancelled_state.load(Ordering::SeqCst))
        };
        let coordinator = Arc::new(IndexBuildCoordinator::default());
        let published = Arc::new(RwLock::new(vec![test_index_entry("cached-stale.txt")]));
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let (tx, rx) = mpsc::channel();

        let thread_coordinator = Arc::clone(&coordinator);
        let thread_published = Arc::clone(&published);
        let thread_entered = Arc::clone(&entered);
        let thread_release = Arc::clone(&release);
        let thread_cancelled = Arc::clone(&build_cancelled_state);
        let root = root.path().to_path_buf();
        let search = thread::spawn(move || {
            let result = thread_coordinator.ensure_ready(
                false,
                enabled(),
                cancelled_check,
                prepare(),
                || false,
                move || {
                    thread_entered.wait();
                    thread_release.wait();
                    Ok(build_index_from_locations(&[root]))
                },
                move |entries| {
                    if thread_cancelled.load(Ordering::SeqCst) {
                        return Err("Index build was cancelled".to_string());
                    }
                    *thread_published.write().unwrap() = entries;
                    Ok(())
                },
            );
            tx.send(result).unwrap();
        });

        entered.wait();
        build_cancelled_state.store(true, Ordering::SeqCst);
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap().is_err());
        assert_eq!(names(&published.read().unwrap()), ["cached-stale.txt"]);
        release.wait();
        search.join().unwrap();
    }

    #[test]
    fn explicit_rebuild_refreshes_a_fresh_index() {
        let root = temp_index_root();
        fs::write(root.path().join("before.txt"), "x").unwrap();
        let published = Arc::new(RwLock::new(Vec::new()));
        let coordinator = IndexBuildCoordinator::default();
        let scans = Arc::new(AtomicUsize::new(0));
        let root_path = root.path().to_path_buf();
        for force in [false, true] {
            let scans = Arc::clone(&scans);
            let root_path = root_path.clone();
            coordinator
                .ensure_ready(
                    force,
                    enabled(),
                    build_cancelled(),
                    prepare(),
                    || false,
                    move || {
                        scans.fetch_add(1, Ordering::SeqCst);
                        scan(root_path)()
                    },
                    publish_to(Arc::clone(&published)),
                )
                .unwrap();
            if !force {
                fs::write(root.path().join("after.txt"), "x").unwrap();
            }
        }
        assert_eq!(scans.load(Ordering::SeqCst), 2);
        let mut published_names = names(&published.read().unwrap());
        published_names.sort();
        assert_eq!(published_names, ["after.txt", "before.txt"]);
    }

    #[test]
    fn stale_successful_build_is_refreshed_at_five_minutes() {
        let coordinator = IndexBuildCoordinator::default();
        {
            let mut state = coordinator.state.lock().unwrap();
            state.refresh_on_first_search = false;
            state.last_successful_at = Some(Instant::now() - INDEX_REFRESH_INTERVAL);
        }
        let scans = Arc::new(AtomicUsize::new(0));
        let scans_for_build = Arc::clone(&scans);
        coordinator
            .ensure_ready(
                false,
                enabled(),
                build_cancelled(),
                prepare(),
                || false,
                move || {
                    scans_for_build.fetch_add(1, Ordering::SeqCst);
                    Ok(Vec::<IndexEntry>::new())
                },
                |_| Ok(()),
            )
            .unwrap();
        assert_eq!(scans.load(Ordering::SeqCst), 1);
    }
}

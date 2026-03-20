use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::UNIX_EPOCH;
use tauri::Manager;
use walkdir::WalkDir;

const MAX_INDEX_SIZE: usize = 200_000;
const MAX_SCAN_DEPTH: usize = 50;

static FILE_INDEX: std::sync::LazyLock<Arc<RwLock<FileIndex>>> =
    std::sync::LazyLock::new(|| Arc::new(RwLock::new(FileIndex::default())));

static BUILD_CANCEL: std::sync::LazyLock<Mutex<bool>> =
    std::sync::LazyLock::new(|| Mutex::new(false));

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub is_file: bool,
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
        "node_modules", ".git", ".cache", "cache", "caches", ".trash", "trash",
        "$recycle.bin", "system volume information", ".npm", ".docker",
        "appdata", "programdata", "windows", "program files", "program files (x86)",
        "$windows.~bt", "$windows.~ws", "recovery", "perflogs", "library",
        "$winreagent", "config.msi", "msocache", "intel", "nvidia", "amd",
    ].into_iter().collect()
}

fn exclude_files() -> HashSet<&'static str> {
    [
        "pagefile.sys", "hiberfil.sys", "swapfile.sys", "dumpstack.log.tmp",
        "dumpstack.log", ".ds_store", "thumbs.db", "desktop.ini",
        "ntuser.dat", "ntuser.dat.log", "ntuser.dat.log1", "ntuser.dat.log2",
    ].into_iter().collect()
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
        for dir in &["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"] {
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
            if Path::new("/Applications").exists() {
                locations.push(PathBuf::from("/Applications"));
            }
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

    #[cfg(target_os = "macos")]
    {
        if let Ok(entries) = fs::read_dir("/Volumes") {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.to_string_lossy() != "/Volumes/Macintosh HD" {
                    locations.push(p);
                }
            }
        }
    }

    locations
}

fn build_index_sync() -> Vec<IndexEntry> {
    let excl_segments = exclude_segments();
    let excl_files = exclude_files();
    let locations = get_index_locations();
    let mut entries = Vec::new();

    for location in &locations {
        if is_build_cancelled() {
            break;
        }

        for entry in WalkDir::new(location)
            .max_depth(MAX_SCAN_DEPTH)
            .into_iter()
            .filter_entry(|e| !should_exclude(e.path(), &excl_segments, &excl_files))
            .flatten()
        {
            if is_build_cancelled() || entries.len() >= MAX_INDEX_SIZE {
                break;
            }

            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

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

            entries.push(IndexEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_directory: meta.is_dir(),
                is_file: meta.is_file(),
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
    BUILD_CANCEL.lock().map(|g| *g).unwrap_or(false)
}

fn set_build_cancelled(val: bool) {
    if let Ok(mut g) = BUILD_CANCEL.lock() {
        *g = val;
    }
}

fn index_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("file-index.json"))
}

fn load_index_from_disk(path: &Path) -> Option<IndexFileData> {
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_index_to_disk(path: &Path, entries: &[IndexEntry]) -> Result<(), String> {
    let data = IndexFileData {
        index: entries.to_vec(),
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
    let tmp = crate::make_temp_path(path, "index");

    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);

    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
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
            index.last_built = data.last_index_time.map(|t| {
                chrono::DateTime::from_timestamp_millis(t as i64)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default()
            });
            log::info!(
                "Loaded {} index entries from disk",
                index.entries.len()
            );
        }
    }

    let app_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));

        let needs_rebuild = FILE_INDEX
            .read()
            .map(|idx| idx.entries.is_empty())
            .unwrap_or(true);

        if needs_rebuild {
            run_index_build(&app_handle);
        }
    });
}

fn run_index_build(app: &tauri::AppHandle) {
    set_build_cancelled(false);

    if let Ok(mut index) = FILE_INDEX.write() {
        index.is_building = true;
    }

    log::info!("Starting file index build...");
    let entries = build_index_sync();
    let count = entries.len();

    if let Ok(mut index) = FILE_INDEX.write() {
        index.entries = entries;
        index.is_building = false;
        index.last_built = Some(chrono::Utc::now().to_rfc3339());
    }

    if let Ok(idx_path) = index_path(app) {
        if let Ok(index) = FILE_INDEX.read() {
            if let Err(e) = save_index_to_disk(&idx_path, &index.entries) {
                log::warn!("Failed to save index to disk: {}", e);
            }
        }
    }

    log::info!("Index build complete: {} entries", count);
}

pub fn search_in_index(query: &str) -> Vec<IndexEntry> {
    let query_lower = query.to_lowercase();
    let index = match FILE_INDEX.read() {
        Ok(idx) => idx,
        Err(_) => return Vec::new(),
    };

    index
        .entries
        .iter()
        .filter(|e| e.name.to_lowercase().contains(&query_lower))
        .take(10_000)
        .cloned()
        .collect()
}

pub fn get_status() -> (bool, usize, Option<String>) {
    match FILE_INDEX.read() {
        Ok(idx) => (idx.is_building, idx.entries.len(), idx.last_built.clone()),
        Err(_) => (false, 0, None),
    }
}

pub fn trigger_rebuild(app: &tauri::AppHandle) {
    set_build_cancelled(true);
    std::thread::sleep(std::time::Duration::from_millis(100));

    let app_handle = app.clone();
    std::thread::spawn(move || {
        run_index_build(&app_handle);
    });
}

pub fn cancel_build() {
    set_build_cancelled(true);
}

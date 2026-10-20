use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const MAX_THUMBNAIL_BYTES: usize = 10 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CACHE_FILES: usize = 5000;

// Trim scans whole cache dir; batch it, not every save.
const TRIM_EVERY_SAVES: usize = 64;
const TRIM_MIN_INTERVAL_SECS: u64 = 60;
static SAVES_SINCE_TRIM: AtomicUsize = AtomicUsize::new(0);
static LAST_TRIM_SECS: AtomicU64 = AtomicU64::new(0);
// Incremented before clearing so an in-flight save cannot repopulate a cache
// that the user just asked us to remove.
static CACHE_GENERATION: AtomicU64 = AtomicU64::new(0);
// Serializes the short rename/trim and clear critical sections. Thumbnail
// payloads are written before taking this lock, so normal saves do not block
// one another on disk I/O; the lock only makes clear-vs-rename atomic.
static CACHE_MUTATION_LOCK: std::sync::LazyLock<Mutex<()>> =
    std::sync::LazyLock::new(|| Mutex::new(()));

fn cache_lock() -> MutexGuard<'static, ()> {
    CACHE_MUTATION_LOCK.lock().unwrap_or_else(|poisoned| {
        log::warn!("[Thumbnails] cache mutation mutex poisoned, recovering");
        poisoned.into_inner()
    })
}

fn cache_dir_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("thumbnails");
    crate::ensure_app_state_directory(&dir, "Thumbnail cache directory")
}

fn ensure_cache_dir(dir: &Path) -> Result<(), String> {
    crate::ensure_app_state_directory(dir, "Thumbnail cache directory").map(|_| ())
}

#[cfg(test)]
fn cache_key(file_path: &str, mtime_ms: u64, size: u64) -> String {
    cache_key_with_variant(file_path, mtime_ms, size, None)
}

fn cache_key_with_variant(
    file_path: &str,
    mtime_ms: u64,
    size: u64,
    variant: Option<&str>,
) -> String {
    use sha2::{Digest, Sha256};
    // Include mtime and size so a modified file doesn't serve a stale thumbnail.
    let input = match variant {
        Some(variant) => format!("{}|{}|{}|{}", file_path, mtime_ms, size, variant),
        None => format!("{}|{}|{}", file_path, mtime_ms, size),
    };
    let hash = Sha256::digest(input.as_bytes());
    hex::encode(&hash[..16])
}

fn trim_cache_if_needed(dir: &Path) -> Result<(), String> {
    let mut entries: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total_bytes = 0u64;

    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(value) => value,
            Err(error) => {
                log::warn!("[Thumbnails] cache entry error: {}", error);
                continue;
            }
        };
        let file_type = match entry.file_type() {
            Ok(value) => value,
            Err(error) => {
                log::warn!("[Thumbnails] cache entry type error: {}", error);
                continue;
            }
        };
        if !file_type.is_file() {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(value) => value,
            Err(error) => {
                log::warn!("[Thumbnails] cache metadata error: {}", error);
                continue;
            }
        };
        let modified = metadata
            .modified()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        total_bytes = total_bytes.saturating_add(metadata.len());
        entries.push((entry.path(), metadata.len(), modified));
    }

    let mut file_count = entries.len();

    if total_bytes <= MAX_CACHE_BYTES && file_count <= MAX_CACHE_FILES {
        return Ok(());
    }

    entries.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in entries {
        if total_bytes <= MAX_CACHE_BYTES && file_count <= MAX_CACHE_FILES {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total_bytes = total_bytes.saturating_sub(size);
            file_count -= 1;
        }
    }
    Ok(())
}

fn open_thumbnail_read(path: &Path) -> Result<fs::File, String> {
    crate::file_operations::open_regular_read(path)
}

/// Rate-limited trim_cache_if_needed: only after batch of saves or interval.
fn maybe_trim_cache(dir: &Path) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let saves = SAVES_SINCE_TRIM.fetch_add(1, Ordering::Relaxed) + 1;
    let last = LAST_TRIM_SECS.load(Ordering::Relaxed);
    let due_by_count = saves >= TRIM_EVERY_SAVES;
    let due_by_time = now.saturating_sub(last) >= TRIM_MIN_INTERVAL_SECS;

    if !due_by_count && !due_by_time {
        return;
    }

    SAVES_SINCE_TRIM.store(0, Ordering::Relaxed);
    LAST_TRIM_SECS.store(now, Ordering::Relaxed);
    if let Err(e) = trim_cache_if_needed(dir) {
        log::warn!("[Thumbnails] cache trim failed: {}", e);
    }
}

#[tauri::command]
pub async fn get_cached_thumbnail(
    app: tauri::AppHandle,
    file_path: String,
    mtime_ms: Option<u64>,
    file_size: Option<u64>,
    variant: Option<String>,
) -> Result<Option<String>, String> {
    let dir = cache_dir_path(&app)?;
    tokio::task::spawn_blocking(move || {
        get_cached_thumbnail_at_with_variant(
            &dir,
            &file_path,
            mtime_ms,
            file_size,
            variant.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
fn get_cached_thumbnail_at(
    dir: &Path,
    file_path: &str,
    mtime_ms: Option<u64>,
    file_size: Option<u64>,
) -> Result<Option<String>, String> {
    get_cached_thumbnail_at_with_variant(dir, file_path, mtime_ms, file_size, None)
}

fn get_cached_thumbnail_at_with_variant(
    dir: &Path,
    file_path: &str,
    mtime_ms: Option<u64>,
    file_size: Option<u64>,
    variant: Option<&str>,
) -> Result<Option<String>, String> {
    // Windows cannot remove an open file. Serialize the bounded cache read
    // with clear/rename so clearing never races a live file handle.
    let _cache_guard = cache_lock();
    ensure_cache_dir(dir)?;
    // Key on the same caller-supplied mtime/size that save uses, so the read
    // and write keys are byte-identical (no cross-path float/units mismatch).
    let key = cache_key_with_variant(
        file_path,
        mtime_ms.unwrap_or(0),
        file_size.unwrap_or(0),
        variant,
    );
    let thumb_path = dir.join(&key);

    let metadata = match fs::symlink_metadata(&thumb_path) {
        Ok(metadata) if metadata.file_type().is_file() => metadata,
        Ok(_) => return Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if metadata.len() > MAX_THUMBNAIL_BYTES as u64 {
        let _ = fs::remove_file(&thumb_path);
        return Ok(None);
    }
    let file = open_thumbnail_read(&thumb_path)?;
    let mut data = String::new();
    file.take((MAX_THUMBNAIL_BYTES as u64).saturating_add(1))
        .read_to_string(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() > MAX_THUMBNAIL_BYTES {
        let _ = fs::remove_file(&thumb_path);
        return Ok(None);
    }
    Ok(Some(data))
}

fn thumbnail_temp_path(dir: &Path, key: &str) -> Result<PathBuf, String> {
    let parent = dir
        .parent()
        .ok_or_else(|| "Thumbnail cache directory has no parent".to_string())?;
    // Stage beside the cache directory, on the same filesystem. An open temp
    // handle therefore cannot make remove_dir_all(cache) fail on Windows, and
    // rename remains atomic because it does not cross filesystems.
    let base = parent.join(format!(".iyeris-thumbnail-{}", key));
    Ok(crate::make_temp_path(&base, "thumb"))
}

fn write_temporary_file(
    path: &Path,
    write: impl FnOnce(&mut fs::File) -> Result<(), String>,
) -> Result<PathBuf, String> {
    // Reserve a unique sibling with create_new. Never open a predictable
    // temporary path with File::create: a pre-planted symlink could redirect
    // the cache write.
    let (actual_path, mut file) = crate::create_secure_temp_file(path, "thumb")?;
    let result = write(&mut file);
    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(&actual_path);
    }
    result.map(|()| actual_path)
}

#[tauri::command]
pub async fn save_cached_thumbnail(
    app: tauri::AppHandle,
    file_path: String,
    data_url: String,
    mtime_ms: Option<u64>,
    file_size: Option<u64>,
    variant: Option<String>,
) -> Result<(), String> {
    let dir = cache_dir_path(&app)?;
    tokio::task::spawn_blocking(move || {
        save_cached_thumbnail_at_with_variant(
            &dir,
            &file_path,
            &data_url,
            mtime_ms,
            file_size,
            variant.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
fn save_cached_thumbnail_at(
    dir: &Path,
    file_path: &str,
    data_url: &str,
    mtime_ms: Option<u64>,
    file_size: Option<u64>,
) -> Result<(), String> {
    save_cached_thumbnail_at_with_variant(dir, file_path, data_url, mtime_ms, file_size, None)
}

fn save_cached_thumbnail_at_with_variant(
    dir: &Path,
    file_path: &str,
    data_url: &str,
    mtime_ms: Option<u64>,
    file_size: Option<u64>,
    variant: Option<&str>,
) -> Result<(), String> {
    if data_url.len() > MAX_THUMBNAIL_BYTES {
        return Err("Thumbnail payload too large".to_string());
    }
    let generation = CACHE_GENERATION.load(Ordering::Acquire);
    let key = cache_key_with_variant(
        file_path,
        mtime_ms.unwrap_or(0),
        file_size.unwrap_or(0),
        variant,
    );
    let thumb_path = dir.join(&key);

    // Atomic write (temp + rename) so concurrent saves / cache trims can't
    // leave a truncated file that get_cached_thumbnail would later return.
    {
        let _cache_guard = cache_lock();
        ensure_cache_dir(dir)?;
    }
    let tmp_base = thumbnail_temp_path(dir, &key)?;
    let tmp = write_temporary_file(&tmp_base, |file| {
        file.write_all(data_url.as_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })?;
    let _mutation_guard = cache_lock();
    if CACHE_GENERATION.load(Ordering::Acquire) != generation {
        let _ = fs::remove_file(&tmp);
        return Ok(());
    }
    if let Err(error) = ensure_cache_dir(dir) {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    crate::atomic_replace_file(&tmp, &thumb_path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    maybe_trim_cache(dir);
    Ok(())
}

#[tauri::command]
pub async fn clear_thumbnail_cache(app: tauri::AppHandle) -> Result<(), String> {
    let dir = cache_dir_path(&app)?;
    tokio::task::spawn_blocking(move || clear_thumbnail_cache_at(&dir))
        .await
        .map_err(|e| e.to_string())?
}

fn clear_thumbnail_cache_at(dir: &Path) -> Result<(), String> {
    let _mutation_guard = cache_lock();
    CACHE_GENERATION.fetch_add(1, Ordering::AcqRel);
    match fs::symlink_metadata(dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            fs::remove_file(dir).map_err(|e| e.to_string())?;
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(format!(
                "Refusing to clear unsafe thumbnail cache path: {}",
                dir.display()
            ));
        }
        Ok(_) => fs::remove_dir_all(dir).map_err(|e| e.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    ensure_cache_dir(dir)?;
    // A save may have observed the first generation bump while clear was
    // still removing/recreating the directory. Bump again after the directory
    // is ready so that such a save cannot rename a temp file into the fresh
    // cache.
    CACHE_GENERATION.fetch_add(1, Ordering::AcqRel);
    Ok(())
}

#[derive(serde::Serialize)]
pub struct ThumbnailCacheInfo {
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "fileCount")]
    pub file_count: u64,
}

#[tauri::command]
pub async fn get_thumbnail_cache_size(app: tauri::AppHandle) -> Result<ThumbnailCacheInfo, String> {
    let dir = cache_dir_path(&app)?;
    tokio::task::spawn_blocking(move || get_thumbnail_cache_size_at(&dir))
        .await
        .map_err(|e| e.to_string())?
}

fn get_thumbnail_cache_size_at(dir: &Path) -> Result<ThumbnailCacheInfo, String> {
    let _cache_guard = cache_lock();
    ensure_cache_dir(dir)?;
    let mut total = 0u64;
    let mut count = 0u64;
    let entries = fs::read_dir(dir).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = match entry {
            Ok(value) => value,
            Err(error) => {
                log::warn!("[Thumbnails] cache dir entry error: {}", error);
                continue;
            }
        };
        // lstat the path instead of metadata() so a replaced cache symlink
        // cannot make the UI follow an arbitrary external target while
        // calculating size.
        let meta = match fs::symlink_metadata(entry.path()) {
            Ok(value) => value,
            Err(error) => {
                log::warn!("[Thumbnails] cache metadata error: {}", error);
                continue;
            }
        };
        if !meta.is_file() || meta.file_type().is_symlink() {
            continue;
        }
        total = total.saturating_add(meta.len());
        count += 1;
    }
    Ok(ThumbnailCacheInfo {
        size_bytes: total,
        file_count: count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_LOCK: std::sync::LazyLock<Mutex<()>> = std::sync::LazyLock::new(|| Mutex::new(()));

    #[test]
    fn path_helpers_save_read_measure_and_clear() {
        let _test_guard = TEST_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("thumbnails");
        let payload = "data:image/png;base64,c2FmZQ==";

        save_cached_thumbnail_at(&dir, "/tmp/image.png", payload, Some(10), Some(20)).unwrap();
        assert_eq!(
            get_cached_thumbnail_at(&dir, "/tmp/image.png", Some(10), Some(20)).unwrap(),
            Some(payload.to_string())
        );
        assert_eq!(
            get_cached_thumbnail_at(&dir, "/tmp/image.png", Some(11), Some(20)).unwrap(),
            None
        );

        let info = get_thumbnail_cache_size_at(&dir).unwrap();
        assert_eq!(info.file_count, 1);
        assert_eq!(info.size_bytes, payload.len() as u64);

        clear_thumbnail_cache_at(&dir).unwrap();
        let info = get_thumbnail_cache_size_at(&dir).unwrap();
        assert_eq!(info.file_count, 0);
        assert_eq!(info.size_bytes, 0);
    }

    #[test]
    fn path_helpers_report_payload_and_filesystem_failures() {
        let _test_guard = TEST_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("thumbnails");
        let oversized = "x".repeat(MAX_THUMBNAIL_BYTES + 1);
        assert_eq!(
            save_cached_thumbnail_at(&dir, "file", &oversized, None, None).unwrap_err(),
            "Thumbnail payload too large"
        );

        fs::write(&dir, b"not a directory").unwrap();
        assert!(get_cached_thumbnail_at(&dir, "file", None, None).is_err());
        assert!(save_cached_thumbnail_at(&dir, "file", "data:safe", None, None).is_err());
        assert!(get_thumbnail_cache_size_at(&dir).is_err());
        assert!(clear_thumbnail_cache_at(&dir).is_err());
    }

    #[test]
    fn temporary_write_failure_removes_partial_file() {
        let _test_guard = TEST_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("partial.tmp");
        let result = write_temporary_file(&path, |file| {
            file.write_all(b"partial").map_err(|e| e.to_string())?;
            Err("forced write failure".to_string())
        });

        assert_eq!(result.unwrap_err(), "forced write failure");
        assert!(!path.exists());
    }

    #[test]
    fn oversized_cached_file_is_rejected_and_removed() {
        let _test_guard = TEST_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("thumbnails");
        ensure_cache_dir(&dir).unwrap();
        let key = cache_key("/tmp/oversized.png", 1, 2);
        let cached = dir.join(&key);
        fs::write(&cached, vec![b'x'; MAX_THUMBNAIL_BYTES + 1]).unwrap();

        assert_eq!(
            get_cached_thumbnail_at(&dir, "/tmp/oversized.png", Some(1), Some(2)).unwrap(),
            None
        );
        assert!(!cached.exists());
    }

    #[test]
    fn clear_does_not_conflict_with_open_staging_file() {
        let _test_guard = TEST_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("thumbnails");
        ensure_cache_dir(&dir).unwrap();
        fs::write(dir.join("cached"), b"old").unwrap();

        let staging = thumbnail_temp_path(&dir, "pending").unwrap();
        let mut open_staging_file = fs::File::create(&staging).unwrap();
        open_staging_file.write_all(b"pending").unwrap();

        clear_thumbnail_cache_at(&dir).unwrap();
        assert!(dir.is_dir());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);

        drop(open_staging_file);
        fs::remove_file(staging).unwrap();
    }
}

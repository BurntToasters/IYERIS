use crate::cancellation::{is_cancelled, CancellationRegistry, CancellationToken};
use crate::undo;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{ErrorKind, Read, Seek};
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::process::Command;
use std::sync::Mutex;
use std::sync::TryLockError;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

/// Open a regular file without following a final symlink. The path is
/// canonicalized before this helper is called, but the final component can
/// still be swapped by another process between validation and open.
pub(crate) fn open_regular_read(path: &Path) -> Result<fs::File, String> {
    // Reject device files/FIFOs before opening. A blocking open on a FIFO can
    // otherwise hang a renderer worker forever, and device reads can expose
    // unbounded or sensitive streams. The post-open check covers a final
    // component replacement between lstat and open.
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Refusing to read a non-regular file".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "linux")]
        const O_NOFOLLOW: i32 = 0x20000;
        #[cfg(target_os = "linux")]
        const O_NONBLOCK: i32 = 0x800;
        #[cfg(target_os = "macos")]
        const O_NOFOLLOW: i32 = 0x100;
        #[cfg(target_os = "macos")]
        const O_NONBLOCK: i32 = 0x4;
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        const O_NOFOLLOW: i32 = 0;
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        const O_NONBLOCK: i32 = 0;
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(O_NOFOLLOW | O_NONBLOCK)
            .open(path)
            .map_err(|error| error.to_string())?;
        let opened_metadata = file.metadata().map_err(|error| error.to_string())?;
        if !opened_metadata.is_file() {
            return Err("Refusing to read a non-regular file".to_string());
        }
        Ok(file)
    }
    #[cfg(target_os = "windows")]
    {
        // OPEN_REPARSE_POINT prevents a final Windows symlink/junction from
        // being followed between lstat and open. Reject reparse-point handles
        // after opening as an additional race-safe check.
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|error| error.to_string())?;
        let opened_metadata = file.metadata().map_err(|error| error.to_string())?;
        if opened_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || !opened_metadata.is_file()
        {
            return Err("Refusing to read a non-regular file".to_string());
        }
        Ok(file)
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Refusing to read a non-regular file".to_string());
        }
        fs::File::open(path).map_err(|error| error.to_string())
    }
}

static ACTIVE_CHECKSUMS: std::sync::LazyLock<CancellationRegistry> =
    std::sync::LazyLock::new(CancellationRegistry::default);
static ACTIVE_DUPLICATE_SCANS: std::sync::LazyLock<CancellationRegistry> =
    std::sync::LazyLock::new(CancellationRegistry::default);
// File copies/moves can spend seconds in recursive scans. Keep cancellation
// reads lock-free in those hot loops; the registry mutex is touched only when
// an operation is registered, cancelled, or finished.
static ACTIVE_FILE_OPERATIONS: std::sync::LazyLock<CancellationRegistry> =
    std::sync::LazyLock::new(CancellationRegistry::default);

static FILE_OP_LOCK: std::sync::LazyLock<Mutex<()>> = std::sync::LazyLock::new(|| Mutex::new(()));

/// Serialize every filesystem mutation (including undo/redo). Poison is
/// recoverable: a panic must not permanently disable file operations.
pub(crate) fn mutation_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    FILE_OP_LOCK.lock().or_else(|poisoned| {
        log::warn!("[FileOps] mutation lock poisoned; recovering");
        Ok(poisoned.into_inner())
    })
}

/// Wait for the mutation lock in short intervals so queued file operations can
/// observe cancellation without first entering the serialized mutation phase.
pub(crate) fn mutation_lock_cancellable(
    token: Option<&CancellationToken>,
) -> Result<std::sync::MutexGuard<'static, ()>, String> {
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(10);
    loop {
        if is_cancelled(token) {
            return Err("Operation cancelled".to_string());
        }
        match FILE_OP_LOCK.try_lock() {
            Ok(guard) => {
                if is_cancelled(token) {
                    drop(guard);
                    return Err("Operation cancelled".to_string());
                }
                return Ok(guard);
            }
            Err(TryLockError::WouldBlock) => std::thread::sleep(POLL_INTERVAL),
            Err(TryLockError::Poisoned(poisoned)) => {
                log::warn!("[FileOps] mutation lock poisoned; recovering");
                let guard = poisoned.into_inner();
                if is_cancelled(token) {
                    drop(guard);
                    return Err("Operation cancelled".to_string());
                }
                return Ok(guard);
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn try_mutation_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    FILE_OP_LOCK.try_lock().map_err(|error| error.to_string())
}

const DEFAULT_READ_FILE_CONTENT_LIMIT_BYTES: u64 = 10 * 1024 * 1024;
const MAX_READ_FILE_CONTENT_LIMIT_BYTES: u64 = 64 * 1024 * 1024;
const DEFAULT_FILE_DATA_URL_LIMIT_BYTES: u64 = 50 * 1024 * 1024;
const MAX_FILE_DATA_URL_LIMIT_BYTES: u64 = 50 * 1024 * 1024;
const MAX_MUTATION_ITEMS: usize = 10_000;
const MAX_MUTATION_PATH_BYTES: usize = 8 * 1024 * 1024;
const MAX_CLIPBOARD_TEXT_BYTES: usize = 16 * 1024 * 1024;
const SENSITIVE_READ_DIR_NAMES: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".docker",
    ".kube",
    ".password-store",
    "keychains",
];
const SENSITIVE_READ_FILE_NAMES: &[&str] = &[
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    "authorized_keys",
    "known_hosts",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "login.keychain",
];
const SENSITIVE_READ_EXTENSIONS: &[&str] = &["pem", "key", "pfx", "p12"];

fn validate_mutation_list<T: AsRef<str>>(paths: &[T], label: &str) -> Result<(), String> {
    if paths.len() > MAX_MUTATION_ITEMS {
        return Err(format!(
            "{} contains too many items (max {})",
            label, MAX_MUTATION_ITEMS
        ));
    }
    let total_bytes: usize = paths.iter().map(|path| path.as_ref().len()).sum();
    if total_bytes > MAX_MUTATION_PATH_BYTES {
        return Err(format!(
            "{} paths exceed aggregate size limit (max {} bytes)",
            label, MAX_MUTATION_PATH_BYTES
        ));
    }
    Ok(())
}

fn validate_conflict_resolutions(
    resolutions: Option<&HashMap<String, String>>,
) -> Result<(), String> {
    let Some(resolutions) = resolutions else {
        return Ok(());
    };
    if resolutions.len() > MAX_MUTATION_ITEMS {
        return Err(format!(
            "Conflict resolutions contain too many items (max {})",
            MAX_MUTATION_ITEMS
        ));
    }
    let total_bytes = resolutions.iter().fold(0usize, |total, (name, choice)| {
        total
            .saturating_add(name.len())
            .saturating_add(choice.len())
    });
    if total_bytes > MAX_MUTATION_PATH_BYTES {
        return Err(format!(
            "Conflict resolutions exceed aggregate size limit (max {} bytes)",
            MAX_MUTATION_PATH_BYTES
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn resolve_windows_shortcut_on_com_thread(path: &Path) -> Result<String, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::{Interface, PCWSTR},
        Win32::{
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ,
            },
            UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH},
        },
    };

    // This function always runs on a new thread, so it owns the COM apartment.
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|error| format!("Failed to initialize Windows COM: {error}"))?;

    let result = (|| unsafe {
        let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| format!("Failed to create Windows shortcut reader: {error}"))?;
        let persist_file: IPersistFile = shell_link
            .cast()
            .map_err(|error| format!("Failed to load Windows shortcut reader: {error}"))?;
        let shortcut_path: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        persist_file
            .Load(PCWSTR(shortcut_path.as_ptr()), STGM_READ)
            .map_err(|error| format!("Failed to load shortcut: {error}"))?;

        // Windows supports extended-length paths up to 32,767 UTF-16 code units.
        let mut target = vec![0u16; 32_768];
        shell_link
            .GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
            .map_err(|error| format!("Failed to read shortcut target: {error}"))?;
        let length = target
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(target.len());
        let target = String::from_utf16_lossy(&target[..length]);
        if target.is_empty() {
            return Err("Shortcut target path is empty.".to_string());
        }
        Ok(target)
    })();

    unsafe { CoUninitialize() };
    result
}

#[cfg(target_os = "windows")]
fn resolve_windows_shortcut(path: &Path) -> Result<String, String> {
    let path = path.to_path_buf();
    std::thread::Builder::new()
        .name("iyeris-shortcut-reader".to_string())
        .spawn(move || resolve_windows_shortcut_on_com_thread(&path))
        .map_err(|error| format!("Failed to start shortcut reader: {error}"))?
        .join()
        .map_err(|_| "Shortcut reader thread panicked.".to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemProperties {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub symlink_target: Option<String>,
    pub is_shortcut: Option<bool>,
    pub shortcut_target: Option<String>,
    pub is_hidden: bool,
    pub readonly: bool,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub is_hidden_attr: Option<bool>,
    pub is_system_attr: Option<bool>,
    pub mac_tags: Option<Vec<String>>,
    pub created: f64,
    pub modified: f64,
    pub accessed: f64,
    pub extension: String,
    /// Unix mode bits. None on Windows, where POSIX permissions do not apply.
    pub permissions: Option<u32>,
    /// Allocated bytes on disk. Files only. None when the platform query fails.
    pub size_on_disk: Option<u64>,
    /// Sniffed from the first 8 KB, falling back to the extension. Files only.
    pub mime_type: Option<String>,
    /// Friendly name (or executable stem) of the default handler. Windows only.
    pub opens_with: Option<String>,
    pub owner_name: Option<String>,
    pub group_name: Option<String>,
    pub is_archive_attr: Option<bool>,
    pub is_compressed_attr: Option<bool>,
    pub is_encrypted_attr: Option<bool>,
    pub is_indexed_attr: Option<bool>,
}

/// Bytes read from the start of a file for MIME sniffing.
const MIME_SNIFF_BYTES: u64 = 8 * 1024;

/// Best-effort MIME type: content sniffing first, then a small extension table.
/// Sensitive paths (see `ensure_safe_preview_read_path`) are never read or
/// name-guessed, so they yield None instead of an error.
fn detect_item_mime_type(path: &Path) -> Option<String> {
    ensure_safe_preview_read_path(path).ok()?;
    let sniffed = (|| {
        let canonical = path.canonicalize().ok()?;
        let file = open_regular_read(&canonical).ok()?;
        let mut buffer = Vec::with_capacity(MIME_SNIFF_BYTES as usize);
        file.take(MIME_SNIFF_BYTES).read_to_end(&mut buffer).ok()?;
        infer::get(&buffer).map(|kind| kind.mime_type().to_string())
    })();
    sniffed.or_else(|| {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "svg" => "image/svg+xml",
            "ico" => "image/x-icon",
            "pdf" => "application/pdf",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            "mp3" => "audio/mpeg",
            "ogg" => "audio/ogg",
            "wav" => "audio/wav",
            "flac" => "audio/flac",
            "zip" => "application/zip",
            "json" => "application/json",
            "xml" => "application/xml",
            "html" | "htm" => "text/html",
            "css" => "text/css",
            "js" => "text/javascript",
            "txt" | "log" | "ini" | "cfg" => "text/plain",
            "md" => "text/markdown",
            "csv" => "text/csv",
            _ => return None,
        };
        Some(mime.to_string())
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub size: u64,
    pub hash: String,
    pub paths: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateFindResult {
    pub groups: Vec<DuplicateGroup>,
    pub partial: bool,
}

enum OpenTarget {
    FilePath(PathBuf),
    External(String),
}

pub(crate) fn ensure_safe_preview_read_path(path: &Path) -> Result<(), String> {
    fn check_path(path: &Path) -> Result<(), String> {
        for component in path.components() {
            let std::path::Component::Normal(value) = component else {
                continue;
            };
            let name = value.to_string_lossy().to_lowercase();
            if SENSITIVE_READ_DIR_NAMES.contains(&name.as_str())
                || SENSITIVE_READ_FILE_NAMES.contains(&name.as_str())
            {
                return Err(format!(
                    "Preview blocked for sensitive path component: {}",
                    value.to_string_lossy()
                ));
            }
        }
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if SENSITIVE_READ_EXTENSIONS.contains(&ext.to_lowercase().as_str()) {
                return Err("Preview blocked for sensitive file type".to_string());
            }
        }
        Ok(())
    }

    // Check the user-visible path first, then the resolved target. The latter
    // closes the symlink escape where a harmless-looking link points into .ssh
    // or to a key/certificate file. Keep lexical checking for missing paths so
    // callers receive the same policy error before an eventual I/O error.
    check_path(path)?;
    if let Ok(canonical) = path.canonicalize() {
        check_path(&canonical)?;
    }
    Ok(())
}

pub(crate) fn validate_child_name(raw_name: &str, label: &str) -> Result<String, String> {
    let name = raw_name.trim();
    if name.is_empty() {
        return Err(format!("{} is required", label));
    }
    if name == "." || name == ".." {
        return Err(format!("{} cannot be '.' or '..'", label));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(format!(
            "{} cannot contain path separators or null bytes",
            label
        ));
    }
    if name.len() > 255 {
        return Err(format!("{} is too long (max 255 characters)", label));
    }

    #[cfg(target_os = "windows")]
    {
        let invalid_chars = ['<', '>', ':', '"', '|', '?', '*'];
        if name.chars().any(|ch| invalid_chars.contains(&ch)) {
            return Err(format!("{} contains invalid Windows characters", label));
        }
        if name.ends_with('.') {
            return Err(format!("{} cannot end with a period on Windows", label));
        }
        let base_upper = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let reserved = [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ];
        if reserved.contains(&base_upper.as_str()) {
            return Err(format!("{} uses a reserved Windows filename", label));
        }
    }

    Ok(name.to_string())
}

fn parse_file_uri_path(raw_value: &str) -> Result<PathBuf, String> {
    let normalized =
        decode_file_uri_path(raw_value).ok_or_else(|| "Invalid file URI".to_string())?;
    crate::validate_existing_path(&normalized, "File URI")
}

fn parse_open_target(file_path: &str) -> Result<OpenTarget, String> {
    let value = file_path.trim();
    if value.is_empty() {
        return Err("File path is required".to_string());
    }

    let value_lower = value.to_ascii_lowercase();
    if value_lower.starts_with("http://")
        || value_lower.starts_with("https://")
        || value_lower.starts_with("mailto:")
    {
        return Ok(OpenTarget::External(value.to_string()));
    }
    if value_lower.starts_with("file://") {
        return Ok(OpenTarget::FilePath(parse_file_uri_path(value)?));
    }
    if value.contains("://") {
        return Err("Unsupported URL scheme".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let mut chars = value.chars();
        if let (Some(first), Some(':')) = (chars.next(), chars.next()) {
            if first.is_ascii_alphabetic() {
                let path = crate::validate_existing_path(value, "File")?;
                return Ok(OpenTarget::FilePath(path));
            }
        }
    }

    Ok(OpenTarget::FilePath(crate::validate_existing_path(
        value, "File",
    )?))
}

fn resolve_item_is_directory(path: &Path, meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        fs::metadata(path)
            .map(|target| target.is_dir())
            .unwrap_or(false)
    } else {
        meta.is_dir()
    }
}

fn read_file_chunks<FChunk, FActive, FProgress>(
    file: &mut fs::File,
    file_size: u64,
    mut on_chunk: FChunk,
    mut is_active: FActive,
    mut emit_progress: FProgress,
) -> Result<(), String>
where
    FChunk: FnMut(&[u8]),
    FActive: FnMut() -> Result<bool, String>,
    FProgress: FnMut(f64),
{
    let mut buf = [0u8; 8192];
    let mut read_total = 0u64;
    let mut next_progress_emit = 1024_u64 * 1024;
    file.seek(std::io::SeekFrom::Start(0))
        .map_err(|e| e.to_string())?;

    loop {
        if !is_active()? {
            return Err("Checksum cancelled".to_string());
        }

        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }

        let n_u64 = n as u64;
        if read_total.saturating_add(n_u64) > file_size {
            return Err("File changed while hashing; retry checksum".to_string());
        }

        on_chunk(&buf[..n]);
        read_total += n_u64;

        if read_total >= next_progress_emit || read_total == file_size {
            let percent = if file_size > 0 {
                (read_total as f64 / file_size as f64) * 100.0
            } else {
                100.0
            };
            emit_progress(percent);
            while next_progress_emit <= read_total {
                next_progress_emit += 1024_u64 * 1024;
            }
        }
    }

    if read_total != file_size {
        return Err("File changed while hashing; retry checksum".to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn open_file(file_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || open_file_sync(file_path))
        .await
        .map_err(|e| e.to_string())?
}

fn open_file_sync(file_path: String) -> Result<(), String> {
    log::debug!("[FileOps] open_file: {}", file_path);
    match parse_open_target(&file_path)? {
        OpenTarget::FilePath(path) => {
            #[cfg(target_os = "macos")]
            return crate::native_macos::open_path(&path);

            #[cfg(target_os = "windows")]
            return crate::native_windows::open_path(&path);

            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            open::that(&path).map_err(|e| format!("Failed to open file: {}", e))
        }
        OpenTarget::External(url) => {
            #[cfg(target_os = "macos")]
            return crate::native_macos::open_url(&url);

            #[cfg(target_os = "windows")]
            return crate::native_windows::open_uri(&url);

            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            open::that(url).map_err(|e| format!("Failed to open URL: {}", e))
        }
    }
}

#[tauri::command]
pub async fn create_folder(parent_path: String, folder_name: String) -> Result<String, String> {
    log::debug!("[FileOps] create_folder: {}/{}", parent_path, folder_name);
    tokio::task::spawn_blocking(move || {
        let _lock = mutation_lock()?;
        let parent = validate_mutation_destination(&parent_path)?;
        let folder_name = validate_child_name(&folder_name, "Folder name")?;
        let new_path = parent.join(&folder_name);
        fs::create_dir(&new_path).map_err(|e| format!("Failed to create folder: {}", e))?;
        undo::push_create_action(&new_path, true)?;
        Ok(new_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_file(parent_path: String, file_name: String) -> Result<String, String> {
    log::debug!("[FileOps] create_file: {}/{}", parent_path, file_name);
    tokio::task::spawn_blocking(move || {
        let _lock = mutation_lock()?;
        let parent = validate_mutation_destination(&parent_path)?;
        let file_name = validate_child_name(&file_name, "File name")?;
        let new_path = parent.join(&file_name);
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&new_path)
            .map_err(|e| format!("Failed to create file: {}", e))?;
        undo::push_create_action(&new_path, false)?;
        Ok(new_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_item(item_path: String) -> Result<(), String> {
    log::debug!("[FileOps] delete_item: {}", item_path);
    tokio::task::spawn_blocking(move || delete_item_inner(item_path))
        .await
        .map_err(|e| e.to_string())?
}

fn delete_item_inner(item_path: String) -> Result<(), String> {
    let _lock = mutation_lock()?;
    let path = crate::validate_existing_path(&item_path, "Item")?;
    crate::ensure_not_root_path(&path, "delete")?;
    // Use symlink_metadata (lstat): a symlink that points at a directory must
    // be unlinked, NOT recursed into. path.is_dir() follows the link and would
    // route a symlink-to-dir into remove_dir_all (which then either fails or,
    // worse on some platforms, could affect the target).
    let meta = fs::symlink_metadata(&path).map_err(|e| format!("Failed to access item: {}", e))?;
    let result = if meta.file_type().is_symlink() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete symlink: {}", e))
    } else if meta.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| format!("Failed to delete directory: {}", e))
    } else {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {}", e))
    };
    if result.is_ok() {
        undo::clear_undo_redo_for_path(&path.to_string_lossy())?;
    }
    result
}

#[tauri::command]
pub async fn trash_item(item_path: String) -> Result<(), String> {
    log::debug!("[FileOps] trash_item: {}", item_path);
    tokio::task::spawn_blocking(move || trash_item_inner(item_path))
        .await
        .map_err(|e| e.to_string())?
}

fn trash_item_inner(item_path: String) -> Result<(), String> {
    let _lock = mutation_lock()?;
    let path = crate::validate_existing_path(&item_path, "Item")?;
    crate::ensure_not_root_path(&path, "trash")?;
    let result = trash::delete(&path).map_err(|e| format!("Failed to trash item: {}", e));
    if result.is_ok() {
        undo::clear_undo_redo_for_path(&path.to_string_lossy())?;
    }
    result
}

#[tauri::command]
pub async fn open_trash() -> Result<(), String> {
    tokio::task::spawn_blocking(open_trash_sync)
        .await
        .map_err(|error| error.to_string())?
}

fn open_trash_sync() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::native_macos::open_path(std::path::Path::new(&format!(
            "{}/.Trash",
            std::env::var("HOME").unwrap_or_default()
        )))?;
    }
    #[cfg(target_os = "windows")]
    {
        crate::native_windows::open_uri("shell:RecycleBinFolder")?;
    }
    #[cfg(target_os = "linux")]
    {
        let trash_path = format!(
            "{}/.local/share/Trash",
            std::env::var("HOME").unwrap_or_default()
        );
        open::that(&trash_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn rename_item(old_path: String, new_name: String) -> Result<String, String> {
    log::debug!("[FileOps] rename_item: {} -> {}", old_path, new_name);
    tokio::task::spawn_blocking(move || rename_item_inner(old_path, new_name))
        .await
        .map_err(|e| e.to_string())?
}

fn rename_item_inner(old_path: String, new_name: String) -> Result<String, String> {
    let _lock = mutation_lock()?;
    let path = crate::validate_existing_path(&old_path, "Item")?;
    let new_name = validate_child_name(&new_name, "New name")?;
    let parent = path.parent().ok_or("Cannot determine parent directory")?;
    let parent_meta = fs::symlink_metadata(parent)
        .map_err(|e| format!("Failed to access parent directory: {}", e))?;
    if parent_meta.file_type().is_symlink() || !parent_meta.is_dir() {
        return Err("Refusing to rename through an unsafe parent directory".to_string());
    }
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("Cannot resolve parent directory: {}", e))?;
    let source_meta =
        fs::symlink_metadata(&path).map_err(|e| format!("Failed to access item: {}", e))?;
    // H6: for real files/dirs, canonicalize the source and verify that its
    // canonical parent matches. Skip this for the symlink itself so renaming a
    // link does not follow the target.
    if !source_meta.file_type().is_symlink() {
        let canonical_source = path
            .canonicalize()
            .map_err(|e| format!("Cannot resolve source path: {}", e))?;
        let canonical_source_parent = canonical_source
            .parent()
            .ok_or("Cannot determine canonical source parent")?;
        if canonical_source_parent != canonical_parent {
            return Err(
                "Refusing to rename: source resolves outside its apparent parent (symlink trick)"
                    .to_string(),
            );
        }
    }
    let new_path = canonical_parent.join(&new_name);
    rename_no_replace(&path, &new_path)?;
    undo::push_rename_action(&path, &new_path)?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn copy_items(
    source_paths: Vec<String>,
    dest_path: String,
    conflict_behavior: Option<String>,
    conflict_resolutions: Option<HashMap<String, String>>,
    operation_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    validate_mutation_list(&source_paths, "Source list")?;
    validate_conflict_resolutions(conflict_resolutions.as_ref())?;
    log::debug!(
        "[FileOps] copy_items: {} items -> {}",
        source_paths.len(),
        dest_path
    );
    // Run blocking filesystem work off the async runtime so concurrent copies
    // can't starve tokio workers or park them on the std mutex.
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        // Register the operation ID BEFORE waiting on the lock so that
        // cancel_file_operation can mark it cancelled while we queue. We then
        // re-check active status immediately after acquiring the lock.
        let progress_operation_id = operation_id.unwrap_or_else(|| {
            format!(
                "copy-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            )
        });
        let cancellation = register_file_operation(&progress_operation_id)?;
        // Guard ensures the id is unregistered on every exit path below.
        let _active_guard = ActiveOpGuard {
            operation_id: progress_operation_id.clone(),
            token: cancellation.clone(),
        };
        let mut lock = Some(mutation_lock_cancellable(Some(&cancellation))?);
        // Re-check: the user may have cancelled while we waited for the lock.
        ensure_file_operation_active(Some(&cancellation))?;
        let dest = validate_mutation_destination(&dest_path)?;
        let behavior = conflict_behavior.unwrap_or_else(|| "ask".to_string());
        let resolutions = conflict_resolutions.unwrap_or_default();
        let planned = plan_file_operations(&source_paths, &dest, &behavior, "copy", &resolutions)?;
        let total = planned.len();
        if planned.is_empty() {
            return Ok(());
        }
        let recovery_sources = planned
            .iter()
            .map(|item| item.source_path.clone())
            .collect::<Vec<_>>();
        let recovery_destinations = planned
            .iter()
            .map(|item| item.dest_path.clone())
            .collect::<Vec<_>>();
        let recovery_record_id = crate::recovery::begin_operation(
            "copy",
            Some(&progress_operation_id),
            &recovery_sources,
            &recovery_destinations,
        )?;
        let mut copy_entries = Vec::new();
        let mut backups: HashMap<String, OverwriteBackup> = HashMap::new();

        let operation = (|| -> Result<(), String> {
            for (index, item) in planned.iter().enumerate() {
                ensure_file_operation_active(Some(&cancellation))?;
                ensure_overwrite_backup(&mut backups, item, recovery_record_id.as_deref())?;
                ensure_file_operation_active(Some(&cancellation))?;

                let cancelled = || is_cancelled(Some(&cancellation));
                let entry = copy_entry_checked_with_recovery(
                    &item.source_path,
                    &item.dest_path,
                    &cancelled,
                    &mut |staged| {
                        // Hashing a private workspace does not need the global
                        // mutation lock. Drop it so other operations can proceed
                        // during large fingerprints, then reacquire before publish.
                        drop(lock.take());
                        let recorded = undo::record_copy_entry(
                            &item.source_path,
                            &item.dest_path,
                            staged,
                            &cancelled,
                        );
                        lock = Some(mutation_lock_cancellable(Some(&cancellation))?);
                        ensure_file_operation_active(Some(&cancellation))?;
                        recorded
                    },
                    recovery_record_id.as_deref(),
                )?;
                copy_entries.push(entry);

                let _ = app.emit(
                    "file-operation-progress",
                    serde_json::json!({
                        "operationId": progress_operation_id,
                        "operation": "copy",
                        "current": index + 1,
                        "total": total,
                        "name": item.item_name,
                    }),
                );
            }
            Ok(())
        })();

        if lock.is_none() {
            lock = Some(mutation_lock_cancellable(Some(&cancellation))?);
        }
        let _lock = lock;

        if let Err(error) = operation {
            let mut recovery_errors = rollback_published_copies_with_recovery(
                &copy_entries,
                recovery_record_id.as_deref(),
            );
            recovery_errors.extend(restore_overwrite_backups(&backups));
            if recovery_errors.is_empty() {
                if let Err(journal_error) = crate::recovery::complete(recovery_record_id.as_deref())
                {
                    recovery_errors
                        .push(format!("Recovery journal update failed: {}", journal_error));
                }
            }
            if !recovery_errors.is_empty() {
                crate::recovery::record_error(
                    recovery_record_id.as_deref(),
                    &recovery_errors.join("; "),
                );
            }
            return Err(with_recovery_errors(error, recovery_errors));
        }

        let backup_entries = retained_backup_entries(&backups);
        if let Err(error) = undo::push_recorded_copy_action_with_recovery(
            copy_entries,
            backup_entries.clone(),
            recovery_record_id.clone(),
        ) {
            crate::recovery::record_error(
                recovery_record_id.as_deref(),
                &format!("Copy completed, but undo could not be recorded: {}", error),
            );
            return Err(format!(
                "Copy completed, but undo could not be recorded: {}",
                error
            ));
        }
        if !backup_entries.is_empty() {
            crate::recovery::mark_history_owned(
                recovery_record_id.as_deref(),
                &backups
                    .values()
                    .map(|backup| backup.backup_path.clone())
                    .collect::<Vec<_>>(),
            )?;
        } else {
            crate::recovery::complete(recovery_record_id.as_deref())?;
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Copy operation failed: {}", e))?
}

/// Copy into a private sibling workspace and publish without replacing any entry.
/// Failure cleanup is restricted to the workspace that this call created.
pub(crate) fn copy_entry_exclusive(
    source: &Path,
    destination: &Path,
    cancelled: &impl Fn() -> bool,
) -> Result<(), String> {
    copy_entry_checked(source, destination, cancelled, &mut |_| Ok(()))
}

fn copy_entry_checked<T>(
    source: &Path,
    destination: &Path,
    cancelled: &impl Fn() -> bool,
    before_publish: &mut impl FnMut(&Path) -> Result<T, String>,
) -> Result<T, String> {
    copy_entry_checked_with_recovery(source, destination, cancelled, before_publish, None)
}

fn copy_entry_checked_with_recovery<T>(
    source: &Path,
    destination: &Path,
    cancelled: &impl Fn() -> bool,
    before_publish: &mut impl FnMut(&Path) -> Result<T, String>,
    recovery_record_id: Option<&str>,
) -> Result<T, String> {
    let parent = destination
        .parent()
        .ok_or("Copy destination has no parent")?;
    let mut workspace = None;
    for attempt in 0..128 {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let candidate = parent.join(format!(".iyeris-copy-{nonce}-{attempt}"));
        let builder = fs::DirBuilder::new();
        #[cfg(unix)]
        let mut builder = builder;
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&candidate) {
            Ok(()) => {
                workspace = Some(candidate);
                break;
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    let workspace = workspace.ok_or("Cannot reserve copy workspace")?;
    let workspace_identity = match undo::path_identity(&workspace) {
        Ok(identity) => identity,
        Err(error) => {
            let _ = fs::remove_dir(&workspace);
            return Err(error);
        }
    };
    let staged = workspace.join("content");
    let result = (|| {
        crate::recovery::record_paths_buffered(
            recovery_record_id,
            crate::recovery::RecoveryPaths {
                staging: vec![workspace.clone()],
                ..crate::recovery::RecoveryPaths::default()
            },
        )?;
        let metadata = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            copy_symlink_path(source, &staged)?;
        } else if metadata.is_dir() {
            crate::fs_utils::copy_dir_recursive_cancellable(source, &staged, cancelled)?;
        } else {
            crate::fs_utils::copy_file_cancellable(source, &staged, cancelled)?;
        }
        if cancelled() {
            return Err("Operation cancelled".to_string());
        }
        let recorded = before_publish(&staged)?;
        if cancelled() {
            return Err("Operation cancelled".to_string());
        }
        rename_exclusive(&staged, destination).map_err(|error| error.to_string())?;
        Ok(recorded)
    })();
    let cleanup_result = match fs::symlink_metadata(&workspace) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err("Copy workspace was replaced by a non-directory entry".to_string())
        }
        Ok(_) => match undo::path_identity(&workspace) {
            Ok(identity) if identity == workspace_identity => {
                fs::remove_dir_all(&workspace).map_err(|error| error.to_string())
            }
            Ok(_) => Err("Copy workspace identity changed; preserving it".to_string()),
            Err(error) => Err(format!("Cannot verify copy workspace identity: {}", error)),
        },
    };
    if let Err(cleanup_error) = cleanup_result {
        let message = format!(
            "Copy workspace cleanup failed at {}: {}",
            workspace.display(),
            cleanup_error
        );
        crate::recovery::record_error(recovery_record_id, &message);
        match result {
            Ok(value) => {
                log::error!("{}", message);
                Ok(value)
            }
            Err(error) => Err(format!("{}; {}", error, message)),
        }
    } else {
        result
    }
}

pub(crate) fn copy_symlink_path(source: &Path, target: &Path) -> Result<(), String> {
    let link_target = fs::read_link(source).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&link_target, target)
            .map_err(|e| format!("Failed to create symlink: {}", e))
    }

    #[cfg(windows)]
    {
        let is_dir_link = fs::metadata(source)
            .map(|m| m.is_dir())
            .unwrap_or_else(|_| link_target.is_dir());
        if is_dir_link {
            std::os::windows::fs::symlink_dir(&link_target, target)
                .map_err(|e| format!("Failed to create symlink: {}", e))
        } else {
            std::os::windows::fs::symlink_file(&link_target, target)
                .map_err(|e| format!("Failed to create symlink: {}", e))
        }
    }
}

fn remove_symlink_path(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::remove_file(path).map_err(|e| format!("Failed to remove symlink: {}", e))
    }

    #[cfg(windows)]
    {
        let is_dir_link = fs::metadata(path)
            .map(|linked_meta| linked_meta.is_dir())
            .unwrap_or(false);
        if is_dir_link {
            fs::remove_dir(path)
                .or_else(|_| fs::remove_file(path))
                .map_err(|e| format!("Failed to remove symlink: {}", e))
        } else {
            fs::remove_file(path)
                .or_else(|_| fs::remove_dir(path))
                .map_err(|e| format!("Failed to remove symlink: {}", e))
        }
    }
}

#[tauri::command]
pub async fn move_items(
    source_paths: Vec<String>,
    dest_path: String,
    conflict_behavior: Option<String>,
    conflict_resolutions: Option<HashMap<String, String>>,
    operation_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    validate_mutation_list(&source_paths, "Source list")?;
    validate_conflict_resolutions(conflict_resolutions.as_ref())?;
    log::debug!(
        "[FileOps] move_items: {} items -> {}",
        source_paths.len(),
        dest_path
    );
    // Run blocking filesystem work off the async runtime (see copy_items).
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        // Register the operation ID BEFORE waiting on the lock so that
        // cancel_file_operation can mark it cancelled while we queue.
        let progress_operation_id = operation_id.unwrap_or_else(|| {
            format!(
                "move-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            )
        });
        let cancellation = register_file_operation(&progress_operation_id)?;
        // Guard ensures the id is unregistered on every exit path below.
        let _active_guard = ActiveOpGuard {
            operation_id: progress_operation_id.clone(),
            token: cancellation.clone(),
        };
        let _lock = mutation_lock_cancellable(Some(&cancellation))?;
        // Re-check: the user may have cancelled while we waited for the lock.
        ensure_file_operation_active(Some(&cancellation))?;
        let dest = validate_mutation_destination(&dest_path)?;
        let behavior = conflict_behavior.unwrap_or_else(|| "ask".to_string());
        let resolutions = conflict_resolutions.unwrap_or_default();
        let planned = plan_file_operations(&source_paths, &dest, &behavior, "move", &resolutions)?;
        let total = planned.len();
        if planned.is_empty() {
            return Ok(());
        }
        let recovery_sources = planned
            .iter()
            .map(|item| item.source_path.clone())
            .collect::<Vec<_>>();
        let recovery_destinations = planned
            .iter()
            .map(|item| item.dest_path.clone())
            .collect::<Vec<_>>();
        let recovery_record_id = crate::recovery::begin_operation(
            "move",
            Some(&progress_operation_id),
            &recovery_sources,
            &recovery_destinations,
        )?;
        let mut moved_paths: Vec<String> = Vec::new();
        let mut original_paths: Vec<String> = Vec::new();
        let mut completed_moves: Vec<CompletedMove> = Vec::new();
        let mut backups: HashMap<String, OverwriteBackup> = HashMap::new();

        let operation = (|| -> Result<(), String> {
            for (index, item) in planned.iter().enumerate() {
                ensure_file_operation_active(Some(&cancellation))?;
                ensure_overwrite_backup(&mut backups, item, recovery_record_id.as_deref())?;
                ensure_file_operation_active(Some(&cancellation))?;
                move_path_with_fallback_cancellable_and_recovery(
                    &item.source_path,
                    &item.dest_path,
                    &|| is_cancelled(Some(&cancellation)),
                    recovery_record_id.as_deref(),
                )?;

                moved_paths.push(item.dest_path.to_string_lossy().to_string());
                original_paths.push(item.source_path.to_string_lossy().to_string());
                completed_moves.push(CompletedMove {
                    source_path: item.source_path.clone(),
                    dest_path: item.dest_path.clone(),
                });

                let _ = app.emit(
                    "file-operation-progress",
                    serde_json::json!({
                        "operationId": progress_operation_id,
                        "operation": "move",
                        "current": index + 1,
                        "total": total,
                        "name": item.item_name,
                    }),
                );
            }
            Ok(())
        })();

        if let Err(error) = operation {
            let mut recovery_errors =
                rollback_moves(&completed_moves, recovery_record_id.as_deref());
            recovery_errors.extend(restore_overwrite_backups(&backups));
            crate::recovery::record_error(
                recovery_record_id.as_deref(),
                &with_recovery_errors(error.clone(), recovery_errors.clone()),
            );
            return Err(with_recovery_errors(error, recovery_errors));
        }

        let item_fingerprints = match moved_paths
            .iter()
            .map(|path| undo::path_fingerprint(Path::new(path), &|| false))
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(fingerprints) => fingerprints,
            Err(error) => {
                let mut recovery_errors =
                    rollback_moves(&completed_moves, recovery_record_id.as_deref());
                recovery_errors.extend(restore_overwrite_backups(&backups));
                crate::recovery::record_error(
                    recovery_record_id.as_deref(),
                    &with_recovery_errors(error.clone(), recovery_errors.clone()),
                );
                return Err(with_recovery_errors(error, recovery_errors));
            }
        };
        let backup_entries = retained_backup_entries(&backups);
        if let Err(error) = undo::push_move_action_with_recovery(
            moved_paths,
            original_paths,
            dest_path,
            backup_entries.clone(),
            Some(item_fingerprints),
            recovery_record_id.clone(),
        ) {
            crate::recovery::record_error(
                recovery_record_id.as_deref(),
                &format!("Move completed, but undo could not be recorded: {}", error),
            );
            return Err(format!(
                "Move completed, but undo could not be recorded: {}",
                error
            ));
        }
        if !backup_entries.is_empty() {
            crate::recovery::mark_history_owned(
                recovery_record_id.as_deref(),
                &backups
                    .values()
                    .map(|backup| backup.backup_path.clone())
                    .collect::<Vec<_>>(),
            )?;
        } else {
            crate::recovery::complete(recovery_record_id.as_deref())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Move operation failed: {}", e))?
}

fn register_file_operation(operation_id: &str) -> Result<CancellationToken, String> {
    ACTIVE_FILE_OPERATIONS
        .register(operation_id)
        .ok_or_else(|| "File operation ID cannot be empty".to_string())
}

fn ensure_file_operation_active(token: Option<&CancellationToken>) -> Result<(), String> {
    if !is_cancelled(token) {
        Ok(())
    } else {
        Err("Operation cancelled".to_string())
    }
}

/// RAII guard that unregisters an operation id on drop, so the id is removed
/// from ACTIVE_FILE_OPERATIONS on every exit path (early `?`, cancel, panic),
/// not just the happy path. Registered before the FILE_OP_LOCK wait so a
/// cancel issued while queued is observed once we acquire the lock.
struct ActiveOpGuard {
    operation_id: String,
    token: CancellationToken,
}
impl Drop for ActiveOpGuard {
    fn drop(&mut self) {
        ACTIVE_FILE_OPERATIONS.finish(&self.operation_id, Some(&self.token));
    }
}

#[tauri::command]
pub async fn cancel_file_operation(
    operation_id: String,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    ACTIVE_FILE_OPERATIONS.cancel(&operation_id);
    ACTIVE_DUPLICATE_SCANS.cancel_existing(&operation_id);
    if operation_id == DUPLICATE_SCAN_OPERATION_ID {
        ACTIVE_DUPLICATE_SCANS.cancel_existing(&duplicate_scan_operation_id(window.label()));
    }
    Ok(())
}

pub(crate) fn remove_existing_path(path: &Path) -> Result<(), String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if meta.file_type().is_symlink() {
        return remove_symlink_path(path);
    }
    if meta.is_dir() {
        fs::remove_dir_all(path).map_err(|e| format!("Failed to remove existing directory: {}", e))
    } else {
        fs::remove_file(path).map_err(|e| format!("Failed to remove existing file: {}", e))
    }
}

fn normalize_case_key(path: &Path) -> String {
    #[cfg(target_os = "windows")]
    {
        path.to_string_lossy().to_ascii_lowercase()
    }

    #[cfg(not(target_os = "windows"))]
    {
        path.to_string_lossy().to_string()
    }
}

fn path_entry_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

const NAME_COLLISION_MESSAGE: &str = "A file or folder with that name already exists";

pub(crate) fn same_dir_entry(left: &Path, right: &Path) -> bool {
    #[cfg(unix)]
    {
        let Ok(left_meta) = fs::symlink_metadata(left) else {
            return false;
        };
        let Ok(right_meta) = fs::symlink_metadata(right) else {
            return false;
        };
        use std::os::unix::fs::MetadataExt;
        left_meta.dev() == right_meta.dev() && left_meta.ino() == right_meta.ino()
    }
    #[cfg(windows)]
    {
        // Keep this branch on stable Rust. `std::os::windows::fs::MetadataExt`
        // exposes file-index/volume methods behind the unstable
        // `windows_by_handle` feature, so they cannot be used by release
        // builds. Batch rename targets are built from the same validated
        // parent path; case-insensitive lexical identity handles the
        // important case-only rename without following symlinks.
        left.to_string_lossy()
            .replace('/', "\\")
            .eq_ignore_ascii_case(&right.to_string_lossy().replace('/', "\\"))
    }
    #[cfg(not(any(unix, windows)))]
    {
        left == right
    }
}

fn map_rename_io_error(error: std::io::Error) -> String {
    if error.kind() == ErrorKind::AlreadyExists {
        NAME_COLLISION_MESSAGE.to_string()
    } else {
        format!("Failed to rename: {}", error)
    }
}

#[cfg(unix)]
fn path_to_cstring(path: &Path) -> std::io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(ErrorKind::InvalidInput, "path contains interior NUL"))
}

#[cfg(target_os = "linux")]
pub(crate) fn rename_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::raw::c_char;
    const AT_FDCWD: i32 = -100;
    const RENAME_NOREPLACE: u32 = 1;
    extern "C" {
        fn renameat2(
            olddirfd: i32,
            oldpath: *const c_char,
            newdirfd: i32,
            newpath: *const c_char,
            flags: u32,
        ) -> i32;
    }
    let from_c = path_to_cstring(from)?;
    let to_c = path_to_cstring(to)?;
    // SAFETY: both paths are owned C strings valid for the duration of the call.
    let rc = unsafe {
        renameat2(
            AT_FDCWD,
            from_c.as_ptr(),
            AT_FDCWD,
            to_c.as_ptr(),
            RENAME_NOREPLACE,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn rename_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::raw::c_char;
    const RENAME_EXCL: u32 = 0x0004;
    extern "C" {
        fn renamex_np(old: *const c_char, new: *const c_char, flags: u32) -> i32;
    }
    let from_c = path_to_cstring(from)?;
    let to_c = path_to_cstring(to)?;
    // SAFETY: both paths are owned C strings valid for the duration of the call.
    let rc = unsafe { renamex_np(from_c.as_ptr(), to_c.as_ptr(), RENAME_EXCL) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub(crate) fn rename_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS};

    let from_wide: Vec<u16> = from
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let to_wide: Vec<u16> = to
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: both buffers are valid NUL-terminated wide strings we own.
    unsafe {
        MoveFileExW(
            PCWSTR(from_wide.as_ptr()),
            PCWSTR(to_wide.as_ptr()),
            MOVE_FILE_FLAGS(0),
        )
    }
    .map_err(|_| std::io::Error::last_os_error())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn rename_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    if path_entry_exists(to) && !same_dir_entry(from, to) {
        return Err(std::io::Error::new(
            ErrorKind::AlreadyExists,
            NAME_COLLISION_MESSAGE,
        ));
    }
    fs::rename(from, to)
}

pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> Result<(), String> {
    if from == to || same_dir_entry(from, to) {
        return fs::rename(from, to).map_err(map_rename_io_error);
    }
    rename_exclusive(from, to).map_err(map_rename_io_error)
}

pub(crate) fn reserve_staging_rename(original: &Path) -> Result<PathBuf, String> {
    reserve_staging_rename_with_recovery(original, None)
}

pub(crate) fn reserve_staging_rename_with_recovery(
    original: &Path,
    recovery_record_id: Option<&str>,
) -> Result<PathBuf, String> {
    let parent = original
        .parent()
        .ok_or_else(|| "Cannot determine parent directory".to_string())?;
    let stem = original
        .file_name()
        .map(|name| name.to_string_lossy().replace(['/', '\\'], "_"))
        .unwrap_or_else(|| "item".to_string());
    for attempt in 0..128u32 {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let temp_path = parent.join(format!(".iyeris-rename-tmp-{attempt}-{nonce}-{stem}"));
        crate::recovery::record_paths(
            recovery_record_id,
            crate::recovery::RecoveryPaths {
                staging: vec![temp_path.clone()],
                ..crate::recovery::RecoveryPaths::default()
            },
        )?;
        match rename_exclusive(original, &temp_path) {
            Ok(()) => return Ok(temp_path),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Batch rename staging failed: {}", error)),
        }
    }
    Err("Could not reserve a unique staging path".to_string())
}

/// Stage every source before publishing a rename cycle. Recovery never replaces
/// an occupied entry; unresolved content remains at its reported staging path.
pub(crate) fn rename_batch_transaction(paths: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    rename_batch_transaction_with_recovery(paths, None)
}

pub(crate) fn rename_batch_transaction_with_recovery(
    paths: &[(PathBuf, PathBuf)],
    recovery_record_id: Option<&str>,
) -> Result<(), String> {
    let paths: Vec<_> = paths.iter().filter(|(from, to)| from != to).collect();
    let mut sources = HashSet::new();
    let mut targets = HashSet::new();
    for (from, to) in &paths {
        if !sources.insert(normalize_case_key(from)) || !targets.insert(normalize_case_key(to)) {
            return Err("Batch rename contains duplicate sources or targets".to_string());
        }
        fs::symlink_metadata(from)
            .map_err(|e| format!("Cannot inspect {}: {}", from.display(), e))?;
    }
    for (from, to) in &paths {
        if path_entry_exists(to)
            && !sources.contains(&normalize_case_key(to))
            && !same_dir_entry(from, to)
        {
            return Err(format!("Destination already exists: {}", to.display()));
        }
    }
    let mut staged = Vec::new();
    let mut published = 0;
    let result = (|| {
        for (from, _) in &paths {
            staged.push(reserve_staging_rename_with_recovery(
                from,
                recovery_record_id,
            )?);
        }
        for ((_, to), temp) in paths.iter().zip(&staged) {
            rename_exclusive(temp, to).map_err(map_rename_io_error)?;
            published += 1;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut recovery_errors = Vec::new();
        let mut recoverable = vec![true; staged.len()];
        for index in (0..published).rev() {
            if let Err(error) = rename_exclusive(&paths[index].1, &staged[index]) {
                recoverable[index] = false;
                recovery_errors.push(format!(
                    "Cannot recover rename: {}. Content retained at {}",
                    error,
                    paths[index].1.display()
                ));
            }
        }
        for (index, temp) in staged.iter().enumerate() {
            if recoverable[index] {
                if let Err(error) = rename_exclusive(temp, &paths[index].0) {
                    recovery_errors.push(format!(
                        "Cannot restore rename: {}. Content retained at {}",
                        error,
                        temp.display()
                    ));
                }
            }
        }
        return Err(with_recovery_errors(error, recovery_errors));
    }
    Ok(())
}

fn duplicate_scan_operation_id(window_label: &str) -> String {
    format!("{window_label}::{DUPLICATE_SCAN_OPERATION_ID}")
}

fn is_hidden_entry(name: &str, path: &Path) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        if let Ok(meta) = fs::symlink_metadata(path) {
            return meta.file_attributes() & 0x2 != 0;
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = path;
    false
}

fn allow_duplicate_walk_entry(entry: &walkdir::DirEntry, include_hidden: bool) -> bool {
    include_hidden
        || entry.depth() == 0
        || !is_hidden_entry(&entry.file_name().to_string_lossy(), entry.path())
}

fn create_renamed_target(dest: &Path, original_name: &str, reserved: &HashSet<String>) -> PathBuf {
    let (base, ext) = split_filename(original_name);
    for i in 2..10_000 {
        let candidate = match &ext {
            Some(ext) => format!("{} ({}).{}", base, i, ext),
            None => format!("{} ({})", base, i),
        };
        let target = dest.join(candidate);
        let key = normalize_case_key(&target);
        if !path_entry_exists(&target) && !reserved.contains(&key) {
            return target;
        }
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    dest.join(format!("{} ({})", original_name, timestamp))
}

fn split_filename(name: &str) -> (String, Option<String>) {
    if let Some(dot_index) = name.rfind('.') {
        if dot_index > 0 && dot_index < name.len() - 1 {
            return (
                name[..dot_index].to_string(),
                Some(name[dot_index + 1..].to_string()),
            );
        }
    }
    (name.to_string(), None)
}

fn resolve_conflict_target(
    dest: &Path,
    original_name: &str,
    behavior: &str,
) -> Result<Option<(PathBuf, bool)>, String> {
    let target = dest.join(original_name);
    if !path_entry_exists(&target) {
        return Ok(Some((target, false)));
    }

    match behavior.to_ascii_lowercase().as_str() {
        "skip" => Ok(None),
        "overwrite" => Ok(Some((target, true))),
        "rename" | "ask" => Ok(Some((target, false))),
        _ => Ok(Some((target, false))),
    }
}

#[derive(Clone)]
pub(crate) struct PlannedFileOperation {
    pub(crate) source_path: PathBuf,
    pub(crate) dest_path: PathBuf,
    item_name: String,
    pub(crate) overwrite: bool,
}

#[derive(Clone)]
struct CompletedMove {
    source_path: PathBuf,
    dest_path: PathBuf,
}

#[derive(Clone)]
struct OverwriteBackup {
    dest_path: PathBuf,
    backup_path: PathBuf,
    fingerprint: String,
}

pub(crate) fn plan_file_operations(
    source_paths: &[String],
    dest: &Path,
    behavior: &str,
    operation: &str,
    conflict_resolutions: &HashMap<String, String>,
) -> Result<Vec<PlannedFileOperation>, String> {
    if source_paths.is_empty() {
        return Err("No source items provided".to_string());
    }

    let mut planned: Vec<PlannedFileOperation> = Vec::new();
    let mut reserved: HashSet<String> = HashSet::new();
    let dest_real = fs::canonicalize(dest).map_err(|error| {
        format!(
            "Refusing to {}: cannot safely resolve destination {}: {}",
            operation,
            dest.display(),
            error
        )
    })?;
    let behavior_normalized = behavior.to_ascii_lowercase();

    for source in source_paths {
        let src = crate::validate_existing_path(source, "Source")?;
        let metadata = fs::symlink_metadata(&src).map_err(|e| e.to_string())?;
        if !metadata.file_type().is_symlink() && !metadata.is_file() && !metadata.is_dir() {
            return Err(format!(
                "Cannot {} special filesystem entry: {}",
                operation,
                src.display()
            ));
        }
        let item_name = src
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .ok_or("Invalid source path")?;

        let base_target = dest.join(&item_name);
        let base_key = normalize_case_key(&base_target);
        if reserved.contains(&base_key) {
            return Err(format!(
                "Multiple items share the same name: \"{}\"",
                item_name
            ));
        }

        if metadata.is_dir() {
            let source_real = fs::canonicalize(&src).map_err(|error| {
                format!(
                    "Refusing to {}: cannot safely resolve source {}: {}",
                    operation,
                    src.display(),
                    error
                )
            })?;
            if dest_real == source_real || dest_real.starts_with(&source_real) {
                return Err(format!(
                    "Cannot {} \"{}\" into itself or a subfolder",
                    operation, item_name
                ));
            }
        }

        let resolved = match resolve_conflict_target(dest, &item_name, behavior)? {
            None => continue,
            Some((target, overwrite)) => {
                if overwrite {
                    (target, overwrite)
                } else if path_entry_exists(&target) {
                    if behavior_normalized == "ask" {
                        match conflict_resolutions
                            .get(&item_name)
                            .map(|value| value.to_ascii_lowercase())
                            .as_deref()
                        {
                            Some("overwrite") => (target, true),
                            Some("rename") => {
                                (create_renamed_target(dest, &item_name, &reserved), false)
                            }
                            Some("skip") => continue,
                            Some("cancel") => return Err("Operation cancelled".to_string()),
                            Some(_) => {
                                return Err(format!(
                                    "Unsupported conflict resolution for \"{}\"",
                                    item_name
                                ))
                            }
                            None => return Err(format!("CONFLICT:{}", item_name)),
                        }
                    } else {
                        (create_renamed_target(dest, &item_name, &reserved), false)
                    }
                } else {
                    (target, false)
                }
            }
        };

        let source_key = normalize_case_key(&src);
        let destination_key = normalize_case_key(&resolved.0);
        if source_key == destination_key {
            return Err(format!(
                "Cannot {} \"{}\" onto itself",
                operation, item_name
            ));
        }
        if reserved.contains(&destination_key) {
            return Err(format!(
                "Multiple items resolve to the same destination: \"{}\"",
                resolved
                    .0
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default()
            ));
        }
        reserved.insert(destination_key);

        planned.push(PlannedFileOperation {
            source_path: src,
            dest_path: resolved.0,
            item_name,
            overwrite: resolved.1,
        });
    }

    Ok(planned)
}

pub(crate) fn validate_mutation_destination(raw: &str) -> Result<PathBuf, String> {
    let path = crate::validate_existing_path(raw, "Destination")?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("Cannot inspect destination: {}", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Destination must be a real directory".to_string());
    }
    path.canonicalize()
        .map_err(|error| format!("Cannot safely resolve destination: {}", error))
}

fn is_cross_device_error(err: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        err.kind() == std::io::ErrorKind::CrossesDevices || matches!(err.raw_os_error(), Some(18))
    }
    #[cfg(windows)]
    {
        err.kind() == std::io::ErrorKind::CrossesDevices || matches!(err.raw_os_error(), Some(17))
    }
    #[cfg(not(any(unix, windows)))]
    {
        err.kind() == std::io::ErrorKind::CrossesDevices
    }
}

#[cfg(test)]
pub(crate) fn move_path_with_fallback(source: &Path, target: &Path) -> Result<(), String> {
    move_path_with_fallback_cancellable(source, target, &|| false)
}

#[cfg(test)]
fn move_path_with_fallback_cancellable(
    source: &Path,
    target: &Path,
    is_cancelled: &impl Fn() -> bool,
) -> Result<(), String> {
    move_path_with_fallback_cancellable_and_recovery(source, target, is_cancelled, None)
}

pub(crate) fn move_path_with_fallback_cancellable_and_recovery(
    source: &Path,
    target: &Path,
    is_cancelled: &impl Fn() -> bool,
    recovery_record_id: Option<&str>,
) -> Result<(), String> {
    if is_cancelled() {
        return Err("Operation cancelled".to_string());
    }
    let source_meta = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    let is_symlink = source_meta.file_type().is_symlink();
    let is_directory = source_meta.is_dir();

    if let Some(parent) = target.parent() {
        let parent_meta = fs::symlink_metadata(parent)
            .map_err(|e| format!("Failed to inspect destination directory: {}", e))?;
        if parent_meta.file_type().is_symlink() || !parent_meta.is_dir() {
            return Err("Refusing to move through an unsafe destination directory".to_string());
        }
    }
    match rename_exclusive(source, target) {
        Ok(_) => return Ok(()),
        Err(error) if !is_cross_device_error(&error) => {
            return Err(format!(
                "Failed to move {} to {}: {}",
                source.display(),
                target.display(),
                error
            ));
        }
        Err(_) => {}
    }

    copy_then_remove_source_with_recovery(
        source,
        target,
        is_symlink,
        is_directory,
        is_cancelled,
        recovery_record_id,
    )
}

#[cfg(test)]
fn copy_then_remove_source(
    source: &Path,
    target: &Path,
    is_symlink: bool,
    is_directory: bool,
    cancelled: &impl Fn() -> bool,
) -> Result<(), String> {
    copy_then_remove_source_with_recovery(source, target, is_symlink, is_directory, cancelled, None)
}

fn copy_then_remove_source_with_recovery(
    source: &Path,
    target: &Path,
    is_symlink: bool,
    is_directory: bool,
    cancelled: &impl Fn() -> bool,
    recovery_record_id: Option<&str>,
) -> Result<(), String> {
    // Reserve the original entry so a new occupant at its old path is never
    // deleted during cross-volume cleanup. Restore it on failed/cancelled copy.
    let staged_source = reserve_staging_rename_with_recovery(source, recovery_record_id)?;
    if let Err(error) = copy_entry_checked_with_recovery(
        &staged_source,
        target,
        cancelled,
        &mut |_| Ok(()),
        recovery_record_id,
    ) {
        return match rename_exclusive(&staged_source, source) {
            Ok(()) => Err(error),
            Err(recovery) => Err(format!(
                "{error}; source recovery failed: {recovery}; source retained at {}",
                staged_source.display()
            )),
        };
    }
    crate::recovery::record_paths(
        recovery_record_id,
        crate::recovery::RecoveryPaths {
            staging: vec![staged_source.clone()],
            ..crate::recovery::RecoveryPaths::default()
        },
    )?;
    let cleanup = if is_symlink {
        remove_symlink_path(&staged_source)
    } else if is_directory {
        fs::remove_dir_all(&staged_source).map_err(|error| error.to_string())
    } else {
        fs::remove_file(&staged_source).map_err(|error| error.to_string())
    };
    if let Err(error) = cleanup {
        return Err(format!("Source cleanup incomplete: {error}. Complete copy retained at {}; remaining source retained at {}", target.display(), staged_source.display()));
    }
    Ok(())
}

fn create_backup_path(dest_path: &Path) -> Result<PathBuf, String> {
    let parent = dest_path
        .parent()
        .ok_or("Cannot determine parent directory for backup path")?;
    let base = dest_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or("Cannot determine destination name for backup path")?;

    for attempt in 0..10 {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let candidate = parent.join(format!(
            ".{}.iyeris-backup-{}-{}-{}",
            base,
            std::process::id(),
            timestamp,
            attempt
        ));
        if !path_entry_exists(&candidate) {
            return Ok(candidate);
        }
    }
    Err("Unable to create backup path".to_string())
}

fn ensure_overwrite_backup(
    backups: &mut HashMap<String, OverwriteBackup>,
    operation: &PlannedFileOperation,
    recovery_record_id: Option<&str>,
) -> Result<(), String> {
    if !operation.overwrite {
        return Ok(());
    }

    let key = normalize_case_key(&operation.dest_path);
    if backups.contains_key(&key) {
        return Ok(());
    }
    match fs::symlink_metadata(&operation.dest_path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Cannot inspect overwrite destination {}: {}",
                operation.dest_path.display(),
                error
            ));
        }
        Ok(_) => {}
    }

    let fingerprint = undo::path_fingerprint(&operation.dest_path, &|| false)?;
    let backup_path = create_backup_path(&operation.dest_path)?;
    crate::recovery::record_paths(
        recovery_record_id,
        crate::recovery::RecoveryPaths {
            backups: vec![backup_path.clone()],
            ..crate::recovery::RecoveryPaths::default()
        },
    )?;
    rename_exclusive(&operation.dest_path, &backup_path).map_err(|error| {
        format!(
            "Failed to retain overwrite destination {}: {}",
            operation.dest_path.display(),
            error
        )
    })?;
    backups.insert(
        key.clone(),
        OverwriteBackup {
            dest_path: operation.dest_path.clone(),
            backup_path: backup_path.clone(),
            fingerprint: fingerprint.clone(),
        },
    );
    if let Err(error) = undo::verify_copy(&backup_path, &fingerprint) {
        crate::recovery::record_error(recovery_record_id, &error);
        return Err(format!(
            "Overwrite destination changed while being retained: {}; original retained at {}",
            error,
            backup_path.display()
        ));
    }
    Ok(())
}

fn retained_backup_entries(
    backups: &HashMap<String, OverwriteBackup>,
) -> Vec<undo::OverwriteBackupEntry> {
    backups
        .values()
        .map(|backup| undo::OverwriteBackupEntry {
            original_path: backup.dest_path.to_string_lossy().into_owned(),
            backup_path: backup.backup_path.to_string_lossy().into_owned(),
            fingerprint: backup.fingerprint.clone(),
        })
        .collect()
}

fn restore_overwrite_backups(backups: &HashMap<String, OverwriteBackup>) -> Vec<String> {
    let mut errors = Vec::new();
    for backup in backups.values() {
        match fs::symlink_metadata(&backup.backup_path) {
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                errors.push(format!(
                    "Cannot inspect overwrite backup {}; preserving it: {}",
                    backup.backup_path.display(),
                    error
                ));
                continue;
            }
            Ok(_) => {}
        }
        if let Err(error) = undo::verify_copy(&backup.backup_path, &backup.fingerprint) {
            errors.push(format!(
                "Overwrite backup changed and was retained at {}: {}",
                backup.backup_path.display(),
                error
            ));
            continue;
        }
        match fs::symlink_metadata(&backup.dest_path) {
            Ok(_) => {
                errors.push(format!(
                    "Destination occupied; original retained at {}",
                    backup.backup_path.display()
                ));
                continue;
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                errors.push(format!(
                    "Cannot inspect destination {}; original retained at {}: {}",
                    backup.dest_path.display(),
                    backup.backup_path.display(),
                    error
                ));
                continue;
            }
        }
        if let Err(error) = rename_exclusive(&backup.backup_path, &backup.dest_path) {
            errors.push(format!(
                "Restore failed: {}. Original retained at {}",
                error,
                backup.backup_path.display()
            ));
        }
    }
    errors
}

fn with_recovery_errors(error: String, recovery_errors: Vec<String>) -> String {
    if recovery_errors.is_empty() {
        error
    } else {
        format!("{}\n{}", error, recovery_errors.join("\n"))
    }
}

#[cfg(test)]
fn rollback_published_copies(entries: &[undo::CopyEntry]) -> Vec<String> {
    rollback_published_copies_with_recovery(entries, None)
}

fn rollback_published_copies_with_recovery(
    entries: &[undo::CopyEntry],
    recovery_record_id: Option<&str>,
) -> Vec<String> {
    let mut errors = Vec::new();
    for entry in entries.iter().rev() {
        let destination = PathBuf::from(&entry.dest_path);
        match fs::symlink_metadata(&destination) {
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                errors.push(format!(
                    "Cannot inspect copied destination {}; retained for recovery: {}",
                    destination.display(),
                    error
                ));
                continue;
            }
            Ok(_) => {}
        }

        let quarantine =
            match reserve_staging_rename_with_recovery(&destination, recovery_record_id) {
                Ok(path) => path,
                Err(error) => {
                    errors.push(format!(
                        "Cannot quarantine copied destination {}; retained for recovery: {}",
                        destination.display(),
                        error
                    ));
                    continue;
                }
            };
        if let Err(error) = undo::verify_copy(&quarantine, &entry.fingerprint) {
            let recovery = if path_entry_exists(&destination) {
                Err(format!(
                    "destination is now occupied; entry retained at {}",
                    quarantine.display()
                ))
            } else {
                rename_exclusive(&quarantine, &destination).map_err(|restore| {
                    format!(
                        "restore failed: {}; entry retained at {}",
                        restore,
                        quarantine.display()
                    )
                })
            };
            let recovery = match recovery {
                Ok(()) => format!("entry restored at {}", destination.display()),
                Err(recovery_error) => recovery_error,
            };
            errors.push(format!(
                "Copied destination changed or was replaced at {}; preserving it. {}; {}",
                destination.display(),
                error,
                recovery
            ));
            continue;
        }
        if let Err(error) = remove_existing_path(&quarantine) {
            errors.push(format!(
                "Copy rollback cleanup failed; content retained at {}: {}",
                quarantine.display(),
                error
            ));
        }
    }
    errors
}

fn rollback_moves(completed: &[CompletedMove], recovery_record_id: Option<&str>) -> Vec<String> {
    let mut errors = Vec::new();
    for item in completed.iter().rev() {
        if let Err(e) = move_path_with_fallback_cancellable_and_recovery(
            &item.dest_path,
            &item.source_path,
            &|| false,
            recovery_record_id,
        ) {
            errors.push(format!(
                "Rollback failed: {}. Moved content retained at {}",
                e,
                item.dest_path.display()
            ));
            log::error!(
                "[FileOps] Rollback failed: {} -> {}: {}",
                item.dest_path.display(),
                item.source_path.display(),
                e
            );
        }
    }
    errors
}

#[tauri::command]
pub async fn get_item_properties(item_path: String) -> Result<ItemProperties, String> {
    tokio::task::spawn_blocking(move || get_item_properties_sync(item_path))
        .await
        .map_err(|e| e.to_string())?
}

fn get_item_properties_sync(item_path: String) -> Result<ItemProperties, String> {
    log::debug!("[FileOps] get_item_properties: {}", item_path);
    let path = crate::validate_existing_path(&item_path, "Item")?;
    let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;

    let to_ms = |t: std::io::Result<std::time::SystemTime>| {
        t.ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    };

    #[cfg(unix)]
    let permissions: Option<u32> = {
        use std::os::unix::fs::PermissionsExt;
        Some(meta.permissions().mode())
    };
    #[cfg(not(unix))]
    let permissions: Option<u32> = None;

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let is_symlink = meta.file_type().is_symlink();
    let symlink_target = if is_symlink {
        fs::read_link(&path)
            .ok()
            .map(|target| target.to_string_lossy().to_string())
    } else {
        None
    };
    let is_directory = resolve_item_is_directory(&path, &meta);

    // Plain files only: links and folders get no size-on-disk, MIME or handler.
    let is_plain_file = !is_directory && !is_symlink;

    #[cfg(unix)]
    let (owner, group) = {
        use std::os::unix::fs::MetadataExt;
        (Some(meta.uid().to_string()), Some(meta.gid().to_string()))
    };
    #[cfg(not(unix))]
    let (owner, group): (Option<String>, Option<String>) = (None, None);

    // Name lookups are best effort. Linux resolves through NSS via nix. Other
    // Unix targets have no nix dependency here, so only numeric ids are shown.
    #[cfg(target_os = "linux")]
    let (owner_name, group_name) = {
        use nix::unistd::{Gid, Group, Uid, User};
        use std::os::unix::fs::MetadataExt;
        let owner_name = User::from_uid(Uid::from_raw(meta.uid()))
            .ok()
            .flatten()
            .map(|user| user.name);
        let group_name = Group::from_gid(Gid::from_raw(meta.gid()))
            .ok()
            .flatten()
            .map(|group| group.name);
        (owner_name, group_name)
    };
    #[cfg(target_os = "windows")]
    let (owner_name, group_name): (Option<String>, Option<String>) =
        (crate::native_windows::owner_account_name(&path), None);
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    let (owner_name, group_name): (Option<String>, Option<String>) = (None, None);

    #[cfg(target_os = "windows")]
    let (is_shortcut, shortcut_target) = {
        let shortcut = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("lnk"))
            .unwrap_or(false);
        let target = if shortcut {
            resolve_windows_shortcut(&path).ok()
        } else {
            None
        };
        (Some(shortcut), target)
    };
    #[cfg(not(target_os = "windows"))]
    let (is_shortcut, shortcut_target): (Option<bool>, Option<String>) = (None, None);

    // Raw FILE_ATTRIBUTE_* masks from winnt.h.
    #[cfg(target_os = "windows")]
    let (
        is_hidden_attr,
        is_system_attr,
        is_archive_attr,
        is_compressed_attr,
        is_encrypted_attr,
        is_indexed_attr,
    ) = {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
        const FILE_ATTRIBUTE_ARCHIVE: u32 = 0x20;
        const FILE_ATTRIBUTE_COMPRESSED: u32 = 0x800;
        const FILE_ATTRIBUTE_NOT_CONTENT_INDEXED: u32 = 0x2000;
        const FILE_ATTRIBUTE_ENCRYPTED: u32 = 0x4000;
        let attrs = meta.file_attributes();
        (
            Some(attrs & FILE_ATTRIBUTE_HIDDEN != 0),
            Some(attrs & FILE_ATTRIBUTE_SYSTEM != 0),
            Some(attrs & FILE_ATTRIBUTE_ARCHIVE != 0),
            Some(attrs & FILE_ATTRIBUTE_COMPRESSED != 0),
            Some(attrs & FILE_ATTRIBUTE_ENCRYPTED != 0),
            // The Windows flag means "not indexed", so invert it for the UI.
            Some(attrs & FILE_ATTRIBUTE_NOT_CONTENT_INDEXED == 0),
        )
    };
    #[cfg(not(target_os = "windows"))]
    let (
        is_hidden_attr,
        is_system_attr,
        is_archive_attr,
        is_compressed_attr,
        is_encrypted_attr,
        is_indexed_attr,
    ): (
        Option<bool>,
        Option<bool>,
        Option<bool>,
        Option<bool>,
        Option<bool>,
        Option<bool>,
    ) = (None, None, None, None, None, None);

    let mime_type = if is_plain_file {
        detect_item_mime_type(&path)
    } else {
        None
    };

    #[cfg(unix)]
    let size_on_disk = if is_plain_file {
        use std::os::unix::fs::MetadataExt;
        Some(meta.blocks().saturating_mul(512))
    } else {
        None
    };
    #[cfg(target_os = "windows")]
    let size_on_disk = if is_plain_file {
        crate::native_windows::compressed_file_size(&path)
    } else {
        None
    };
    #[cfg(not(any(unix, target_os = "windows")))]
    let size_on_disk: Option<u64> = None;

    #[cfg(target_os = "windows")]
    let opens_with = if is_plain_file {
        path.extension()
            .and_then(|ext| ext.to_str())
            .filter(|ext| !ext.is_empty())
            .and_then(|ext| {
                let assoc = format!(".{ext}");
                crate::native_windows::associated_app_name(&assoc).or_else(|| {
                    crate::native_windows::associated_executable(&assoc).and_then(|exe| {
                        Path::new(&exe)
                            .file_stem()
                            .and_then(|stem| stem.to_str())
                            .map(str::to_string)
                    })
                })
            })
    } else {
        None
    };
    #[cfg(not(target_os = "windows"))]
    let opens_with: Option<String> = None;

    Ok(ItemProperties {
        name: name.clone(),
        path: path.to_string_lossy().to_string(),
        size: meta.len(),
        is_directory,
        is_symlink,
        symlink_target,
        is_shortcut,
        shortcut_target,
        is_hidden: name.starts_with('.'),
        readonly: meta.permissions().readonly(),
        owner,
        group,
        is_hidden_attr,
        is_system_attr,
        mac_tags: None,
        created: to_ms(meta.created()),
        modified: to_ms(meta.modified()),
        accessed: to_ms(meta.accessed()),
        extension: path
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default(),
        permissions,
        size_on_disk,
        mime_type,
        opens_with,
        owner_name,
        group_name,
        is_archive_attr,
        is_compressed_attr,
        is_encrypted_attr,
        is_indexed_attr,
    })
}

#[tauri::command]
pub async fn set_permissions(item_path: String, mode: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || set_permissions_sync(item_path, mode))
        .await
        .map_err(|e| e.to_string())?
}

fn set_permissions_sync(item_path: String, mode: u32) -> Result<(), String> {
    let _lock = mutation_lock()?;
    let path = crate::validate_existing_path(&item_path, "Item")?;

    // M3: refuse to operate on symlinks. `fs::set_permissions` follows symlinks,
    // which would let a user chmod the target of a symlink they don't own.
    // The standard library doesn't expose AT_SYMLINK_NOFOLLOW for chmod, so
    // the simplest correct behavior is to refuse.
    let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("Refusing to change permissions on a symlink".to_string());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(mode);
        fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;
    }

    #[cfg(not(unix))]
    {
        let mut perms = meta.permissions();
        perms.set_readonly(mode & 0o200 == 0);
        fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn set_attributes(item_path: String, attrs: serde_json::Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || set_attributes_sync(item_path, attrs))
        .await
        .map_err(|e| e.to_string())?
}

fn set_attributes_sync(item_path: String, attrs: serde_json::Value) -> Result<(), String> {
    let _lock = mutation_lock()?;
    let path = crate::validate_existing_path(&item_path, "Item")?;
    let read_only = attrs.get("readOnly").and_then(|value| value.as_bool());
    let hidden = attrs.get("hidden").and_then(|value| value.as_bool());
    let system = attrs.get("system").and_then(|value| value.as_bool());

    // M3: same as set_permissions — refuse symlinks so an attribute change
    // doesn't silently apply to the target.
    let meta_for_check = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if meta_for_check.file_type().is_symlink() {
        return Err("Refusing to change attributes on a symlink".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        crate::native_windows::update_file_attributes(&path, read_only, hidden, system)
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(is_read_only) = read_only {
            let mut perms = fs::metadata(&path)
                .map_err(|e| format!("Failed to read metadata: {}", e))?
                .permissions();
            perms.set_readonly(is_read_only);
            fs::set_permissions(&path, perms)
                .map_err(|e| format!("Failed to update readonly attribute: {}", e))?;
        }

        if hidden.is_some() || system.is_some() {
            return Err(
                "Hidden and System attribute updates are only supported on Windows.".to_string(),
            );
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn read_file_content(
    file_path: String,
    max_size: Option<u64>,
) -> Result<serde_json::Value, String> {
    let path = crate::validate_existing_path(&file_path, "File")?;
    ensure_safe_preview_read_path(&path)?;
    let path = path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve preview path: {}", e))?;
    let limit = max_size
        .unwrap_or(DEFAULT_READ_FILE_CONTENT_LIMIT_BYTES)
        .min(MAX_READ_FILE_CONTENT_LIMIT_BYTES);

    tokio::task::spawn_blocking(move || {
        let mut file = open_regular_read(&path)?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        let file_len = meta.len();
        let is_truncated = file_len > limit;
        let read_len = if is_truncated { limit } else { file_len };
        let mut buffer = vec![0u8; read_len as usize];
        use std::io::Read;
        file.read_exact(&mut buffer)
            .map_err(|e| format!("Failed to read file: {}", e))?;
        let content = String::from_utf8_lossy(&buffer).into_owned();
        Ok(serde_json::json!({
            "content": content,
            "isTruncated": is_truncated,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_file_data_url(file_path: String, max_size: Option<u64>) -> Result<String, String> {
    let path = crate::validate_existing_path(&file_path, "File")?;
    ensure_safe_preview_read_path(&path)?;
    let path = path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve preview path: {}", e))?;
    let limit = max_size
        .unwrap_or(DEFAULT_FILE_DATA_URL_LIMIT_BYTES)
        .min(MAX_FILE_DATA_URL_LIMIT_BYTES);

    tokio::task::spawn_blocking(move || {
        // Keep the size check and read on one open handle. A metadata-then-read
        // by path sequence can be raced by a file replacement or growth and
        // defeat the data-URL memory bound.
        let file = open_regular_read(&path)?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if meta.len() > limit {
            return Err("File too large for data URL".into());
        }
        let capacity =
            usize::try_from(limit.min(meta.len()).saturating_add(1)).unwrap_or(usize::MAX);
        let mut data = Vec::with_capacity(capacity);
        file.take(limit.saturating_add(1))
            .read_to_end(&mut data)
            .map_err(|e| e.to_string())?;
        if data.len() as u64 > limit {
            return Err("File too large for data URL".into());
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let inferred_mime = infer::get(&data).map(|kind| kind.mime_type().to_string());
        let fallback_mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "svg" => "image/svg+xml",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "ico" => "image/x-icon",
            "pdf" => "application/pdf",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            "ogg" => "audio/ogg",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            _ => "application/octet-stream",
        };
        let mime = inferred_mime.as_deref().unwrap_or(fallback_mime);
        use std::io::Write;
        let mut buf = Vec::new();
        write!(buf, "data:{};base64,", mime).map_err(|e| e.to_string())?;
        let encoded = base64_encode(&data);
        buf.extend_from_slice(encoded.as_bytes());
        String::from_utf8(buf).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[(n >> 18 & 63) as usize] as char);
        result.push(CHARS[(n >> 12 & 63) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[(n >> 6 & 63) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(n & 63) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

fn sample_blake3(path: &Path, sample_size: usize) -> Result<String, String> {
    let mut file = open_regular_read(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; sample_size.min(256 * 1024)];
    let n = file.read(&mut buf).map_err(|e| e.to_string())?;
    hasher.update(&buf[..n]);
    Ok(hasher.finalize().to_hex().to_string())
}

#[cfg(test)]
fn full_blake3_reader<R: Read>(
    reader: &mut R,
    cancellation: Option<&CancellationToken>,
) -> Result<String, String> {
    let mut hasher = blake3::Hasher::new();
    let mut buf = [0u8; 8192];
    loop {
        if is_cancelled(cancellation) {
            return Err("Duplicate scan cancelled".to_string());
        }
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if is_cancelled(cancellation) {
            return Err("Duplicate scan cancelled".to_string());
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn full_blake3(
    path: &Path,
    expected_size: u64,
    cancellation: Option<&CancellationToken>,
) -> Result<String, String> {
    let mut file = open_regular_read(path)?;
    let opened_size = file.metadata().map_err(|e| e.to_string())?.len();
    if opened_size != expected_size {
        return Err("Duplicate candidate changed while hashing".to_string());
    }
    if opened_size > DUPLICATE_HASH_MAX_FILE_BYTES {
        return Err("Duplicate candidate exceeds hash size limit".to_string());
    }

    // Hash from the same opened handle whose size was checked. Detect growth
    // and shrink races so a result is never grouped under stale metadata, and
    // cap the stream so an attacker cannot grow a file into an unbounded read.
    let mut hasher = blake3::Hasher::new();
    let mut buf = [0u8; 8192];
    let mut read_total = 0u64;
    loop {
        if is_cancelled(cancellation) {
            return Err("Duplicate scan cancelled".to_string());
        }
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let n_u64 = n as u64;
        if read_total.saturating_add(n_u64) > expected_size {
            return Err("Duplicate candidate changed while hashing".to_string());
        }
        hasher.update(&buf[..n]);
        read_total += n_u64;
    }
    if read_total != expected_size {
        return Err("Duplicate candidate changed while hashing".to_string());
    }
    Ok(hasher.finalize().to_hex().to_string())
}

// M4: cap individual files we will hash during duplicate detection.
// Hashing a multi-gigabyte file end-to-end blocks a worker thread for a long
// time and can exhaust the duplicate scan budget when many large candidates
// exist. Files larger than this are skipped from duplicate comparison.
const DUPLICATE_HASH_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024; // 4 GiB
                                                                   // Cap on total bytes hashed in a single duplicate-finder run as a safety net.
const DUPLICATE_HASH_TOTAL_BYTES_LIMIT: u64 = 64 * 1024 * 1024 * 1024; // 64 GiB
const DUPLICATE_SCAN_MAX_ENTRIES: usize = 1_000_000;
const DUPLICATE_SCAN_OPERATION_ID: &str = "duplicate-scan";

#[tauri::command]
pub async fn find_duplicate_files(
    window: tauri::WebviewWindow,
    dir_path: String,
    min_size: Option<u64>,
    include_hidden: Option<bool>,
) -> Result<DuplicateFindResult, String> {
    // Register before validation so a close/cancel arriving while the command
    // is setting up cannot be lost. Namespace by window so one finder cannot
    // cancel another window's scan; IPC still uses "duplicate-scan".
    let operation_id = duplicate_scan_operation_id(window.label());
    let cancellation = ACTIVE_DUPLICATE_SCANS
        .register(&operation_id)
        .ok_or_else(|| "Duplicate scan operation ID is too long".to_string())
        .map(Some)?;
    let root = match crate::validate_existing_path(&dir_path, "Directory") {
        Ok(path) => path,
        Err(error) => {
            ACTIVE_DUPLICATE_SCANS.finish(&operation_id, cancellation.as_ref());
            return Err(error);
        }
    };
    if !root.is_dir() {
        ACTIVE_DUPLICATE_SCANS.finish(&operation_id, cancellation.as_ref());
        return Err("Path is not a directory".to_string());
    }

    let threshold = min_size.unwrap_or(1);
    let include_hidden = include_hidden.unwrap_or(false);

    // Per-window single-flight: starting a new scan or closing the finder in
    // this window cancels that window's previous scan. IPC still uses the
    // "duplicate-scan" operation id.
    let scan_cancellation = cancellation.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut by_size: HashMap<u64, Vec<PathBuf>> = HashMap::new();
        let mut scan_partial = false;

        for (visited, entry) in walkdir::WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| allow_duplicate_walk_entry(entry, include_hidden))
            .enumerate()
        {
            if is_cancelled(scan_cancellation.as_ref()) {
                return Err("Duplicate scan cancelled".to_string());
            }
            if visited >= DUPLICATE_SCAN_MAX_ENTRIES {
                scan_partial = true;
                log::warn!(
                    "[FileOps] find_duplicate_files: entry limit reached ({}), returning partial results",
                    DUPLICATE_SCAN_MAX_ENTRIES
                );
                break;
            }
            let entry = match entry {
                Ok(value) => value,
                Err(_) => continue,
            };

            if !entry.file_type().is_file() {
                continue;
            }

            let path = entry.path();
            let size = match fs::symlink_metadata(path) {
                Ok(meta) => meta.len(),
                Err(_) => continue,
            };

            if size < threshold {
                continue;
            }
            // M4: skip files that exceed the per-file hash cap. They're
            // unlikely to be true duplicates by happy accident.
            if size > DUPLICATE_HASH_MAX_FILE_BYTES {
                log::debug!(
                    "[FileOps] find_duplicate_files: skipping {} ({} bytes > cap)",
                    path.display(),
                    size
                );
                continue;
            }

            by_size.entry(size).or_default().push(path.to_path_buf());
        }
        let mut total_hashed_bytes: u64 = 0;

        let mut groups: Vec<DuplicateGroup> = Vec::new();

        for (size, candidates) in by_size {
            if candidates.len() < 2 {
                continue;
            }

            let mut by_fast_hash: HashMap<String, Vec<PathBuf>> = HashMap::new();
            for candidate in candidates {
                if is_cancelled(scan_cancellation.as_ref()) {
                    return Err("Duplicate scan cancelled".to_string());
                }
                let fast_hash = sample_blake3(&candidate, 64 * 1024)?;
                by_fast_hash.entry(fast_hash).or_default().push(candidate);
            }

            for (_fast_hash, fast_candidates) in by_fast_hash {
                if fast_candidates.len() < 2 {
                    continue;
                }

                let mut by_full_hash: HashMap<String, Vec<PathBuf>> = HashMap::new();
                for candidate in fast_candidates {
                    if is_cancelled(scan_cancellation.as_ref()) {
                        return Err("Duplicate scan cancelled".to_string());
                    }
                    // M4: bail if we've already hashed more than the total cap.
                    // Returns the partial groups computed so far rather than
                    // failing the whole command — the user still gets results.
                    if size > DUPLICATE_HASH_TOTAL_BYTES_LIMIT.saturating_sub(total_hashed_bytes) {
                        log::warn!(
                            "[FileOps] find_duplicate_files: total hash budget exceeded ({} bytes), returning partial results",
                            total_hashed_bytes
                        );
                        return Ok(DuplicateFindResult {
                            groups,
                            partial: true,
                        });
                    }
                    let full_hash = match full_blake3(&candidate, size, scan_cancellation.as_ref()) {
                        Ok(hash) => hash,
                        Err(error) if error == "Duplicate scan cancelled" => return Err(error),
                        Err(error) => {
                            // Files may disappear or mutate while a long scan
                            // is in progress. Skip that candidate rather than
                            // failing the entire result set; cancellation
                            // remains the only fatal path.
                            log::debug!(
                                "[FileOps] skipping duplicate candidate {}: {}",
                                candidate.display(),
                                error
                            );
                            continue;
                        }
                    };
                    total_hashed_bytes = total_hashed_bytes.saturating_add(size);
                    by_full_hash.entry(full_hash).or_default().push(candidate);
                }

                for (full_hash, dupes) in by_full_hash {
                    if dupes.len() < 2 {
                        continue;
                    }
                    let mut paths = dupes
                        .into_iter()
                        .map(|path| path.to_string_lossy().to_string())
                        .collect::<Vec<_>>();
                    paths.sort();
                    groups.push(DuplicateGroup {
                        size,
                        hash: full_hash,
                        paths,
                    });
                }
            }
        }

        groups.sort_by(|a, b| b.size.cmp(&a.size).then(a.hash.cmp(&b.hash)));
        Ok(DuplicateFindResult {
            groups,
            partial: scan_partial,
        })
    })
    .await
    .map_err(|e| e.to_string());
    ACTIVE_DUPLICATE_SCANS.finish(&operation_id, cancellation.as_ref());
    result?
}

#[tauri::command]
pub async fn batch_rename(items: Vec<serde_json::Value>) -> Result<Vec<serde_json::Value>, String> {
    if items.len() > MAX_MUTATION_ITEMS {
        return Err(format!(
            "Rename list contains too many items (max {})",
            MAX_MUTATION_ITEMS
        ));
    }
    let encoded_size = items
        .iter()
        .map(|item| item.to_string().len())
        .sum::<usize>();
    if encoded_size > MAX_MUTATION_PATH_BYTES {
        return Err(format!(
            "Rename list exceeds aggregate size limit (max {} bytes)",
            MAX_MUTATION_PATH_BYTES
        ));
    }
    tokio::task::spawn_blocking(move || batch_rename_inner(items))
        .await
        .map_err(|e| e.to_string())?
}

fn batch_rename_inner(items: Vec<serde_json::Value>) -> Result<Vec<serde_json::Value>, String> {
    let _lock = mutation_lock()?;
    struct RenameOp {
        old_path_str: String,
        old_path: PathBuf,
        new_path: PathBuf,
    }

    let mut results = Vec::new();
    let mut completed_renames: Vec<(String, String)> = Vec::new();

    // Phase 0: validate all items upfront and build the full plan
    let mut plan: Vec<Result<RenameOp, (String, String)>> = Vec::new();
    let mut target_counts: HashMap<String, usize> = HashMap::new();

    for item in &items {
        let old_path_str = match item["oldPath"].as_str() {
            Some(s) => s.to_string(),
            None => {
                plan.push(Err(("".to_string(), "Missing oldPath".to_string())));
                continue;
            }
        };
        let new_name_raw = match item["newName"].as_str() {
            Some(s) => s,
            None => {
                plan.push(Err((old_path_str, "Missing newName".to_string())));
                continue;
            }
        };
        let new_name = match validate_child_name(new_name_raw, "New name") {
            Ok(n) => n,
            Err(e) => {
                plan.push(Err((old_path_str, e)));
                continue;
            }
        };
        let old_path = match crate::validate_existing_path(&old_path_str, "Item") {
            Ok(p) => p,
            Err(e) => {
                plan.push(Err((old_path_str, e)));
                continue;
            }
        };
        let parent = match old_path.parent() {
            Some(p) => p,
            None => {
                plan.push(Err((old_path_str, "Cannot determine parent".to_string())));
                continue;
            }
        };
        let parent_meta = match fs::symlink_metadata(parent) {
            Ok(meta) => meta,
            Err(e) => {
                plan.push(Err((
                    old_path_str,
                    format!("Failed to access parent directory: {}", e),
                )));
                continue;
            }
        };
        if parent_meta.file_type().is_symlink() || !parent_meta.is_dir() {
            plan.push(Err((
                old_path_str,
                "Refusing to rename through an unsafe parent directory".to_string(),
            )));
            continue;
        }
        let canonical_parent = match parent.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                plan.push(Err((
                    old_path_str,
                    format!("Cannot resolve parent directory: {}", e),
                )));
                continue;
            }
        };
        let source_meta = match fs::symlink_metadata(&old_path) {
            Ok(meta) => meta,
            Err(e) => {
                plan.push(Err((old_path_str, format!("Failed to access item: {}", e))));
                continue;
            }
        };
        if !source_meta.file_type().is_symlink() {
            let canonical_source = match old_path.canonicalize() {
                Ok(p) => p,
                Err(e) => {
                    plan.push(Err((
                        old_path_str,
                        format!("Cannot resolve source path: {}", e),
                    )));
                    continue;
                }
            };
            let canonical_source_parent = match canonical_source.parent() {
                Some(p) => p,
                None => {
                    plan.push(Err((
                        old_path_str,
                        "Cannot determine canonical source parent".to_string(),
                    )));
                    continue;
                }
            };
            if canonical_source_parent != canonical_parent {
                plan.push(Err((
                    old_path_str,
                    "Refusing to rename: source resolves outside its apparent parent (symlink trick)"
                        .to_string(),
                )));
                continue;
            }
        }
        let new_path = parent.join(&new_name);
        *target_counts
            .entry(normalize_case_key(&new_path))
            .or_insert(0) += 1;
        plan.push(Ok(RenameOp {
            old_path_str,
            old_path,
            new_path,
        }));
    }

    let duplicate_indexes: Vec<usize> = plan
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| match entry {
            Ok(op)
                if op.new_path != op.old_path
                    && !same_dir_entry(&op.old_path, &op.new_path)
                    && target_counts
                        .get(&normalize_case_key(&op.new_path))
                        .copied()
                        .unwrap_or(0)
                        > 1 =>
            {
                Some(index)
            }
            _ => None,
        })
        .collect();
    for index in duplicate_indexes {
        if let Ok(op) = &plan[index] {
            plan[index] = Err((
                op.old_path_str.clone(),
                format!("Duplicate target name: {}", op.new_path.display()),
            ));
        }
    }

    let renames = plan
        .iter()
        .filter_map(|entry| entry.as_ref().ok())
        .map(|op| (op.old_path.clone(), op.new_path.clone()))
        .collect::<Vec<_>>();
    let transaction = rename_batch_transaction(&renames);
    for entry in plan {
        match entry {
            Err((old_path, error)) => results.push(serde_json::json!({"oldPath": old_path, "success": false, "error": error})),
            Ok(op) => match &transaction {
                Ok(()) => {
                    let new_path = op.new_path.to_string_lossy().to_string();
                    if op.old_path != op.new_path {
                        completed_renames.push((op.old_path_str.clone(), new_path.clone()));
                    }
                    results.push(serde_json::json!({"oldPath": op.old_path_str, "newPath": new_path, "success": true}));
                }
                Err(error) => results.push(serde_json::json!({"oldPath": op.old_path_str, "success": false, "error": error})),
            }
        }
    }

    undo::push_batch_rename_action(completed_renames).unwrap_or_else(|e| {
        log::warn!("[FileOps] Failed to push batch rename undo action: {}", e);
    });
    Ok(results)
}

#[tauri::command]
pub async fn create_symlink(target_path: String, link_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let _lock = mutation_lock()?;
        let target = crate::validate_existing_path(&target_path, "Target")?;
        let link = crate::validate_path(&link_path, "Link")?;
        let parent = link
            .parent()
            .ok_or_else(|| "Link path has no parent directory".to_string())?;
        let parent_meta = fs::symlink_metadata(parent)
            .map_err(|e| format!("Failed to access link parent directory: {}", e))?;
        if parent_meta.file_type().is_symlink() || !parent_meta.is_dir() {
            return Err(
                "Refusing to create a symlink through an unsafe parent directory".to_string(),
            );
        }

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &link)
                .map_err(|e| format!("Failed to create symlink: {}", e))
        }

        #[cfg(target_os = "windows")]
        {
            let result = if target.is_dir() {
                std::os::windows::fs::symlink_dir(&target, &link)
            } else {
                std::os::windows::fs::symlink_file(&target, &link)
            };
            result.map_err(|e| {
                if e.raw_os_error() == Some(1314) {
                    "Creating symlinks requires administrator privileges on Windows. \
                     Run the app as administrator or enable Developer Mode in Windows Settings."
                        .to_string()
                } else {
                    format!("Failed to create symlink: {}", e)
                }
            })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn resolve_shortcut(shortcut_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || resolve_shortcut_sync(shortcut_path))
        .await
        .map_err(|e| e.to_string())?
}

fn resolve_shortcut_sync(shortcut_path: String) -> Result<String, String> {
    let path = crate::validate_existing_path(&shortcut_path, "Shortcut")?;

    #[cfg(target_os = "windows")]
    {
        resolve_windows_shortcut(&path)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let resolved =
            fs::read_link(&path).map_err(|e| format!("Failed to resolve shortcut: {}", e))?;
        Ok(resolved.to_string_lossy().to_string())
    }
}

#[tauri::command]
pub fn set_clipboard(
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
    clipboard_data: Option<serde_json::Value>,
) -> Result<(), String> {
    // Never log clipboard payloads: paths can contain sensitive filenames and
    // the renderer is allowed to update this state frequently.
    log::debug!(
        "[Clipboard] set_clipboard: {}",
        if clipboard_data.is_some() {
            "set"
        } else {
            "clear"
        }
    );
    let (operation, paths) = if let Some(data) = clipboard_data {
        let operation = data["operation"].as_str().map(str::to_ascii_lowercase);
        if let Some(value) = operation.as_deref() {
            if !matches!(value, "copy" | "cut") {
                return Err("Clipboard operation must be copy or cut".to_string());
            }
        }
        let paths = data["paths"]
            .as_array()
            .map(|arr| {
                if arr.len() > MAX_MUTATION_ITEMS {
                    return Err(format!(
                        "Clipboard contains too many items (max {})",
                        MAX_MUTATION_ITEMS
                    ));
                }
                Ok(arr
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect::<Vec<_>>())
            })
            .transpose()?
            .unwrap_or_default();
        validate_mutation_list(&paths, "Clipboard")?;
        (operation, paths)
    } else {
        (None, Vec::new())
    };

    let mut cb = state.clipboard.lock().map_err(|e| e.to_string())?;
    if operation.is_some() {
        cb.operation = operation;
        cb.paths = paths;
    } else {
        cb.operation = None;
        cb.paths.clear();
    }

    let payload = if let Some(operation) = cb.operation.clone() {
        serde_json::json!({
            "operation": operation,
            "paths": cb.paths.clone(),
        })
    } else {
        serde_json::Value::Null
    };
    drop(cb);
    let _ = app.emit("clipboard-changed", payload);
    Ok(())
}

#[tauri::command]
pub fn get_clipboard(
    state: tauri::State<'_, crate::AppState>,
) -> Result<serde_json::Value, String> {
    let cb = state.clipboard.lock().map_err(|e| e.to_string())?;
    if let Some(ref op) = cb.operation {
        Ok(serde_json::json!({
            "operation": op,
            "paths": cb.paths,
        }))
    } else {
        Ok(serde_json::Value::Null)
    }
}

fn percent_decode_lossy(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut decoded: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hi = bytes[index + 1] as char;
            let lo = bytes[index + 2] as char;
            if let (Some(hi), Some(lo)) = (hi.to_digit(16), lo.to_digit(16)) {
                decoded.push(((hi << 4) | lo) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&decoded).to_string()
}

fn decode_file_uri_path(raw: &str) -> Option<String> {
    let value = raw.trim();
    if !value.to_ascii_lowercase().starts_with("file://") {
        return None;
    }
    let without_scheme = &value[7..];
    let (authority_raw, path_raw) = if let Some(index) = without_scheme.find('/') {
        (&without_scheme[..index], &without_scheme[index..])
    } else {
        (without_scheme, "")
    };
    let authority = percent_decode_lossy(authority_raw);
    let path_part = percent_decode_lossy(path_raw);

    #[cfg(target_os = "windows")]
    {
        let is_drive_authority = authority.len() == 2
            && authority.as_bytes()[1] == b':'
            && authority
                .as_bytes()
                .first()
                .map(|ch| (*ch as char).is_ascii_alphabetic())
                .unwrap_or(false);

        if is_drive_authority {
            let joined = format!("{}{}", authority, path_part);
            return Some(joined.replace('/', "\\"));
        }

        if !authority.is_empty() && !authority.eq_ignore_ascii_case("localhost") {
            let mut unc_path = format!("\\\\{}", authority);
            if !path_part.is_empty() {
                unc_path.push_str(&path_part.replace('/', "\\"));
            }
            return Some(unc_path);
        }

        let mut local_path = path_part;
        if local_path.starts_with('/') && local_path.len() >= 3 && local_path.as_bytes()[2] == b':'
        {
            local_path = local_path[1..].to_string();
        } else if local_path.is_empty() && !authority.is_empty() {
            local_path = authority;
        }

        Some(local_path.replace('/', "\\"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        if !authority.is_empty() && !authority.eq_ignore_ascii_case("localhost") {
            return Some(format!("//{}{}", authority, path_part));
        }

        if path_part.starts_with('/') {
            return Some(path_part);
        }

        if authority.is_empty() {
            return Some(format!("/{}", path_part));
        }

        Some(authority)
    }
}

fn is_absolute_path_like(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }

    #[cfg(target_os = "windows")]
    {
        let mut chars = value.chars();
        if let (Some(first), Some(':')) = (chars.next(), chars.next()) {
            if first.is_ascii_alphabetic() {
                return true;
            }
        }
        value.starts_with("\\\\")
    }

    #[cfg(not(target_os = "windows"))]
    {
        value.starts_with('/')
    }
}

fn parse_clipboard_paths(text: &str) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut paths: Vec<String> = Vec::new();

    for line in text
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
    {
        if paths.len() >= MAX_MUTATION_ITEMS {
            break;
        }
        let candidate = if let Some(path) = decode_file_uri_path(line) {
            Some(path)
        } else if is_absolute_path_like(line) {
            Some(line.to_string())
        } else {
            None
        };

        if let Some(path) = candidate {
            if path.len() > MAX_MUTATION_PATH_BYTES {
                continue;
            }
            let key = normalize_case_key(Path::new(&path));
            if seen.insert(key) {
                paths.push(path);
            }
        }
    }

    paths
}

#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
fn bound_clipboard_paths(paths: Vec<String>) -> Vec<String> {
    let mut total = 0usize;
    paths
        .into_iter()
        .filter_map(|path| {
            if path.len() > MAX_MUTATION_PATH_BYTES
                || total.saturating_add(path.len()) > MAX_MUTATION_PATH_BYTES
            {
                return None;
            }
            total = total.saturating_add(path.len());
            Some(path)
        })
        .take(MAX_MUTATION_ITEMS)
        .collect()
}

#[cfg(test)]
#[path = "file_operations_tests.rs"]
mod tests;

#[cfg(target_os = "linux")]
const CLIPBOARD_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(target_os = "linux")]
fn run_command_capture(command: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(command);
    cmd.args(args);
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take((MAX_CLIPBOARD_TEXT_BYTES as u64).saturating_add(1))
            .read_to_end(&mut bytes);
        (result, bytes)
    });
    let deadline = Instant::now() + CLIPBOARD_COMMAND_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return None;
            }
        }
    };
    let (read_result, bytes) = reader.join().ok()?;
    if read_result.is_err() || bytes.len() > MAX_CLIPBOARD_TEXT_BYTES {
        return None;
    }
    if !status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).to_string())
}

#[cfg(target_os = "windows")]
fn get_windows_system_clipboard_files() -> (Vec<String>, Option<&'static str>) {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::*;
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::{DragQueryFileW, CFSTR_PREFERREDDROPEFFECT};

    unsafe {
        if OpenClipboard(None).is_err() {
            return (Vec::new(), None);
        }

        let result = (|| {
            let handle = GetClipboardData(CF_HDROP.0 as u32);
            let handle = match handle {
                Ok(h) => h,
                Err(_) => return (Vec::new(), None),
            };

            let hdrop = windows::Win32::UI::Shell::HDROP(handle.0);
            let count = DragQueryFileW(hdrop, 0xFFFFFFFF, None);
            if count == 0 {
                return (Vec::new(), None);
            }

            let count = count.min(MAX_MUTATION_ITEMS as u32);
            let mut paths = Vec::with_capacity(count as usize);
            for i in 0..count {
                let len = DragQueryFileW(hdrop, i, None);
                if len == 0 {
                    continue;
                }
                let mut buf = vec![0u16; (len + 1) as usize];
                DragQueryFileW(hdrop, i, Some(&mut buf));
                let path = String::from_utf16_lossy(&buf[..len as usize]);
                paths.push(path);
            }
            let preferred_effect = RegisterClipboardFormatW(CFSTR_PREFERREDDROPEFFECT);
            let operation = if preferred_effect == 0 {
                None
            } else {
                GetClipboardData(preferred_effect).ok().and_then(|handle| {
                    let global = HGLOBAL(handle.0);
                    if GlobalSize(global) < std::mem::size_of::<u32>() {
                        return None;
                    }
                    let pointer = GlobalLock(global);
                    if pointer.is_null() {
                        return None;
                    }
                    let effect = std::ptr::read_unaligned(pointer.cast::<u32>());
                    let _ = GlobalUnlock(global);
                    clipboard_operation_from_preferred_drop_effect(Some(effect))
                })
            };
            (paths, operation)
        })();

        let _ = CloseClipboard();
        result
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn clipboard_operation_from_preferred_drop_effect(effect: Option<u32>) -> Option<&'static str> {
    const DROP_EFFECT_COPY: u32 = 1;
    const DROP_EFFECT_MOVE: u32 = 2;

    match effect {
        Some(value) if value & DROP_EFFECT_MOVE != 0 => Some("cut"),
        Some(value) if value & DROP_EFFECT_COPY != 0 => Some("copy"),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn get_windows_system_clipboard_text_paths() -> Vec<String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::*;
    use windows::Win32::System::Memory::*;
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    unsafe {
        if OpenClipboard(None).is_err() {
            return Vec::new();
        }

        let result = (|| {
            let handle = GetClipboardData(CF_UNICODETEXT.0 as u32);
            let handle = match handle {
                Ok(h) => h,
                Err(_) => return Vec::new(),
            };

            let hglobal = HGLOBAL(handle.0);
            let ptr = GlobalLock(hglobal);
            if ptr.is_null() {
                return Vec::new();
            }

            let max_units = GlobalSize(hglobal) / std::mem::size_of::<u16>();
            if max_units == 0 {
                let _ = GlobalUnlock(hglobal);
                return Vec::new();
            }
            if max_units > MAX_CLIPBOARD_TEXT_BYTES / std::mem::size_of::<u16>() {
                let _ = GlobalUnlock(hglobal);
                return Vec::new();
            }

            let wide = ptr as *const u16;
            let mut len = 0usize;
            while len < max_units && *wide.add(len) != 0 {
                len += 1;
            }
            let slice = std::slice::from_raw_parts(wide, len);
            let text = String::from_utf16_lossy(slice);
            let _ = GlobalUnlock(hglobal);
            parse_clipboard_paths(&text)
        })();

        let _ = CloseClipboard();
        result
    }
}

#[cfg(target_os = "windows")]
fn write_windows_system_clipboard_text(text: &str) -> Result<(), String> {
    use windows::Win32::System::DataExchange::*;
    use windows::Win32::System::Memory::*;
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    unsafe fn global_free(hmem: windows::Win32::Foundation::HGLOBAL) {
        extern "system" {
            fn GlobalFree(hmem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
        }
        GlobalFree(hmem.0);
    }

    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let byte_len = wide.len() * 2;

    unsafe {
        OpenClipboard(None).map_err(|e| format!("Failed to open clipboard: {}", e))?;

        let cleanup_and_err = |msg: String| -> Result<(), String> {
            let _ = CloseClipboard();
            Err(msg)
        };

        if EmptyClipboard().is_err() {
            return cleanup_and_err("Failed to empty clipboard".into());
        }

        let hmem = GlobalAlloc(GMEM_MOVEABLE, byte_len);
        let hmem = match hmem {
            Ok(h) => h,
            Err(e) => return cleanup_and_err(format!("Failed to allocate memory: {}", e)),
        };

        let ptr = GlobalLock(hmem);
        if ptr.is_null() {
            global_free(hmem);
            return cleanup_and_err("Failed to lock memory".into());
        }

        std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, ptr as *mut u8, byte_len);
        let _ = GlobalUnlock(hmem);

        let handle = windows::Win32::Foundation::HANDLE(hmem.0);
        if SetClipboardData(CF_UNICODETEXT.0 as u32, handle).is_err() {
            global_free(hmem);
            return cleanup_and_err("Failed to set clipboard data".into());
        }

        let _ = CloseClipboard();
        Ok(())
    }
}

fn get_system_clipboard_files_internal() -> (Vec<String>, Option<&'static str>) {
    #[cfg(target_os = "windows")]
    {
        let (files, operation) = get_windows_system_clipboard_files();
        if !files.is_empty() {
            return (bound_clipboard_paths(files), operation);
        }
        (
            bound_clipboard_paths(get_windows_system_clipboard_text_paths()),
            None,
        )
    }

    #[cfg(target_os = "macos")]
    {
        let files = bound_clipboard_paths(crate::native_macos::clipboard_file_paths());
        if !files.is_empty() {
            return (files, None);
        }
        (
            crate::native_macos::clipboard_text()
                .map(|output| parse_clipboard_paths(&output))
                .unwrap_or_default(),
            None,
        )
    }

    #[cfg(target_os = "linux")]
    {
        let text = run_command_capture("wl-paste", &["-n", "-t", "text/uri-list"])
            .or_else(|| run_command_capture("xclip", &["-selection", "clipboard", "-o"]))
            .or_else(|| run_command_capture("xsel", &["--clipboard", "--output"]))
            .unwrap_or_default();
        (parse_clipboard_paths(&text), None)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        (Vec::new(), None)
    }
}

fn clipboard_paths_match(paths_a: &[String], paths_b: &[String]) -> bool {
    if paths_a.len() != paths_b.len() {
        return false;
    }

    let set_a: HashSet<String> = paths_a
        .iter()
        .map(|path| normalize_case_key(Path::new(path)))
        .collect();
    let set_b: HashSet<String> = paths_b
        .iter()
        .map(|path| normalize_case_key(Path::new(path)))
        .collect();
    set_a == set_b
}

#[tauri::command]
pub async fn get_system_clipboard_data(
    state: tauri::State<'_, crate::AppState>,
) -> Result<serde_json::Value, String> {
    log::debug!("[Clipboard] get_system_clipboard_data");
    // Clipboard backends shell out on Linux and call native APIs elsewhere.
    // Keep that potentially blocking work off the command/UI thread.
    let (system_paths, system_operation) =
        tokio::task::spawn_blocking(get_system_clipboard_files_internal)
            .await
            .map_err(|error| error.to_string())?;
    if !system_paths.is_empty() {
        let cb = state.clipboard.lock().map_err(|e| e.to_string())?;
        let operation = match system_operation {
            Some(operation) => operation,
            None if cb.operation.as_deref() == Some("cut")
                && clipboard_paths_match(&cb.paths, &system_paths) =>
            {
                "cut"
            }
            None => "copy",
        };
        return Ok(serde_json::json!({
            "operation": operation,
            "paths": system_paths,
        }));
    }

    get_clipboard(state)
}

#[tauri::command]
pub async fn get_system_clipboard_files(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<String>, String> {
    log::debug!("[Clipboard] get_system_clipboard_files");
    let (system_paths, _) = tokio::task::spawn_blocking(get_system_clipboard_files_internal)
        .await
        .map_err(|error| error.to_string())?;
    if !system_paths.is_empty() {
        return Ok(system_paths);
    }
    let cb = state.clipboard.lock().map_err(|e| e.to_string())?;
    Ok(cb.paths.clone())
}

#[tauri::command]
pub async fn write_to_system_clipboard(text: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || write_to_system_clipboard_sync(text))
        .await
        .map_err(|error| error.to_string())?
}

fn write_to_system_clipboard_sync(text: String) -> Result<(), String> {
    log::debug!(
        "[Clipboard] write_to_system_clipboard ({} chars)",
        text.len()
    );
    if text.len() > MAX_CLIPBOARD_TEXT_BYTES {
        return Err(format!(
            "Clipboard text exceeds the {} byte limit",
            MAX_CLIPBOARD_TEXT_BYTES
        ));
    }
    #[cfg(target_os = "windows")]
    {
        write_windows_system_clipboard_text(&text)
    }

    #[cfg(target_os = "macos")]
    {
        crate::native_macos::set_clipboard_text(&text)
    }

    #[cfg(target_os = "linux")]
    {
        let try_copy = |cmd_name: &str, args: &[&str]| -> Result<(), String> {
            let mut cmd = Command::new(cmd_name);
            cmd.args(args).stdin(std::process::Stdio::piped());
            let mut child = cmd.spawn().map_err(|e| e.to_string())?;
            let Some(mut stdin) = child.stdin.take() else {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Clipboard helper did not expose stdin".to_string());
            };
            let bytes = text.as_bytes().to_vec();
            let writer = std::thread::spawn(move || {
                use std::io::Write;
                let result = stdin.write_all(&bytes);
                drop(stdin);
                result
            });
            let deadline = Instant::now() + CLIPBOARD_COMMAND_TIMEOUT;
            let status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break status,
                    Ok(None) if Instant::now() >= deadline => {
                        let _ = child.kill();
                        let _ = child.wait();
                        let _ = writer.join();
                        return Err("Clipboard helper timed out".to_string());
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                    Err(error) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        let _ = writer.join();
                        return Err(error.to_string());
                    }
                }
            };
            writer
                .join()
                .map_err(|_| "Clipboard writer thread panicked".to_string())?
                .map_err(|e| e.to_string())?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("Clipboard helper exited with {}", status))
            }
        };

        if try_copy("wl-copy", &[]).is_ok() {
            return Ok(());
        }
        if try_copy("xclip", &["-selection", "clipboard"]).is_ok() {
            return Ok(());
        }
        if try_copy("xsel", &["--clipboard", "--input"]).is_ok() {
            return Ok(());
        }
        Err("No clipboard tool found".into())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = text;
        Err("Clipboard not supported on this platform".into())
    }
}

#[tauri::command]
pub fn set_drag_data(
    state: tauri::State<'_, crate::AppState>,
    paths: Vec<String>,
) -> Result<(), String> {
    validate_mutation_list(&paths, "Drag list")?;
    for path in &paths {
        crate::validate_existing_path(path, "Drag item")?;
    }
    let mut drag = state.drag.lock().map_err(|e| e.to_string())?;
    drag.paths = paths;
    Ok(())
}

#[tauri::command]
pub fn get_drag_data(state: tauri::State<'_, crate::AppState>) -> Result<Vec<String>, String> {
    let drag = state.drag.lock().map_err(|e| e.to_string())?;
    Ok(drag.paths.clone())
}

#[tauri::command]
pub fn clear_drag_data(state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    let mut drag = state.drag.lock().map_err(|e| e.to_string())?;
    drag.paths.clear();
    Ok(())
}

#[tauri::command]
pub async fn calculate_checksum(
    file_path: String,
    operation_id: String,
    algorithms: Vec<String>,
    webview: tauri::WebviewWindow,
) -> Result<serde_json::Value, String> {
    if operation_id.is_empty() {
        return Err("Checksum operation ID is required".to_string());
    }
    let cancellation = ACTIVE_CHECKSUMS
        .register(&operation_id)
        .ok_or_else(|| "Checksum operation ID is too long".to_string())?;

    const MAX_CHECKSUM_ALGORITHMS: usize = 16;
    const MAX_CHECKSUM_ALGORITHM_BYTES: usize = 4096;
    if algorithms.len() > MAX_CHECKSUM_ALGORITHMS
        || algorithms.iter().map(String::len).sum::<usize>() > MAX_CHECKSUM_ALGORITHM_BYTES
    {
        ACTIVE_CHECKSUMS.finish(&operation_id, Some(&cancellation));
        return Err(format!(
            "Too many checksum algorithms (max {})",
            MAX_CHECKSUM_ALGORITHMS
        ));
    }

    let path = match crate::validate_existing_path(&file_path, "File") {
        Ok(path) => path,
        Err(error) => {
            ACTIVE_CHECKSUMS.finish(&operation_id, Some(&cancellation));
            return Err(error);
        }
    };
    if let Err(error) = ensure_safe_preview_read_path(&path) {
        ACTIVE_CHECKSUMS.finish(&operation_id, Some(&cancellation));
        return Err(error);
    } // don't hash secrets (ssh keys, .pem, etc.)
    let path = match path.canonicalize() {
        Ok(path) => path,
        Err(error) => {
            ACTIVE_CHECKSUMS.finish(&operation_id, Some(&cancellation));
            return Err(format!("Failed to resolve checksum path: {}", error));
        }
    };

    let normalized_algorithms: Vec<String> = algorithms
        .iter()
        .map(|algorithm| algorithm.to_ascii_lowercase())
        .collect();
    if normalized_algorithms.is_empty() {
        ACTIVE_CHECKSUMS.finish(&operation_id, Some(&cancellation));
        return Err("At least one checksum algorithm is required".to_string());
    }
    for algorithm in &normalized_algorithms {
        if !matches!(
            algorithm.as_str(),
            "sha256" | "sha512" | "md5" | "crc32" | "blake3"
        ) {
            ACTIVE_CHECKSUMS.finish(&operation_id, Some(&cancellation));
            return Err(format!("Unknown algorithm: {}", algorithm));
        }
    }

    let op_id = operation_id.clone();
    let scan_cancellation = cancellation.clone();
    let result = tokio::task::spawn_blocking(move || {
        use md5::Md5;
        use sha2::{Digest, Sha256, Sha512};

        enum HasherState {
            Sha256(Sha256),
            Sha512(Sha512),
            Md5(Md5),
            Crc32(crc32fast::Hasher),
            Blake3(Box<blake3::Hasher>),
        }

        impl HasherState {
            fn update(&mut self, chunk: &[u8]) {
                match self {
                    Self::Sha256(hasher) => hasher.update(chunk),
                    Self::Sha512(hasher) => hasher.update(chunk),
                    Self::Md5(hasher) => hasher.update(chunk),
                    Self::Crc32(hasher) => hasher.update(chunk),
                    Self::Blake3(hasher) => {
                        hasher.update(chunk);
                    }
                }
            }

            fn finalize(self) -> String {
                match self {
                    Self::Sha256(hasher) => hex::encode(hasher.finalize()),
                    Self::Sha512(hasher) => hex::encode(hasher.finalize()),
                    Self::Md5(hasher) => hex::encode(hasher.finalize()),
                    Self::Crc32(hasher) => format!("{:08x}", hasher.finalize()),
                    Self::Blake3(hasher) => hasher.finalize().to_hex().to_string(),
                }
            }
        }

        const MAX_CHECKSUM_SIZE: u64 = 4 * 1024 * 1024 * 1024; // 4 GB
                                                               // Open once, without following a swapped symlink or special file, and
                                                               // derive the size from that same handle to avoid a metadata/open race.
        let mut file = open_regular_read(&path)?;
        let file_size = file.metadata().map_err(|e| e.to_string())?.len();
        if file_size > MAX_CHECKSUM_SIZE {
            return Err(format!(
                "File too large for checksum ({} MB, max {} MB)",
                file_size / (1024 * 1024),
                MAX_CHECKSUM_SIZE / (1024 * 1024)
            ));
        }
        let mut states: Vec<(String, HasherState)> = Vec::new();
        for algorithm in &normalized_algorithms {
            if states.iter().any(|(name, _)| name == algorithm) {
                continue;
            }
            let state = match algorithm.as_str() {
                "sha256" => HasherState::Sha256(Sha256::new()),
                "sha512" => HasherState::Sha512(Sha512::new()),
                "md5" => HasherState::Md5(Md5::new()),
                "crc32" => HasherState::Crc32(crc32fast::Hasher::new()),
                "blake3" => HasherState::Blake3(Box::new(blake3::Hasher::new())),
                _ => unreachable!("algorithms validated before spawn"),
            };
            states.push((algorithm.clone(), state));
        }

        let progress_algorithms = algorithms.clone();
        read_file_chunks(
            &mut file,
            file_size,
            |chunk| {
                for (_, state) in &mut states {
                    state.update(chunk);
                }
            },
            || Ok(!is_cancelled(Some(&scan_cancellation))),
            |percent| {
                for algorithm in &progress_algorithms {
                    let _ = webview.emit(
                        "checksum-progress",
                        serde_json::json!({
                            "operationId": op_id, "percent": percent, "algorithm": algorithm
                        }),
                    );
                }
            },
        )?;

        let hashes: HashMap<String, String> = states
            .into_iter()
            .map(|(algorithm, state)| (algorithm, state.finalize()))
            .collect();
        let mut results = serde_json::Map::new();
        for (original, normalized) in algorithms.iter().zip(normalized_algorithms.iter()) {
            let hash = hashes
                .get(normalized)
                .ok_or_else(|| format!("Unknown algorithm: {}", original))?;
            results.insert(original.clone(), serde_json::Value::String(hash.clone()));
        }

        Ok(serde_json::Value::Object(results))
    })
    .await;

    ACTIVE_CHECKSUMS.finish(&operation_id, Some(&cancellation));

    result.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cancel_checksum_calculation(operation_id: String) -> Result<(), String> {
    ACTIVE_CHECKSUMS.cancel(&operation_id);
    Ok(())
}

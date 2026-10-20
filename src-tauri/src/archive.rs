use crate::cancellation::{is_cancelled, CancellationRegistry, CancellationToken};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};
use tauri::Emitter;
use zip::unstable::write::FileOptionsExt;

static ACTIVE_OPS: std::sync::LazyLock<CancellationRegistry> =
    std::sync::LazyLock::new(CancellationRegistry::default);
static RELATIONSHIP_TAG_RE: std::sync::LazyLock<Option<Regex>> =
    std::sync::LazyLock::new(|| Regex::new(r#"(?is)<Relationship\b[^>]*>"#).ok());
// Rust's regex crate does not support backreferences. Use alternation so we
// match either a double-quoted or single-quoted attribute value, then strip
// the matching quote characters in extract_xml_attr().
static XML_ATTRIBUTE_RE: std::sync::LazyLock<Option<Regex>> = std::sync::LazyLock::new(|| {
    Regex::new(r#"(?is)([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("[^"]*"|'[^']*')"#).ok()
});

const MAX_DECOMPRESSED_SIZE: u64 = 53_687_091_200; // 50 GB
const MAX_ARCHIVE_DEPTH: usize = 20;
const MAX_EXTRACT_ENTRIES: usize = 100_000;
const MAX_ARCHIVE_ENTRY_NAME_BYTES: usize = 1024 * 1024;
const MAX_LIST_NAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_COMPRESS_SOURCES: usize = 10_000;
const MAX_COMPRESS_SOURCE_PATH_BYTES: usize = 8 * 1024 * 1024;
const MAX_ADVANCED_OPTIONS_BYTES: usize = 1024 * 1024;
const MAX_RELATIONSHIP_BYTES: u64 = 256 * 1024;
const DEFAULT_OFFICE_THUMBNAIL_LIMIT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_OFFICE_THUMBNAIL_LIMIT_BYTES: u64 = 20 * 1024 * 1024;

struct CancellableReader<R> {
    inner: R,
    cancellation: Option<CancellationToken>,
}

impl<R: Read> Read for CancellableReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if is_cancelled(self.cancellation.as_ref()) {
            return Err(std::io::Error::other("Operation cancelled"));
        }
        let length = buffer.len().min(1024 * 1024);
        self.inner.read(&mut buffer[..length])
    }
}

fn cancellable_reader<R>(
    inner: R,
    cancellation: Option<&CancellationToken>,
) -> CancellableReader<R> {
    CancellableReader {
        inner,
        cancellation: cancellation.cloned(),
    }
}

fn append_tar_file<W: Write>(
    tar: &mut tar::Builder<W>,
    path: &Path,
    name: &Path,
    cancellation: Option<&CancellationToken>,
) -> Result<(), String> {
    let file = open_regular_read(path)?;
    let mut header = tar::Header::new_gnu();
    header.set_metadata(&file.metadata().map_err(|e| e.to_string())?);
    tar.append_data(&mut header, name, cancellable_reader(file, cancellation))
        .map_err(|e| e.to_string())
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdvancedCompressOptions {
    compression_level: Option<u32>,
    dictionary_size: Option<String>,
    password: Option<String>,
    encrypt_file_names: Option<bool>,
    method: Option<String>,
    encryption_method: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ArchiveExtractKind {
    TarXz,
    TarGz,
    TarBz2,
    Zip,
    Tar,
    SevenZ,
    GzipSingle,
    XzSingle,
}

fn resolve_extract_kind(archive: &Path) -> Result<ArchiveExtractKind, String> {
    let full_name = archive.to_string_lossy().to_lowercase();
    if full_name.ends_with(".tar.xz") || full_name.ends_with(".txz") {
        return Ok(ArchiveExtractKind::TarXz);
    }
    if full_name.ends_with(".tar.gz") || full_name.ends_with(".tgz") {
        return Ok(ArchiveExtractKind::TarGz);
    }
    if full_name.ends_with(".tar.bz2")
        || full_name.ends_with(".tbz2")
        || full_name.ends_with(".tbz")
    {
        return Ok(ArchiveExtractKind::TarBz2);
    }

    let ext = archive
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "zip" => Ok(ArchiveExtractKind::Zip),
        "tar" => Ok(ArchiveExtractKind::Tar),
        "7z" => Ok(ArchiveExtractKind::SevenZ),
        "gz" => Ok(ArchiveExtractKind::GzipSingle),
        "xz" => Ok(ArchiveExtractKind::XzSingle),
        _ => Err(format!("Unsupported archive format: {}", ext)),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_directory: bool,
    pub compressed_size: u64,
}

fn is_active(cancellation: Option<&CancellationToken>) -> bool {
    !is_cancelled(cancellation)
}

fn register_archive_operation(operation_id: &str) -> Result<Option<CancellationToken>, String> {
    if operation_id.is_empty() {
        return Ok(None);
    }
    ACTIVE_OPS
        .register(operation_id)
        .ok_or_else(|| "Archive operation ID is too long".to_string())
        .map(Some)
}

fn validate_compression_source(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Refusing to compress symbolic-link source: {}",
            path.display()
        ));
    }
    if !metadata.is_dir() && !metadata.is_file() {
        return Err(format!(
            "Refusing to compress non-regular source: {}",
            path.display()
        ));
    }
    Ok(metadata)
}

fn open_regular_read(path: &Path) -> Result<fs::File, String> {
    crate::file_operations::open_regular_read(path)
}

fn copy_reader_cancellable<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    cancellation: Option<&CancellationToken>,
) -> Result<u64, String> {
    let mut buffer = [0u8; 1024 * 1024];
    let mut total = 0u64;
    loop {
        if !is_active(cancellation) {
            return Err("Operation cancelled".to_string());
        }
        let read = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            return Ok(total);
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|e| e.to_string())?;
        total = total.saturating_add(read as u64);
    }
}

fn safe_entry_path(entry_name: &str, dest: &Path) -> Result<PathBuf, String> {
    // H4: hard-fail if the destination cannot be canonicalized. Previously
    // we fell back to dest.to_path_buf(), which silently degrades the
    // traversal check on filesystems where canonicalize fails (network
    // drive hiccup, permission glitch). For an extraction routine the
    // safe default is "refuse" not "best-effort."
    let destination_meta = fs::symlink_metadata(dest).map_err(|e| {
        format!(
            "Refusing to extract into {} (cannot inspect destination: {})",
            dest.display(),
            e
        )
    })?;
    if destination_meta.file_type().is_symlink() || !destination_meta.is_dir() {
        return Err(format!(
            "Refusing to extract into {} (destination is not a real directory)",
            dest.display()
        ));
    }
    let canonical_dest = dest.canonicalize().map_err(|e| {
        format!(
            "Refusing to extract into {} (cannot canonicalize: {})",
            dest.display(),
            e
        )
    })?;

    let mut component_path = canonical_dest.clone();
    let mut depth: usize = 0;
    for component in std::path::Path::new(entry_name).components() {
        match component {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(format!("Path traversal detected: {}", entry_name));
            }
            std::path::Component::CurDir => {}
            std::path::Component::Normal(part) => {
                depth += 1;
                if depth > MAX_ARCHIVE_DEPTH {
                    return Err(format!(
                        "Archive entry exceeds max nesting depth ({}): {}",
                        MAX_ARCHIVE_DEPTH, entry_name
                    ));
                }
                component_path.push(part);
                if let Ok(meta) = fs::symlink_metadata(&component_path) {
                    if meta.file_type().is_symlink() {
                        return Err(format!(
                            "Refusing to extract through symlink path: {}",
                            entry_name
                        ));
                    }
                }
            }
        }
    }

    let path = dest.join(entry_name);
    let parent = path.parent().ok_or_else(|| {
        format!(
            "Refusing to extract {} (cannot determine destination parent)",
            entry_name
        )
    })?;
    // New nested directories do not exist until extraction creates them, so
    // canonicalize the nearest existing ancestor and append only the missing
    // components. Any non-ENOENT metadata error remains fail-closed.
    let mut missing_components = Vec::new();
    let mut existing_parent = parent;
    loop {
        match fs::symlink_metadata(existing_parent) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let component = existing_parent.file_name().ok_or_else(|| {
                    format!(
                        "Refusing to extract {} (cannot determine existing destination ancestor)",
                        entry_name
                    )
                })?;
                missing_components.push(component.to_os_string());
                existing_parent = existing_parent.parent().ok_or_else(|| {
                    format!(
                        "Refusing to extract {} (cannot determine existing destination ancestor)",
                        entry_name
                    )
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "Refusing to extract {} (cannot inspect destination parent: {})",
                    entry_name, error
                ));
            }
        }
    }
    let mut canonical_path = existing_parent.canonicalize().map_err(|e| {
        format!(
            "Refusing to extract {} (cannot canonicalize destination parent: {})",
            entry_name, e
        )
    })?;
    for component in missing_components.iter().rev() {
        canonical_path.push(component);
    }

    if !canonical_path.starts_with(&canonical_dest) {
        return Err(format!("Path traversal detected: {}", entry_name));
    }
    Ok(path)
}

fn resolve_from_nearest_existing_parent(dest: &Path) -> Result<(PathBuf, bool), String> {
    let mut missing_components = Vec::new();
    let mut existing = dest.to_path_buf();
    loop {
        match fs::symlink_metadata(&existing) {
            Ok(meta) if existing.as_path() == dest => {
                if meta.file_type().is_symlink() {
                    return Err("Refusing to extract into a symbolic-link destination".to_string());
                }
                if !meta.is_dir() {
                    return Err("Extraction destination is not a directory".to_string());
                }
                let canonical = dest.canonicalize().map_err(|e| {
                    format!(
                        "Cannot canonicalize extraction destination {}: {}",
                        dest.display(),
                        e
                    )
                })?;
                return Ok((canonical, true));
            }
            Ok(meta) if meta.file_type().is_symlink() || meta.is_dir() => break,
            Ok(_) => {
                return Err(format!(
                    "Extraction destination ancestor is not a directory: {}",
                    existing.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let component = existing.file_name().ok_or_else(|| {
                    format!(
                        "Failed to inspect extraction destination ancestor {}",
                        existing.display()
                    )
                })?;
                missing_components.push(component.to_os_string());
                existing = existing
                    .parent()
                    .ok_or_else(|| {
                        format!(
                            "Failed to inspect extraction destination ancestor {}",
                            dest.display()
                        )
                    })?
                    .to_path_buf();
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect extraction destination ancestor {}: {}",
                    existing.display(),
                    error
                ));
            }
        }
    }
    let canonical_parent = existing.canonicalize().map_err(|e| {
        format!(
            "Cannot canonicalize extraction destination parent {}: {}",
            existing.display(),
            e
        )
    })?;
    let mut resolved = canonical_parent;
    for component in missing_components.iter().rev() {
        resolved.push(component);
    }
    Ok((resolved, false))
}

fn prepare_extraction_destination(dest: &Path) -> Result<(PathBuf, bool), String> {
    // Resolve from the nearest existing parent after canonicalize so benign
    // system symlinks (macOS /var, /tmp, tempfile paths under /var/folders)
    // are accepted. The destination itself must still be a real directory.
    let (resolved, preexisted) = resolve_from_nearest_existing_parent(dest)?;
    if !preexisted {
        let mut created = Vec::new();
        if let Err(error) = create_dir_all_tracked(&resolved, &mut created) {
            cleanup_extracted_paths(&created);
            return Err(error);
        }
    }
    let metadata = fs::symlink_metadata(&resolved).map_err(|e| {
        format!(
            "Failed to re-check extraction destination {}: {}",
            resolved.display(),
            e
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Extraction destination changed into a non-directory".to_string());
    }
    let canonical = resolved.canonicalize().map_err(|e| {
        format!(
            "Cannot canonicalize extraction destination {}: {}",
            resolved.display(),
            e
        )
    })?;
    Ok((canonical, preexisted))
}

fn ensure_compress_entry_depth(entry_name: &str) -> Result<(), String> {
    ensure_archive_entry_name_size(entry_name)?;
    let depth = std::path::Path::new(entry_name)
        .components()
        .filter(|component| matches!(component, std::path::Component::Normal(_)))
        .count();
    if depth > MAX_ARCHIVE_DEPTH {
        return Err(format!(
            "Archive path exceeds max nesting depth ({}): {}",
            MAX_ARCHIVE_DEPTH, entry_name
        ));
    }
    Ok(())
}

fn ensure_archive_entry_name_size(name: &str) -> Result<(), String> {
    if name.len() > MAX_ARCHIVE_ENTRY_NAME_BYTES {
        return Err(format!(
            "Archive entry name exceeds limit ({} bytes)",
            MAX_ARCHIVE_ENTRY_NAME_BYTES
        ));
    }
    Ok(())
}

fn account_list_entry_name(total: &mut usize, name: &str) -> Result<(), String> {
    ensure_archive_entry_name_size(name)?;
    *total = total.saturating_add(name.len());
    if *total > MAX_LIST_NAME_BYTES {
        return Err(format!(
            "Archive entry names exceed listing memory limit ({} bytes)",
            MAX_LIST_NAME_BYTES
        ));
    }
    Ok(())
}

fn ensure_path_within_dest(path: &Path, dest: &Path, entry_name: &str) -> Result<(), String> {
    // H4: hard-fail on canonicalize failure for the destination as well.
    let canonical_dest = dest.canonicalize().map_err(|e| {
        format!(
            "Refusing to verify extraction (cannot canonicalize dest {}): {}",
            dest.display(),
            e
        )
    })?;
    let canonical_path = path.canonicalize().map_err(|e| {
        format!(
            "Failed to resolve extraction path for {}: {}",
            entry_name, e
        )
    })?;
    if !canonical_path.starts_with(&canonical_dest) {
        return Err(format!("Path traversal detected: {}", entry_name));
    }
    Ok(())
}

fn canonicalize_for_comparison(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }

    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };

    if let Some(parent) = absolute.parent() {
        if let Ok(canonical_parent) = parent.canonicalize() {
            if let Some(name) = absolute.file_name() {
                return canonical_parent.join(name);
            }
        }
    }

    absolute
}

fn cleanup_extracted_paths(extracted: &[PathBuf]) {
    for path in extracted.iter().rev() {
        if let Ok(meta) = fs::symlink_metadata(path) {
            if meta.is_dir() {
                let _ = fs::remove_dir(path);
            } else {
                let _ = fs::remove_file(path);
            }
        }
    }
}

fn create_dir_all_tracked(path: &Path, extracted: &mut Vec<PathBuf>) -> Result<(), String> {
    let mut created = Vec::new();
    let mut cursor = Some(path);
    while let Some(current) = cursor {
        match fs::symlink_metadata(current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!(
                    "Refusing to create extraction directory through symlink: {}",
                    current.display()
                ));
            }
            Ok(meta) if meta.is_dir() => break,
            Ok(_) => {
                return Err(format!(
                    "Extraction path is not a directory: {}",
                    current.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                created.push(current.to_path_buf());
                cursor = current.parent();
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect extraction directory {}: {}",
                    current.display(),
                    error
                ));
            }
        }
    }
    for created_path in created.into_iter().rev() {
        let (meta, created_here) = match fs::symlink_metadata(&created_path) {
            Ok(meta) => (meta, false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match fs::create_dir(&created_path) {
                    Ok(()) => {
                        let meta = match fs::symlink_metadata(&created_path) {
                            Ok(meta) => meta,
                            Err(error) => {
                                let _ = fs::remove_dir(&created_path);
                                return Err(format!(
                                    "Failed to verify extraction directory {}: {}",
                                    created_path.display(),
                                    error
                                ));
                            }
                        };
                        (meta, true)
                    }
                    Err(create_error)
                        if create_error.kind() == std::io::ErrorKind::AlreadyExists =>
                    {
                        (
                            fs::symlink_metadata(&created_path).map_err(|e| {
                                format!(
                                    "Failed to verify extraction directory {}: {}",
                                    created_path.display(),
                                    e
                                )
                            })?,
                            false,
                        )
                    }
                    Err(create_error) => {
                        return Err(format!(
                            "Failed to create extraction directory {}: {}",
                            created_path.display(),
                            create_error
                        ));
                    }
                }
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect extraction directory {}: {}",
                    created_path.display(),
                    error
                ));
            }
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(format!(
                "Extraction directory changed into a non-directory: {}",
                created_path.display()
            ));
        }
        // Another process may have won the create race. Do not remove a
        // directory we did not create when rolling back a later entry.
        if created_here {
            extracted.push(created_path);
        }
    }
    Ok(())
}

fn apply_extracted_file_metadata(
    file: &fs::File,
    mode: Option<u32>,
    mtime_seconds: Option<u64>,
) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = mode;
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        // Preserve normal rwx bits (including executability), but never carry
        // setuid/setgid/sticky bits out of an untrusted archive.
        file.set_permissions(fs::Permissions::from_mode(mode & 0o777))
            .map_err(|e| e.to_string())?;
    }
    if let Some(seconds) = mtime_seconds {
        if let Some(modified) = UNIX_EPOCH.checked_add(Duration::from_secs(seconds)) {
            file.set_times(fs::FileTimes::new().set_modified(modified))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn compress_files(
    source_paths: Vec<String>,
    output_path: String,
    format: Option<String>,
    operation_id: Option<String>,
    advanced_options: Option<serde_json::Value>,
    webview: tauri::WebviewWindow,
    _app: tauri::AppHandle,
) -> Result<(), String> {
    log::debug!(
        "[Archive] compress: {} items -> {} (fmt={:?})",
        source_paths.len(),
        output_path,
        format
    );
    if source_paths.is_empty() {
        return Err("No source items provided".to_string());
    }
    if source_paths.len() > MAX_COMPRESS_SOURCES {
        return Err(format!(
            "Too many compression sources (max {})",
            MAX_COMPRESS_SOURCES
        ));
    }
    let source_path_bytes = source_paths.iter().map(String::len).sum::<usize>();
    if source_path_bytes > MAX_COMPRESS_SOURCE_PATH_BYTES {
        return Err(format!(
            "Compression source paths exceed aggregate size limit (max {} bytes)",
            MAX_COMPRESS_SOURCE_PATH_BYTES
        ));
    }
    let requested_output = crate::validate_path(&output_path, "Output")?;
    let output_parent = requested_output
        .parent()
        .ok_or_else(|| "Archive output has no parent directory".to_string())?;
    let parent_meta = fs::symlink_metadata(output_parent)
        .map_err(|e| format!("Cannot access archive output directory: {}", e))?;
    if parent_meta.file_type().is_symlink() || !parent_meta.is_dir() {
        return Err("Archive output directory is not a real directory".to_string());
    }
    // Pin the output to the canonical parent after validation. This keeps a
    // concurrent parent-directory replacement from redirecting the temporary
    // archive write while still accepting benign system links such as /tmp.
    let output_name = requested_output
        .file_name()
        .ok_or_else(|| "Archive output has no file name".to_string())?;
    let output = output_parent
        .canonicalize()
        .map_err(|e| format!("Cannot resolve archive output directory: {}", e))?
        .join(output_name);
    if let Ok(metadata) = fs::symlink_metadata(&output) {
        if metadata.file_type().is_symlink() {
            return Err("Refusing to overwrite a symbolic-link output path".to_string());
        }
        if !metadata.is_file() {
            return Err("Archive output path is not a regular file".to_string());
        }
    }
    let output_cmp = canonicalize_for_comparison(&output);
    let mut validated_sources = Vec::with_capacity(source_paths.len());
    for source in &source_paths {
        let source_path = crate::validate_existing_path(source, "Source")?;
        let source_meta = fs::symlink_metadata(&source_path)
            .map_err(|e| format!("Cannot inspect source {}: {}", source_path.display(), e))?;
        if source_meta.file_type().is_symlink() {
            return Err(format!(
                "Refusing to compress symbolic-link source: {}",
                source_path.display()
            ));
        }
        if !source_meta.is_dir() && !source_meta.is_file() {
            return Err(format!(
                "Refusing to compress non-regular source: {}",
                source_path.display()
            ));
        }
        // H4: hard-fail on canonicalize failure. The previous fallback to
        // the un-canonicalized path could let a symlinked source/output
        // pair sneak past the same-path check and recurse forever.
        let source_cmp = source_path.canonicalize().map_err(|e| {
            format!(
                "Refusing to compress: cannot canonicalize source {}: {}",
                source_path.display(),
                e
            )
        })?;
        if source_cmp == output_cmp || output_cmp.starts_with(&source_cmp) {
            return Err(format!(
                "Output path cannot be the same as or inside source path: {}",
                source_path.display()
            ));
        }
        validated_sources.push(source_cmp);
    }
    let fmt = format.unwrap_or_else(|| "zip".to_string());
    if let Some(value) = advanced_options.as_ref() {
        let encoded_len = serde_json::to_vec(value)
            .map_err(|e| format!("Invalid compression options: {}", e))?
            .len();
        if encoded_len > MAX_ADVANCED_OPTIONS_BYTES {
            return Err(format!(
                "Compression options exceed the {} byte limit",
                MAX_ADVANCED_OPTIONS_BYTES
            ));
        }
    }
    let options = advanced_options
        .and_then(|value| serde_json::from_value::<AdvancedCompressOptions>(value).ok())
        .unwrap_or_default();
    let op_id = operation_id.unwrap_or_default();
    let cancellation = register_archive_operation(&op_id)?;

    let compress_op_id = op_id.clone();
    let compress_cancellation = cancellation.clone();
    let (temporary_output, temporary_file) =
        match crate::create_secure_temp_file(&output, "archive") {
            Ok(value) => value,
            Err(error) => {
                // The operation is registered before staging so a concurrent
                // cancel can win the setup race. Always unregister it when
                // staging fails too; otherwise a failed request leaks the id
                // until a later registration replaces it.
                ACTIVE_OPS.finish(&op_id, cancellation.as_ref());
                return Err(error);
            }
        };
    let temporary_output_for_worker = temporary_output.clone();
    let result = tokio::task::spawn_blocking(move || {
        // Compression itself runs without the global mutation lock: it only
        // writes the private staging file, so holding the lock would serialize
        // unrelated copy/move/undo operations for the whole archive run.
        let worker_result = match fmt.as_str() {
            "zip" => compress_zip(
                &validated_sources,
                temporary_file,
                &temporary_output_for_worker,
                &compress_op_id,
                compress_cancellation.as_ref(),
                options,
                &webview,
            ),
            "tar.gz" | "tgz" => compress_tar_gz(
                &validated_sources,
                temporary_file,
                &temporary_output_for_worker,
                &compress_op_id,
                compress_cancellation.as_ref(),
                options,
                &webview,
            ),
            "7z" => compress_7z(
                &validated_sources,
                temporary_file,
                &temporary_output_for_worker,
                &compress_op_id,
                compress_cancellation.as_ref(),
                options,
                &webview,
            ),
            _ => Err(format!("Unsupported format: {}", fmt)),
        };

        let result = match worker_result {
            Ok(()) => {
                if !is_active(compress_cancellation.as_ref()) {
                    Err("Operation cancelled".to_string())
                } else {
                    // The temporary file is complete and still on the same
                    // filesystem; flush it before publication.
                    let sync_result = fs::OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(&temporary_output_for_worker)
                        .and_then(|file| file.sync_all());
                    if let Err(error) = sync_result {
                        Err(format!("Failed to flush archive output: {}", error))
                    } else {
                        // Hold the ordering lock only for the final rename.
                        // atomic_replace_archive_output re-checks the
                        // destination under the lock, so a symlink or
                        // non-regular file planted while compression ran is
                        // still rejected.
                        let _mutation_lock = crate::file_operations::mutation_lock()?;
                        atomic_replace_archive_output(&temporary_output_for_worker, &output)
                    }
                }
            }
            Err(error) => Err(error),
        };
        if result.is_err() {
            let _ = fs::remove_file(&temporary_output_for_worker);
        }
        result
    })
    .await;
    ACTIVE_OPS.finish(&op_id, cancellation.as_ref());
    let result = result.map_err(|error| format!("Archive worker failed: {}", error))?;
    if result.is_err() {
        let _ = fs::remove_file(&temporary_output);
    }
    result
}

fn atomic_replace_archive_output(temp: &Path, output: &Path) -> Result<(), String> {
    crate::atomic_replace_file(temp, output)
}

fn zip_entry_options<'a>(
    advanced_options: &'a AdvancedCompressOptions,
) -> Result<zip::write::FileOptions<'a, 'a, ()>, String> {
    let level = advanced_options.compression_level.map(|level| level.min(9));
    let method = match advanced_options.method.as_deref() {
        Some("BZip2") => zip::CompressionMethod::Bzip2,
        Some("LZMA") => zip::CompressionMethod::Lzma,
        _ if level == Some(0) => zip::CompressionMethod::Stored,
        _ => zip::CompressionMethod::Deflated,
    };

    let mut options: zip::write::FileOptions<'a, 'a, ()> = zip::write::FileOptions::default()
        .compression_method(method)
        .compression_level(level.map(i64::from));

    if let Some(password) = nonempty_archive_password(advanced_options.password.as_deref()) {
        options = match advanced_options.encryption_method.as_deref() {
            Some("ZipCrypto") => options
                .with_deprecated_encryption(password.as_bytes())
                .map_err(|error| format!("Invalid ZIP password: {}", error))?,
            _ => options.with_aes_encryption(zip::AesMode::Aes256, password),
        };
    }

    Ok(options)
}

fn nonempty_archive_password(password: Option<&str>) -> Option<&str> {
    password.filter(|value| !value.is_empty())
}

fn compress_zip(
    sources: &[PathBuf],
    file: fs::File,
    temp_output: &Path,
    op_id: &str,
    cancellation: Option<&CancellationToken>,
    advanced_options: AdvancedCompressOptions,
    webview: &tauri::WebviewWindow,
) -> Result<(), String> {
    let mut zip = zip::ZipWriter::new(file);

    let mut count = 0u64;
    let total = sources.len() as u64;

    let result = (|| -> Result<(), String> {
        for source in sources {
            let path = source.clone();
            if !op_id.is_empty() && !is_active(cancellation) {
                return Err("Operation cancelled".to_string());
            }
            let source_meta = validate_compression_source(&path)?;

            if source_meta.is_dir() {
                add_dir_to_zip(
                    &mut zip,
                    &path,
                    &path,
                    &advanced_options,
                    op_id,
                    cancellation,
                )?;
            } else {
                let name = path
                    .file_name()
                    .ok_or_else(|| format!("Invalid path: {}", path.display()))?
                    .to_string_lossy()
                    .to_string();
                ensure_compress_entry_depth(&name)?;
                let options = zip_entry_options(&advanced_options)?;
                zip.start_file(&name, options).map_err(|e| e.to_string())?;
                let mut source_file = open_regular_read(&path)?;
                copy_reader_cancellable(&mut source_file, &mut zip, cancellation)?;
            }

            count += 1;
            let _ = webview.emit("compress-progress", serde_json::json!({
                "operationId": op_id,
                "current": count,
                "total": total,
                "name": path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            }));
        }
        Ok(())
    })();

    if result.is_err() {
        drop(zip);
        let _ = fs::remove_file(temp_output);
        return result;
    }

    zip.finish().map_err(|e| {
        let _ = fs::remove_file(temp_output);
        e.to_string()
    })?;
    Ok(())
}

fn add_dir_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    dir: &Path,
    base: &Path,
    advanced_options: &AdvancedCompressOptions,
    op_id: &str,
    cancellation: Option<&CancellationToken>,
) -> Result<(), String> {
    let dir_meta = validate_compression_source(dir)?;
    if !dir_meta.is_dir() {
        return Err(format!(
            "Compression source is not a directory: {}",
            dir.display()
        ));
    }
    let name = format!(
        "{}/",
        dir.strip_prefix(base.parent().unwrap_or(base))
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
    );
    ensure_compress_entry_depth(&name)?;
    zip.add_directory(name, zip_entry_options(advanced_options)?)
        .map_err(|e| e.to_string())?;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !op_id.is_empty() && !is_active(cancellation) {
            return Err("Operation cancelled".to_string());
        }

        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            continue;
        }
        let relative = path
            .strip_prefix(base.parent().unwrap_or(base))
            .unwrap_or(&path);
        let name = relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");

        if meta.is_dir() {
            ensure_compress_entry_depth(&format!("{}/", name))?;
            add_dir_to_zip(zip, &path, base, advanced_options, op_id, cancellation)?;
        } else {
            ensure_compress_entry_depth(&name)?;
            let options = zip_entry_options(advanced_options)?;
            zip.start_file(&name, options).map_err(|e| e.to_string())?;
            let mut source_file = open_regular_read(&path)?;
            copy_reader_cancellable(&mut source_file, zip, cancellation)?;
        }
    }
    Ok(())
}

fn compress_tar_gz(
    sources: &[PathBuf],
    file: fs::File,
    temp_output: &Path,
    op_id: &str,
    cancellation: Option<&CancellationToken>,
    advanced_options: AdvancedCompressOptions,
    webview: &tauri::WebviewWindow,
) -> Result<(), String> {
    let result = (|| -> Result<(), String> {
        let level = advanced_options.compression_level.unwrap_or(6).min(9);
        let enc = flate2::write::GzEncoder::new(file, flate2::Compression::new(level));
        let mut tar = tar::Builder::new(enc);
        tar.follow_symlinks(false);

        let total = sources.len() as u64;
        let mut count = 0u64;

        for source in sources {
            if !op_id.is_empty() && !is_active(cancellation) {
                return Err("Operation cancelled".to_string());
            }
            let path = source.clone();
            let source_meta = validate_compression_source(&path)?;
            let name = path
                .file_name()
                .ok_or_else(|| format!("Invalid path: {}", path.display()))?
                .to_string_lossy()
                .to_string();
            if source_meta.is_dir() {
                let base = path.parent().unwrap_or(&path);
                for entry in walkdir::WalkDir::new(&path) {
                    let entry = entry.map_err(|e| e.to_string())?;
                    if !op_id.is_empty() && !is_active(cancellation) {
                        return Err("Operation cancelled".to_string());
                    }
                    let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
                    if meta.file_type().is_symlink() {
                        continue;
                    }
                    let rel = entry.path().strip_prefix(base).unwrap_or(entry.path());
                    let rel_name = rel.to_string_lossy();
                    ensure_compress_entry_depth(&rel_name)?;
                    if meta.is_dir() {
                        tar.append_dir(rel, entry.path())
                            .map_err(|e| e.to_string())?;
                    } else {
                        append_tar_file(&mut tar, entry.path(), rel, cancellation)?;
                    }
                }
            } else {
                ensure_compress_entry_depth(&name)?;
                append_tar_file(&mut tar, &path, Path::new(&name), cancellation)?;
            }
            count += 1;
            let _ = webview.emit(
                "compress-progress",
                serde_json::json!({
                    "operationId": op_id,
                    "current": count,
                    "total": total,
                    "name": name,
                }),
            );
        }

        tar.into_inner()
            .map_err(|e| e.to_string())?
            .finish()
            .map_err(|e| e.to_string())?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(temp_output);
    }
    result
}

fn parse_dictionary_size(value: &str) -> Option<u32> {
    let trimmed = value.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        return None;
    }

    let (number, unit) = trimmed
        .strip_suffix("kb")
        .map(|n| (n, 1024u32))
        .or_else(|| trimmed.strip_suffix('k').map(|n| (n, 1024u32)))
        .or_else(|| trimmed.strip_suffix("mb").map(|n| (n, 1024u32 * 1024)))
        .or_else(|| trimmed.strip_suffix('m').map(|n| (n, 1024u32 * 1024)))
        .or_else(|| {
            trimmed
                .strip_suffix("gb")
                .map(|n| (n, 1024u32 * 1024 * 1024))
        })
        .or_else(|| {
            trimmed
                .strip_suffix('g')
                .map(|n| (n, 1024u32 * 1024 * 1024))
        })
        .or_else(|| trimmed.strip_suffix('b').map(|n| (n, 1u32)))
        .unwrap_or((trimmed.as_str(), 1));

    let amount: u32 = number.parse().ok()?;
    amount.checked_mul(unit)
}

fn build_lzma2_options(
    options: &AdvancedCompressOptions,
) -> sevenz_rust2::encoder_options::Lzma2Options {
    use sevenz_rust2::encoder_options::Lzma2Options;

    let preset = options.compression_level.unwrap_or(5).min(9);
    let mut lzma2 = Lzma2Options::from_level(preset);
    if let Some(dict) = options
        .dictionary_size
        .as_deref()
        .and_then(parse_dictionary_size)
    {
        lzma2.set_dictionary_size(dict);
    }
    lzma2
}

fn configure_7z_compression_options(
    writer: &mut sevenz_rust2::ArchiveWriter<fs::File>,
    options: &AdvancedCompressOptions,
) {
    let lzma2 = build_lzma2_options(options);
    if let Some(password) = nonempty_archive_password(options.password.as_deref()) {
        writer.set_content_methods(vec![
            sevenz_rust2::encoder_options::AesEncoderOptions::new(password.into()).into(),
            lzma2.into(),
        ]);
        writer.set_encrypt_header(options.encrypt_file_names.unwrap_or(false));
    } else {
        writer.set_content_methods(vec![lzma2.into()]);
        writer.set_encrypt_header(false);
    }
}

fn compress_7z(
    sources: &[PathBuf],
    file: fs::File,
    temp_output: &Path,
    op_id: &str,
    cancellation: Option<&CancellationToken>,
    advanced_options: AdvancedCompressOptions,
    webview: &tauri::WebviewWindow,
) -> Result<(), String> {
    let result = (|| -> Result<(), String> {
        let mut sz = sevenz_rust2::ArchiveWriter::new(file).map_err(|e| e.to_string())?;
        configure_7z_compression_options(&mut sz, &advanced_options);

        let sz_cell = std::cell::RefCell::new(sz);
        let total = sources.len() as u64;
        let mut count = 0u64;

        for source in sources {
            if !op_id.is_empty() && !is_active(cancellation) {
                drop(sz_cell);
                let _ = fs::remove_file(temp_output);
                return Err("Operation cancelled".to_string());
            }

            let path = source.clone();
            let source_meta = validate_compression_source(&path)?;
            let name = path
                .file_name()
                .ok_or_else(|| format!("Invalid path: {}", path.display()))?
                .to_string_lossy()
                .to_string();

            if source_meta.is_dir() {
                ensure_compress_entry_depth(&format!("{}/", name))?;
                add_dir_to_7z(&sz_cell, &path, &name, op_id, cancellation)?;
            } else {
                ensure_compress_entry_depth(&name)?;
                let source_file = open_regular_read(&path)?;
                let entry = sevenz_rust2::ArchiveEntry::from_path(&path, name.clone());
                sz_cell
                    .borrow_mut()
                    .push_archive_entry(entry, Some(cancellable_reader(source_file, cancellation)))
                    .map_err(|e| e.to_string())?;
            }

            count += 1;
            let _ = webview.emit(
                "compress-progress",
                serde_json::json!({
                    "operationId": op_id,
                    "current": count,
                    "total": total,
                    "name": name,
                }),
            );
        }

        sz_cell.into_inner().finish().map_err(|e| e.to_string())?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(temp_output);
    }
    result
}

fn add_dir_to_7z(
    sz: &std::cell::RefCell<sevenz_rust2::ArchiveWriter<fs::File>>,
    dir: &Path,
    prefix: &str,
    op_id: &str,
    cancellation: Option<&CancellationToken>,
) -> Result<(), String> {
    let dir_meta = validate_compression_source(dir)?;
    if !dir_meta.is_dir() {
        return Err(format!(
            "Compression source is not a directory: {}",
            dir.display()
        ));
    }
    let directory_entry = sevenz_rust2::ArchiveEntry::from_path(dir, format!("{}/", prefix));
    sz.borrow_mut()
        .push_archive_entry::<std::io::Empty>(directory_entry, None)
        .map_err(|e| e.to_string())?;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !op_id.is_empty() && !is_active(cancellation) {
            return Err("Operation cancelled".to_string());
        }
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            continue;
        }
        let name = format!("{}/{}", prefix, entry.file_name().to_string_lossy());
        if meta.is_dir() {
            ensure_compress_entry_depth(&format!("{}/", name))?;
            add_dir_to_7z(sz, &path, &name, op_id, cancellation)?;
        } else {
            ensure_compress_entry_depth(&name)?;
            let source_file = open_regular_read(&path)?;
            let archive_entry = sevenz_rust2::ArchiveEntry::from_path(&path, name);
            sz.borrow_mut()
                .push_archive_entry(
                    archive_entry,
                    Some(cancellable_reader(source_file, cancellation)),
                )
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn extract_archive(
    archive_path: String,
    dest_path: String,
    operation_id: Option<String>,
    password: Option<String>,
    webview: tauri::WebviewWindow,
    _app: tauri::AppHandle,
) -> Result<(), String> {
    log::debug!("[Archive] extract: {} -> {}", archive_path, dest_path);
    let archive = crate::validate_existing_path(&archive_path, "Archive")?
        .canonicalize()
        .map_err(|e| format!("Cannot resolve archive path: {}", e))?;
    let requested_dest = crate::validate_path(&dest_path, "Destination")?;
    let op_id = operation_id.unwrap_or_default();
    let cancellation = register_archive_operation(&op_id)?;
    if is_cancelled(cancellation.as_ref()) {
        ACTIVE_OPS.finish(&op_id, cancellation.as_ref());
        return Err("Operation cancelled".to_string());
    }
    let extract_password = nonempty_archive_password(password.as_deref()).map(str::to_owned);

    let extract_op_id = op_id.clone();
    let extract_cancellation = cancellation.clone();
    let result = tokio::task::spawn_blocking(move || {
        if is_cancelled(extract_cancellation.as_ref()) {
            return Err("Operation cancelled".to_string());
        }
        // Preparing the destination is the security-sensitive create-new step
        // (it rejects symlinks and canonicalizes the path). Serialize just that
        // step, then release the global mutation lock so a long extraction does
        // not block unrelated copy/move/undo work.
        let (dest, dest_preexisted) = {
            let _mutation_lock = crate::file_operations::mutation_lock()?;
            if is_cancelled(extract_cancellation.as_ref()) {
                return Err("Operation cancelled".to_string());
            }
            prepare_extraction_destination(&requested_dest)?
        };
        if is_cancelled(extract_cancellation.as_ref()) {
            cleanup_failed_new_destination_locked(&dest, dest_preexisted, false)?;
            return Err("Operation cancelled".to_string());
        }
        let kind = match resolve_extract_kind(&archive) {
            Ok(kind) => kind,
            Err(error) => {
                cleanup_failed_new_destination_locked(&dest, dest_preexisted, false)?;
                return Err(error);
            }
        };
        let extraction_result = match kind {
            ArchiveExtractKind::TarXz => extract_tar_xz(
                &archive,
                &dest,
                &extract_op_id,
                &webview,
                extract_cancellation.as_ref(),
                extract_password.as_deref(),
            ),
            ArchiveExtractKind::TarGz => extract_tar_gz(
                &archive,
                &dest,
                &extract_op_id,
                &webview,
                extract_cancellation.as_ref(),
                extract_password.as_deref(),
            ),
            ArchiveExtractKind::TarBz2 => extract_tar_bz2(
                &archive,
                &dest,
                &extract_op_id,
                &webview,
                extract_cancellation.as_ref(),
                extract_password.as_deref(),
            ),
            ArchiveExtractKind::Zip => extract_zip(
                &archive,
                &dest,
                &extract_op_id,
                &webview,
                extract_cancellation.as_ref(),
                extract_password.as_deref(),
            ),
            ArchiveExtractKind::Tar => extract_tar(
                &archive,
                &dest,
                &extract_op_id,
                &webview,
                extract_cancellation.as_ref(),
                extract_password.as_deref(),
            ),
            ArchiveExtractKind::SevenZ => extract_7z(
                &archive,
                &dest,
                &extract_op_id,
                &webview,
                extract_cancellation.as_ref(),
                extract_password.as_deref(),
            ),
            ArchiveExtractKind::GzipSingle => {
                if extract_password.is_some() {
                    Err("Password-protected .gz files are not supported".to_string())
                } else {
                    extract_gzip_single(&archive, &dest, extract_cancellation.as_ref())
                }
            }
            ArchiveExtractKind::XzSingle => {
                if extract_password.is_some() {
                    Err("Password-protected .xz files are not supported".to_string())
                } else {
                    extract_xz_single(&archive, &dest, extract_cancellation.as_ref())
                }
            }
        };
        if let Err(error) =
            cleanup_failed_new_destination_locked(&dest, dest_preexisted, extraction_result.is_ok())
        {
            log::warn!(
                "[Archive] failed to clean up failed extraction destination {}: {}",
                dest.display(),
                error
            );
        }
        extraction_result
    })
    .await;

    ACTIVE_OPS.finish(&op_id, cancellation.as_ref());

    result.map_err(|e| e.to_string())?
}

fn cleanup_failed_new_destination(dest: &Path, dest_preexisted: bool, succeeded: bool) {
    if !succeeded && !dest_preexisted {
        // Never recurse through a destination that was replaced by a
        // symlink while extraction was running. `symlink_metadata` keeps
        // cleanup scoped to the directory we created.
        if let Ok(metadata) = fs::symlink_metadata(dest) {
            if !metadata.file_type().is_symlink() && metadata.is_dir() {
                // Extraction now runs without the global mutation lock. A
                // concurrent operation may have written into this directory,
                // so never recursively delete it. Only remove it when empty;
                // otherwise leave the tracked cleanup paths in place and let
                // recovery/reporting handle the rest.
                if let Err(error) = fs::remove_dir(dest) {
                    log::warn!(
                        "[Archive] failed extraction left non-empty destination {}: {}",
                        dest.display(),
                        error
                    );
                }
            }
        }
    }
}

/// Serialize only the final removal of a destination this extraction created.
/// Extraction itself runs without the global mutation lock.
fn cleanup_failed_new_destination_locked(
    dest: &Path,
    dest_preexisted: bool,
    succeeded: bool,
) -> Result<(), String> {
    if succeeded || dest_preexisted {
        return Ok(());
    }
    let _mutation_lock = crate::file_operations::mutation_lock()?;
    cleanup_failed_new_destination(dest, dest_preexisted, succeeded);
    Ok(())
}

fn extract_zip(
    archive: &Path,
    dest: &Path,
    op_id: &str,
    webview: &tauri::WebviewWindow,
    cancellation: Option<&CancellationToken>,
    password: Option<&str>,
) -> Result<(), String> {
    let file = open_regular_read(archive)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let total = zip.len();
    if total > MAX_EXTRACT_ENTRIES {
        return Err(format!(
            "Archive contains too many entries ({} > {})",
            total, MAX_EXTRACT_ENTRIES
        ));
    }
    let mut cumulative_bytes: u64 = 0;
    let mut extracted: Vec<PathBuf> = Vec::new();
    let password_bytes = nonempty_archive_password(password).map(|value| value.as_bytes());

    let result = (|| {
        for i in 0..total {
            if !op_id.is_empty() && !is_active(cancellation) {
                return Err("Operation cancelled".to_string());
            }

            let mut entry = match password_bytes {
                Some(pwd) => zip.by_index_decrypt(i, pwd).map_err(|e| e.to_string())?,
                None => zip.by_index(i).map_err(|e| e.to_string())?,
            };
            let entry_name = entry.name().map_err(|e| e.to_string())?;
            ensure_archive_entry_name_size(&entry_name)?;
            let name = entry_name.to_string();
            let out_path = safe_entry_path(&name, dest)?;

            let _ = webview.emit(
                "extract-progress",
                serde_json::json!({
                    "operationId": op_id,
                    "current": i + 1,
                    "total": total,
                    "name": name,
                }),
            );

            if entry.is_dir() {
                create_dir_all_tracked(&out_path, &mut extracted)?;
                ensure_path_within_dest(&out_path, dest, &name)?;
            } else {
                if out_path.exists() {
                    return Err(format!(
                        "Refusing to overwrite existing extraction path: {}",
                        out_path.display()
                    ));
                }
                let entry_size = entry.size();
                if cumulative_bytes.saturating_add(entry_size) > MAX_DECOMPRESSED_SIZE {
                    return Err("Decompressed size limit exceeded (50 GB)".to_string());
                }
                if let Some(parent) = out_path.parent() {
                    create_dir_all_tracked(parent, &mut extracted)?;
                    ensure_path_within_dest(parent, dest, &name)?;
                }
                let mut outfile = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&out_path)
                    .map_err(|e| {
                        format!("Refusing extraction path {}: {}", out_path.display(), e)
                    })?;
                extracted.push(out_path.clone());
                // Bound the copy so a single entry that under-declares entry.size()
                // (zip bomb) cannot write past the cap before the post-check fires.
                let remaining = MAX_DECOMPRESSED_SIZE.saturating_sub(cumulative_bytes);
                let mut limited = (&mut entry).take(remaining.saturating_add(1));
                let written = copy_reader_cancellable(&mut limited, &mut outfile, cancellation)?;
                cumulative_bytes = cumulative_bytes.saturating_add(written);
                if cumulative_bytes > MAX_DECOMPRESSED_SIZE {
                    return Err("Decompressed size limit exceeded (50 GB)".to_string());
                }
            }
        }

        Ok(())
    })();

    if result.is_err() {
        cleanup_extracted_paths(&extracted);
    }
    result
}

fn extract_tar_gz(
    archive: &Path,
    dest: &Path,
    op_id: &str,
    webview: &tauri::WebviewWindow,
    cancellation: Option<&CancellationToken>,
    password: Option<&str>,
) -> Result<(), String> {
    if nonempty_archive_password(password).is_some() {
        return Err("Password-protected tar.gz archives are not supported".to_string());
    }
    let file = open_regular_read(archive)?;
    let dec = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(dec);
    extract_tar_entries(&mut tar, dest, op_id, webview, cancellation)
}

fn extract_tar_bz2(
    archive: &Path,
    dest: &Path,
    op_id: &str,
    webview: &tauri::WebviewWindow,
    cancellation: Option<&CancellationToken>,
    password: Option<&str>,
) -> Result<(), String> {
    if nonempty_archive_password(password).is_some() {
        return Err("Password-protected tar.bz2 archives are not supported".to_string());
    }
    let file = open_regular_read(archive)?;
    let dec = bzip2::read::BzDecoder::new(file);
    let mut tar = tar::Archive::new(dec);
    extract_tar_entries(&mut tar, dest, op_id, webview, cancellation)
}

fn extract_tar(
    archive: &Path,
    dest: &Path,
    op_id: &str,
    webview: &tauri::WebviewWindow,
    cancellation: Option<&CancellationToken>,
    password: Option<&str>,
) -> Result<(), String> {
    if nonempty_archive_password(password).is_some() {
        return Err("Password-protected tar archives are not supported".to_string());
    }
    let file = open_regular_read(archive)?;
    let mut tar = tar::Archive::new(file);
    extract_tar_entries(&mut tar, dest, op_id, webview, cancellation)
}

fn extract_7z(
    archive: &Path,
    dest: &Path,
    op_id: &str,
    webview: &tauri::WebviewWindow,
    cancellation: Option<&CancellationToken>,
    password: Option<&str>,
) -> Result<(), String> {
    let file = open_regular_read(archive)?;
    let reader = BufReader::new(file);
    let mut count = 0usize;
    let mut cumulative_bytes: u64 = 0;
    let mut extracted: Vec<PathBuf> = Vec::new();
    let password = nonempty_archive_password(password);
    let sevenz_password = sevenz_rust2::Password::from(password.unwrap_or(""));

    let extract_fn = |entry: &sevenz_rust2::ArchiveEntry,
                      reader: &mut dyn Read,
                      _dest_path: &PathBuf| {
        if !op_id.is_empty() && !is_active(cancellation) {
            return Err(sevenz_rust2::Error::Other("Operation cancelled".into()));
        }
        count += 1;
        if count > MAX_EXTRACT_ENTRIES {
            return Err(sevenz_rust2::Error::Other(
                format!(
                    "Archive entry count exceeds limit ({})",
                    MAX_EXTRACT_ENTRIES
                )
                .into(),
            ));
        }
        ensure_archive_entry_name_size(entry.name())
            .map_err(|e| sevenz_rust2::Error::Other(e.into()))?;
        let name = entry.name().to_string();
        let _ = webview.emit(
            "extract-progress",
            serde_json::json!({
                "operationId": op_id,
                "current": count,
                "total": 0,
                "name": name.clone(),
            }),
        );
        let out_path = safe_entry_path(entry.name(), dest)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
        if entry.is_directory() {
            create_dir_all_tracked(&out_path, &mut extracted).map_err(std::io::Error::other)?;
            ensure_path_within_dest(&out_path, dest, &name).map_err(std::io::Error::other)?;
        } else {
            if out_path.exists() {
                return Err(sevenz_rust2::Error::Other(
                    format!(
                        "Refusing to overwrite existing extraction path: {}",
                        out_path.display()
                    )
                    .into(),
                ));
            }
            let entry_size = entry.size();
            if cumulative_bytes.saturating_add(entry_size) > MAX_DECOMPRESSED_SIZE {
                return Err(sevenz_rust2::Error::Other(
                    "Decompressed size limit exceeded (50 GB)".into(),
                ));
            }
            if let Some(parent) = out_path.parent() {
                create_dir_all_tracked(parent, &mut extracted).map_err(std::io::Error::other)?;
                ensure_path_within_dest(parent, dest, &name).map_err(std::io::Error::other)?;
            }
            let mut outfile = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&out_path)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            extracted.push(out_path.clone());
            let remaining = MAX_DECOMPRESSED_SIZE.saturating_sub(cumulative_bytes);
            let mut limited = reader.take(remaining.saturating_add(1));
            let written = copy_reader_cancellable(&mut limited, &mut outfile, cancellation)
                .map_err(std::io::Error::other)?;
            cumulative_bytes = cumulative_bytes.saturating_add(written);
            if cumulative_bytes > MAX_DECOMPRESSED_SIZE {
                return Err(sevenz_rust2::Error::Other(
                    "Decompressed size limit exceeded (50 GB)".into(),
                ));
            }
        }
        Ok(true)
    };

    let result = if password.is_none() {
        sevenz_rust2::decompress_with_extract_fn(reader, dest, extract_fn)
    } else {
        sevenz_rust2::decompress_with_extract_fn_and_password(
            reader,
            dest,
            sevenz_password,
            extract_fn,
        )
    };
    if result.is_err() {
        cleanup_extracted_paths(&extracted);
    }
    result.map_err(|e| match e {
        sevenz_rust2::Error::Other(message) if message.as_ref() == "Operation cancelled" => {
            "Operation cancelled".to_string()
        }
        other => other.to_string(),
    })
}

fn extract_tar_xz(
    archive: &Path,
    dest: &Path,
    op_id: &str,
    webview: &tauri::WebviewWindow,
    cancellation: Option<&CancellationToken>,
    password: Option<&str>,
) -> Result<(), String> {
    if nonempty_archive_password(password).is_some() {
        return Err("Password-protected tar.xz archives are not supported".to_string());
    }
    let file = open_regular_read(archive)?;
    let dec = xz2::read::XzDecoder::new(file);
    let mut tar = tar::Archive::new(dec);
    extract_tar_entries(&mut tar, dest, op_id, webview, cancellation)
}

// Extract a plain single-file compressed stream (foo.gz / foo.xz, not a tarball).
// Output name = archive name minus its final extension, written into dest.
fn extract_compressed_single<R: std::io::Read>(
    reader: R,
    archive: &Path,
    dest: &Path,
    cancellation: Option<&CancellationToken>,
) -> Result<(), String> {
    if !is_active(cancellation) {
        return Err("Operation cancelled".to_string());
    }
    let stem = archive
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Cannot determine output file name".to_string())?;
    let out_path = safe_entry_path(&stem, dest)?;
    if out_path.exists() {
        return Err(format!(
            "Refusing to overwrite existing extraction path: {}",
            out_path.display()
        ));
    }
    let mut created_dirs = Vec::new();
    if let Some(parent) = out_path.parent() {
        if let Err(error) = create_dir_all_tracked(parent, &mut created_dirs) {
            cleanup_extracted_paths(&created_dirs);
            return Err(error);
        }
        if let Err(error) = ensure_path_within_dest(parent, dest, &stem) {
            cleanup_extracted_paths(&created_dirs);
            return Err(error);
        }
    }
    let mut outfile = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&out_path)
    {
        Ok(file) => file,
        Err(error) => {
            cleanup_extracted_paths(&created_dirs);
            return Err(error.to_string());
        }
    };
    // Bound the copy so a malicious stream can't exceed the cap (decompression bomb).
    let mut limited = reader.take(MAX_DECOMPRESSED_SIZE.saturating_add(1));
    let written =
        copy_reader_cancellable(&mut limited, &mut outfile, cancellation).inspect_err(|_| {
            let _ = fs::remove_file(&out_path);
            cleanup_extracted_paths(&created_dirs);
        })?;
    if written > MAX_DECOMPRESSED_SIZE {
        let _ = fs::remove_file(&out_path);
        cleanup_extracted_paths(&created_dirs);
        return Err("Decompressed size limit exceeded (50 GB)".to_string());
    }
    Ok(())
}

fn extract_gzip_single(
    archive: &Path,
    dest: &Path,
    cancellation: Option<&CancellationToken>,
) -> Result<(), String> {
    let file = open_regular_read(archive)?;
    let dec = flate2::read::GzDecoder::new(file);
    extract_compressed_single(dec, archive, dest, cancellation)
}

fn extract_xz_single(
    archive: &Path,
    dest: &Path,
    cancellation: Option<&CancellationToken>,
) -> Result<(), String> {
    let file = open_regular_read(archive)?;
    let dec = xz2::read::XzDecoder::new(file);
    extract_compressed_single(dec, archive, dest, cancellation)
}

fn extract_tar_entries<R: std::io::Read>(
    tar: &mut tar::Archive<R>,
    dest: &Path,
    op_id: &str,
    webview: &tauri::WebviewWindow,
    cancellation: Option<&CancellationToken>,
) -> Result<(), String> {
    let mut extracted: Vec<PathBuf> = Vec::new();
    let result =
        extract_tar_entries_tracked(tar, dest, op_id, webview, cancellation, &mut extracted);
    if result.is_err() {
        cleanup_extracted_paths(&extracted);
    }
    result
}

/// H3: route tar entries through the same `safe_entry_path` pipeline used by
/// the zip / 7z paths, instead of relying on `tar::Entry::unpack_in` alone.
/// `unpack_in` blocks `..` and absolute paths but does NOT check whether a
/// destination component is a pre-existing symlink — a layered attack
/// (e.g. a zip-then-tar where the zip planted a symlink first) could bypass.
///
/// M6: track every file/directory we extract so a partial failure leaves a
/// clean state when the destination pre-existed. The caller passes in a Vec
/// that we append to; on error the caller can unwind.
fn extract_tar_entries_tracked<R: std::io::Read>(
    tar: &mut tar::Archive<R>,
    dest: &Path,
    op_id: &str,
    webview: &tauri::WebviewWindow,
    cancellation: Option<&CancellationToken>,
    extracted: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let mut count = 0usize;
    let mut cumulative_bytes: u64 = 0;
    for entry in tar.entries().map_err(|e| e.to_string())? {
        if !op_id.is_empty() && !is_active(cancellation) {
            return Err("Operation cancelled".to_string());
        }

        // Bound entry count to stop crafted archives with millions of tiny
        // (often zero-byte) entries that never trip the byte cap but exhaust
        // inodes/CPU. Mirrors the zip path's MAX_EXTRACT_ENTRIES guard.
        if count >= MAX_EXTRACT_ENTRIES {
            return Err(format!(
                "Archive entry count exceeds limit ({})",
                MAX_EXTRACT_ENTRIES
            ));
        }

        let mut entry = entry.map_err(|e| e.to_string())?;
        let entry_type = entry.header().entry_type();
        if entry.path_bytes().len() > MAX_ARCHIVE_ENTRY_NAME_BYTES {
            return Err(format!(
                "Archive entry name exceeds limit ({} bytes)",
                MAX_ARCHIVE_ENTRY_NAME_BYTES
            ));
        }
        let name = entry
            .path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();

        if entry_type.is_symlink() || entry_type.is_hard_link() {
            return Err(format!(
                "Symlink and hard link entries are not supported: {}",
                name
            ));
        }
        if !entry_type.is_dir() && !entry_type.is_file() {
            return Err(format!("Special tar entries are not supported: {}", name));
        }

        cumulative_bytes = cumulative_bytes.saturating_add(entry.size());
        if cumulative_bytes > MAX_DECOMPRESSED_SIZE {
            return Err("Decompressed size limit exceeded (50 GB)".to_string());
        }

        // H3: validate the entry path through the same pipeline the zip/7z
        // paths use. `safe_entry_path` checks for `..`, root components,
        // exceeded depth, and pre-existing symlinks anywhere on the path.
        let target_path = safe_entry_path(&name, dest)?;

        count += 1;
        let _ = webview.emit(
            "extract-progress",
            serde_json::json!({
                "operationId": op_id,
                "current": count,
                "total": 0,
                "name": name,
            }),
        );

        if entry_type.is_dir() {
            create_dir_all_tracked(&target_path, extracted)
                .map_err(|e| format!("Failed to create dir {}: {}", target_path.display(), e))?;
        } else {
            if target_path.exists() {
                return Err(format!(
                    "Refusing to overwrite existing extraction path: {}",
                    target_path.display()
                ));
            }
            if let Some(parent) = target_path.parent() {
                create_dir_all_tracked(parent, extracted)
                    .map_err(|e| format!("Failed to create dir {}: {}", parent.display(), e))?;
                // Re-check after creating missing parents. This closes the
                // common symlink-swap window before the destination is opened.
                ensure_path_within_dest(parent, dest, &name)?;
            }
            let entry_mode = entry.header().mode().ok();
            let entry_mtime = entry.header().mtime().ok();
            // Create the destination atomically and stream bytes into that
            // handle. `Entry::unpack` re-opens by path, leaving a symlink race
            // between the safety check and the write.
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target_path)
                .map_err(|e| format!("Failed to create {}: {}", name, e))?;
            extracted.push(target_path.clone());
            let previous_bytes = cumulative_bytes.saturating_sub(entry.size());
            let remaining = MAX_DECOMPRESSED_SIZE.saturating_sub(previous_bytes);
            let mut limited = (&mut entry).take(remaining.saturating_add(1));
            let written = copy_reader_cancellable(&mut limited, &mut output, cancellation)
                .map_err(|e| format!("Failed to unpack {}: {}", name, e))?;
            cumulative_bytes = previous_bytes.saturating_add(written);
            if cumulative_bytes > MAX_DECOMPRESSED_SIZE {
                return Err("Decompressed size limit exceeded (50 GB)".to_string());
            }
            apply_extracted_file_metadata(&output, entry_mode, entry_mtime)?;
        }
        // Belt + suspenders: confirm the final path is still under dest after
        // any normalization the OS may have done (e.g., 8.3 short names on
        // Windows). If a symlink raced in between safe_entry_path and unpack,
        // canonicalize will now resolve through it and we catch it here.
        ensure_path_within_dest(&target_path, dest, &name)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn cancel_archive_operation(operation_id: String) -> Result<(), String> {
    ACTIVE_OPS.cancel(&operation_id);
    Ok(())
}

#[tauri::command]
pub async fn list_archive_contents(archive_path: String) -> Result<Vec<ArchiveEntry>, String> {
    let archive = crate::validate_existing_path(&archive_path, "Archive")?
        .canonicalize()
        .map_err(|e| format!("Cannot resolve archive path: {}", e))?;

    tokio::task::spawn_blocking(move || {
        // Bound listing of crafted archives with huge entry counts (DoS guard).
        const MAX_LIST_ENTRIES: usize = 100_000;
        let ext = archive
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        // Plain single-file compressed streams list as one entry (not tarballs).
        let full_name = archive.to_string_lossy().to_lowercase();
        let is_plain_gz = ext == "gz" && !full_name.ends_with(".tar.gz");
        let is_plain_xz = ext == "xz" && !full_name.ends_with(".tar.xz");
        let is_tar_bz2 = full_name.ends_with(".tar.bz2")
            || full_name.ends_with(".tbz2")
            || full_name.ends_with(".tbz");
        let is_tar_xz = full_name.ends_with(".tar.xz") || full_name.ends_with(".txz");
        if is_plain_gz || is_plain_xz {
            let stem = archive
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "extracted".to_string());
            let compressed = fs::metadata(&archive).map(|m| m.len()).unwrap_or(0);
            return Ok(vec![ArchiveEntry {
                name: stem.clone(),
                path: stem,
                size: 0,
                is_directory: false,
                compressed_size: compressed,
            }]);
        }

        match ext.as_str() {
            "zip" => {
                let file = open_regular_read(&archive)?;
                let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
                let mut entries = Vec::new();
                let mut name_bytes = 0usize;

                for i in 0..zip.len().min(MAX_LIST_ENTRIES) {
                    let entry = zip.by_index(i).map_err(|e| e.to_string())?;
                    let entry_name = entry.name().map_err(|e| e.to_string())?;
                    account_list_entry_name(&mut name_bytes, &entry_name)?;
                    entries.push(ArchiveEntry {
                        name: entry
                            .enclosed_name()
                            .map(|p| {
                                p.file_name()
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .to_string()
                            })
                            .unwrap_or_default(),
                        path: entry_name.to_string(),
                        size: entry.size(),
                        is_directory: entry.is_dir(),
                        compressed_size: entry.compressed_size(),
                    });
                }

                Ok(entries)
            }
            "7z" => {
                let file = open_regular_read(&archive)?;
                let mut reader = BufReader::new(file);
                let sevenz_archive =
                    sevenz_rust2::Archive::read(&mut reader, &sevenz_rust2::Password::empty())
                        .map_err(|e| e.to_string())?;
                let mut name_bytes = 0usize;
                let entries = sevenz_archive
                    .files
                    .iter()
                    .take(MAX_LIST_ENTRIES)
                    .map(|entry| {
                        // The closure is intentionally fallible so crafted
                        // names cannot allocate an unbounded response.
                        account_list_entry_name(&mut name_bytes, entry.name())?;
                        Ok(ArchiveEntry {
                            name: Path::new(entry.name())
                                .file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string(),
                            path: entry.name().to_string(),
                            size: entry.size(),
                            is_directory: entry.is_directory(),
                            compressed_size: entry.compressed_size,
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                Ok(entries)
            }
            "gz" | "tgz" => {
                let file = open_regular_read(&archive)?;
                let dec = flate2::read::GzDecoder::new(file);
                let mut tar = tar::Archive::new(dec);
                let mut entries = Vec::new();
                let mut name_bytes = 0usize;
                let mut cumulative_size = 0u64;
                for entry in tar.entries().map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    if entries.len() >= MAX_LIST_ENTRIES {
                        break;
                    }
                    let path_str = entry
                        .path()
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .to_string();
                    account_list_entry_name(&mut name_bytes, &path_str)?;
                    cumulative_size = cumulative_size.saturating_add(entry.size());
                    if cumulative_size > MAX_DECOMPRESSED_SIZE {
                        return Err(
                            "Archive listing exceeds decompressed size limit (50 GB)".to_string()
                        );
                    }
                    let name = Path::new(&path_str)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    entries.push(ArchiveEntry {
                        name,
                        path: path_str,
                        size: entry.size(),
                        is_directory: entry.header().entry_type().is_dir(),
                        compressed_size: entry.size(),
                    });
                }
                Ok(entries)
            }
            "bz2" | "tbz2" | "tbz" if is_tar_bz2 => {
                let file = open_regular_read(&archive)?;
                let dec = bzip2::read::BzDecoder::new(file);
                let mut tar = tar::Archive::new(dec);
                let mut entries = Vec::new();
                let mut name_bytes = 0usize;
                let mut cumulative_size = 0u64;
                for entry in tar.entries().map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    if entries.len() >= MAX_LIST_ENTRIES {
                        break;
                    }
                    let path_str = entry
                        .path()
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .to_string();
                    account_list_entry_name(&mut name_bytes, &path_str)?;
                    cumulative_size = cumulative_size.saturating_add(entry.size());
                    if cumulative_size > MAX_DECOMPRESSED_SIZE {
                        return Err(
                            "Archive listing exceeds decompressed size limit (50 GB)".to_string()
                        );
                    }
                    let name = Path::new(&path_str)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    entries.push(ArchiveEntry {
                        name,
                        path: path_str,
                        size: entry.size(),
                        is_directory: entry.header().entry_type().is_dir(),
                        compressed_size: entry.size(),
                    });
                }
                Ok(entries)
            }
            "xz" | "txz" if is_tar_xz => {
                let file = open_regular_read(&archive)?;
                let dec = xz2::read::XzDecoder::new(file);
                let mut tar = tar::Archive::new(dec);
                let mut entries = Vec::new();
                let mut name_bytes = 0usize;
                let mut cumulative_size = 0u64;
                for entry in tar.entries().map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    if entries.len() >= MAX_LIST_ENTRIES {
                        break;
                    }
                    let path_str = entry
                        .path()
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .to_string();
                    account_list_entry_name(&mut name_bytes, &path_str)?;
                    cumulative_size = cumulative_size.saturating_add(entry.size());
                    if cumulative_size > MAX_DECOMPRESSED_SIZE {
                        return Err(
                            "Archive listing exceeds decompressed size limit (50 GB)".to_string()
                        );
                    }
                    let name = Path::new(&path_str)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    entries.push(ArchiveEntry {
                        name,
                        path: path_str,
                        size: entry.size(),
                        is_directory: entry.header().entry_type().is_dir(),
                        compressed_size: entry.size(),
                    });
                }
                Ok(entries)
            }
            "tar" => {
                let file = open_regular_read(&archive)?;
                let mut tar = tar::Archive::new(file);
                let mut entries = Vec::new();
                let mut name_bytes = 0usize;
                let mut cumulative_size = 0u64;
                for entry in tar.entries().map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    if entries.len() >= MAX_LIST_ENTRIES {
                        break;
                    }
                    let path_str = entry
                        .path()
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .to_string();
                    account_list_entry_name(&mut name_bytes, &path_str)?;
                    cumulative_size = cumulative_size.saturating_add(entry.size());
                    if cumulative_size > MAX_DECOMPRESSED_SIZE {
                        return Err(
                            "Archive listing exceeds decompressed size limit (50 GB)".to_string()
                        );
                    }
                    let name = Path::new(&path_str)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    entries.push(ArchiveEntry {
                        name,
                        path: path_str,
                        size: entry.size(),
                        is_directory: entry.header().entry_type().is_dir(),
                        compressed_size: entry.size(),
                    });
                }
                Ok(entries)
            }
            _ => Err(format!("Listing not supported for format: {}", ext)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_embedded_office_thumbnail(
    file_path: String,
    max_size: Option<u64>,
) -> Result<String, String> {
    let office_file = crate::validate_existing_path(&file_path, "Office file")?;
    crate::file_operations::ensure_safe_preview_read_path(&office_file)?;
    let office_file = office_file
        .canonicalize()
        .map_err(|e| format!("Failed to resolve Office preview path: {}", e))?;
    let limit = max_size
        .unwrap_or(DEFAULT_OFFICE_THUMBNAIL_LIMIT_BYTES)
        .min(MAX_OFFICE_THUMBNAIL_LIMIT_BYTES);

    tokio::task::spawn_blocking(move || {
        extract_embedded_office_thumbnail_data_url(&office_file, limit)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn extract_embedded_office_thumbnail_data_url(path: &Path, limit: u64) -> Result<String, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !is_supported_office_extension(&ext) {
        return Err("Embedded thumbnails are only supported for ZIP-based Office formats".into());
    }

    let file = open_regular_read(path)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    if zip.len() > MAX_EXTRACT_ENTRIES {
        return Err(format!(
            "Archive entry count exceeds limit ({})",
            MAX_EXTRACT_ENTRIES
        ));
    }

    let mut candidates = vec!["Thumbnails/thumbnail.png".to_string()];

    if let Some(target) = find_ooxml_thumbnail_relation_target(&mut zip) {
        candidates.push(target);
    }

    candidates.extend([
        "docProps/thumbnail.jpeg".to_string(),
        "docProps/thumbnail.jpg".to_string(),
        "docProps/thumbnail.png".to_string(),
    ]);

    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for candidate in candidates {
        let key = candidate.to_ascii_lowercase();
        if seen.insert(key) {
            deduped.push(candidate);
        }
    }

    let entry_name = deduped
        .iter()
        .find_map(|candidate| find_zip_entry_case_insensitive(&mut zip, candidate))
        .ok_or_else(|| "No embedded thumbnail found in this document".to_string())?;

    let mut entry = zip.by_name(&entry_name).map_err(|e| e.to_string())?;
    if entry.is_dir() {
        return Err("Embedded thumbnail entry is a directory".to_string());
    }
    if entry.size() > limit {
        return Err("Embedded thumbnail is too large".to_string());
    }

    let mut data = Vec::new();
    let mut limited = (&mut entry).take(limit + 1);
    limited.read_to_end(&mut data).map_err(|e| e.to_string())?;
    if data.len() as u64 > limit {
        return Err("Embedded thumbnail is too large".to_string());
    }

    let mime = detect_image_mime(&entry_name, &data)
        .ok_or_else(|| "Embedded thumbnail image format is not supported".to_string())?;

    Ok(format!("data:{};base64,{}", mime, base64_encode(&data)))
}

fn is_supported_office_extension(ext: &str) -> bool {
    matches!(
        ext,
        "docx"
            | "docm"
            | "dotx"
            | "dotm"
            | "xlsx"
            | "xlsm"
            | "xltx"
            | "xltm"
            | "pptx"
            | "pptm"
            | "ppsx"
            | "odt"
            | "ods"
            | "odp"
    )
}

fn find_zip_entry_case_insensitive<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    target: &str,
) -> Option<String> {
    for index in 0..zip.len().min(MAX_EXTRACT_ENTRIES) {
        let entry = match zip.by_index(index) {
            Ok(entry) => entry,
            Err(error) => {
                log::debug!(
                    "Skipping malformed ZIP entry {} while locating thumbnail: {}",
                    index,
                    error
                );
                continue;
            }
        };
        let entry_name = match entry.name() {
            Ok(name) => name,
            Err(error) => {
                log::debug!(
                    "Skipping undecodable ZIP entry {} while locating thumbnail: {}",
                    index,
                    error
                );
                continue;
            }
        };
        if entry_name.eq_ignore_ascii_case(target) {
            return Some(entry_name.to_string());
        }
    }
    None
}

fn find_ooxml_thumbnail_relation_target<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
) -> Option<String> {
    let rels_name = find_zip_entry_case_insensitive(zip, "_rels/.rels")?;
    let rels_entry = zip.by_name(&rels_name).ok()?;
    if rels_entry.size() > MAX_RELATIONSHIP_BYTES {
        return None;
    }
    let mut rels_bytes = Vec::new();
    rels_entry
        .take(MAX_RELATIONSHIP_BYTES.saturating_add(1))
        .read_to_end(&mut rels_bytes)
        .ok()?;
    if rels_bytes.len() as u64 > MAX_RELATIONSHIP_BYTES {
        return None;
    }
    let rels_xml = String::from_utf8(rels_bytes).ok()?;
    parse_thumbnail_target_from_relationships(&rels_xml)
}

fn parse_thumbnail_target_from_relationships(xml: &str) -> Option<String> {
    let relationship_types = [
        "http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/metadata/thumbnail",
        "http://purl.oclc.org/ooxml/officeDocument/relationships/metadata/thumbnail",
    ];

    let re = RELATIONSHIP_TAG_RE.as_ref()?;
    for tag_match in re.find_iter(xml) {
        let tag = tag_match.as_str();
        let Some(rel_type) = extract_xml_attr(tag, "Type") else {
            continue;
        };
        if !relationship_types
            .iter()
            .any(|expected| rel_type.eq_ignore_ascii_case(expected))
        {
            continue;
        }
        let Some(target) = extract_xml_attr(tag, "Target") else {
            continue;
        };
        if let Some(path) = normalize_zip_target_path(&target) {
            return Some(path);
        }
    }

    None
}

fn extract_xml_attr(tag: &str, attr_name: &str) -> Option<String> {
    let re = XML_ATTRIBUTE_RE.as_ref()?;
    for captures in re.captures_iter(tag) {
        let key = captures.get(1)?.as_str();
        if key.eq_ignore_ascii_case(attr_name) {
            // Capture group 2 includes the surrounding quotes; strip them.
            let quoted = captures.get(2)?.as_str();
            return Some(quoted[1..quoted.len() - 1].to_string());
        }
    }
    None
}

fn normalize_zip_target_path(target: &str) -> Option<String> {
    let without_fragment = target
        .split('#')
        .next()?
        .split('?')
        .next()?
        .replace('\\', "/");
    let trimmed = without_fragment.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut parts: Vec<String> = Vec::new();
    for component in Path::new(trimmed.trim_start_matches('/')).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                parts.pop()?;
            }
            std::path::Component::Normal(part) => {
                parts.push(part.to_string_lossy().to_string());
            }
            _ => return None,
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn detect_image_mime(path: &str, data: &[u8]) -> Option<&'static str> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match ext.as_str() {
        "png" => return Some("image/png"),
        "jpg" | "jpeg" => return Some("image/jpeg"),
        "gif" => return Some("image/gif"),
        "webp" => return Some("image/webp"),
        _ => {}
    }

    if data.starts_with(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n']) {
        return Some("image/png");
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
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

#[cfg(test)]
#[path = "archive_tests.rs"]
mod tests;

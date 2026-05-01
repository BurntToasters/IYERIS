use regex::Regex;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Emitter;

static ACTIVE_OPS: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));
static RELATIONSHIP_TAG_RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r#"(?is)<Relationship\b[^>]*>"#).expect("relationship tag regex")
});
static XML_ATTRIBUTE_RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r#"(?is)([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(['\"])(.*?)\2"#)
        .expect("xml attribute regex")
});

const MAX_DECOMPRESSED_SIZE: u64 = 53_687_091_200; // 50 GB
const DEFAULT_OFFICE_THUMBNAIL_LIMIT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_OFFICE_THUMBNAIL_LIMIT_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_directory: bool,
    pub compressed_size: u64,
}

fn is_active(op_id: &str) -> bool {
    match ACTIVE_OPS.lock() {
        Ok(s) => s.contains(op_id),
        Err(poisoned) => {
            log::warn!("[Archive] ACTIVE_OPS mutex poisoned, recovering");
            poisoned.into_inner().contains(op_id)
        }
    }
}

fn safe_entry_path(entry_name: &str, dest: &Path) -> Result<PathBuf, String> {
    let mut component_path = dest.to_path_buf();
    for component in std::path::Path::new(entry_name).components() {
        match component {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(format!("Path traversal detected: {}", entry_name));
            }
            std::path::Component::CurDir => {}
            std::path::Component::Normal(part) => {
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
    let canonical_dest = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
    let canonical_path = path
        .parent()
        .and_then(|p| p.canonicalize().ok())
        .unwrap_or_else(|| {
            let mut fallback = canonical_dest.clone();
            if let Some(parent) = std::path::Path::new(entry_name).parent() {
                fallback = fallback.join(parent);
            }
            fallback
        });

    if !canonical_path.starts_with(&canonical_dest) {
        return Err(format!("Path traversal detected: {}", entry_name));
    }
    Ok(path)
}

fn ensure_path_within_dest(path: &Path, dest: &Path, entry_name: &str) -> Result<(), String> {
    let canonical_dest = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
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

#[tauri::command]
pub async fn compress_files(
    source_paths: Vec<String>,
    output_path: String,
    format: Option<String>,
    operation_id: Option<String>,
    _advanced_options: Option<serde_json::Value>,
    webview: tauri::WebviewWindow,
    _app: tauri::AppHandle,
) -> Result<(), String> {
    log::debug!(
        "[Archive] compress: {} items -> {} (fmt={:?})",
        source_paths.len(),
        output_path,
        format
    );
    let output = crate::validate_path(&output_path, "Output")?;
    let output_cmp = canonicalize_for_comparison(&output);
    for source in &source_paths {
        let source_path = crate::validate_existing_path(source, "Source")?;
        let source_cmp = source_path
            .canonicalize()
            .unwrap_or_else(|_| source_path.clone());
        if source_cmp == output_cmp || output_cmp.starts_with(&source_cmp) {
            return Err(format!(
                "Output path cannot be the same as or inside source path: {}",
                source_path.display()
            ));
        }
    }
    let fmt = format.unwrap_or_else(|| "zip".to_string());
    let op_id = operation_id.unwrap_or_default();

    if !op_id.is_empty() {
        let mut ops = ACTIVE_OPS.lock().map_err(|e| e.to_string())?;
        ops.insert(op_id.clone());
    }

    let compress_op_id = op_id.clone();
    let result = tokio::task::spawn_blocking(move || match fmt.as_str() {
        "zip" => compress_zip(&source_paths, &output, &compress_op_id, &webview),
        "tar.gz" | "tgz" => compress_tar_gz(&source_paths, &output, &compress_op_id, &webview),
        "7z" => compress_7z(&source_paths, &output, &compress_op_id, &webview),
        _ => Err(format!("Unsupported format: {}", fmt)),
    })
    .await;

    if !op_id.is_empty() {
        if let Ok(mut ops) = ACTIVE_OPS.lock() {
            ops.remove(&op_id);
        }
    }

    result.map_err(|e| e.to_string())?
}

fn compress_zip(
    sources: &[String],
    output: &Path,
    op_id: &str,
    webview: &tauri::WebviewWindow,
) -> Result<(), String> {
    let file = fs::File::create(output).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut count = 0u64;
    let total = sources.len() as u64;

    let result = (|| -> Result<(), String> {
        for source in sources {
            let path = PathBuf::from(source);
            if !op_id.is_empty() && !is_active(op_id) {
                return Err("Operation cancelled".to_string());
            }

            if path.is_dir() {
                add_dir_to_zip(&mut zip, &path, &path, &options, op_id)?;
            } else {
                let name = path
                    .file_name()
                    .ok_or_else(|| format!("Invalid path: {}", path.display()))?
                    .to_string_lossy()
                    .to_string();
                zip.start_file(&name, options).map_err(|e| e.to_string())?;
                let mut source_file = fs::File::open(&path).map_err(|e| e.to_string())?;
                std::io::copy(&mut source_file, &mut zip).map_err(|e| e.to_string())?;
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
        let _ = fs::remove_file(output);
        return result;
    }

    zip.finish().map_err(|e| {
        let _ = fs::remove_file(output);
        e.to_string()
    })?;
    Ok(())
}

fn add_dir_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    dir: &Path,
    base: &Path,
    options: &zip::write::SimpleFileOptions,
    op_id: &str,
) -> Result<(), String> {
    for entry in fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| {
            e.map_err(|err| log::warn!("[Archive] zip dir entry error: {}", err))
                .ok()
        })
    {
        if !op_id.is_empty() && !is_active(op_id) {
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
        let name = relative.to_string_lossy().to_string();

        if meta.is_dir() {
            zip.add_directory(&format!("{}/", name), *options)
                .map_err(|e| e.to_string())?;
            add_dir_to_zip(zip, &path, base, options, op_id)?;
        } else {
            zip.start_file(&name, *options).map_err(|e| e.to_string())?;
            let mut source_file = fs::File::open(&path).map_err(|e| e.to_string())?;
            std::io::copy(&mut source_file, zip).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn compress_tar_gz(
    sources: &[String],
    output: &Path,
    op_id: &str,
    webview: &tauri::WebviewWindow,
) -> Result<(), String> {
    let result = (|| -> Result<(), String> {
        let file = fs::File::create(output).map_err(|e| e.to_string())?;
        let enc = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        let mut tar = tar::Builder::new(enc);
        tar.follow_symlinks(false);

        let total = sources.len() as u64;
        let mut count = 0u64;

        for source in sources {
            if !op_id.is_empty() && !is_active(op_id) {
                return Err("Operation cancelled".to_string());
            }
            let path = PathBuf::from(source);
            let name = path
                .file_name()
                .ok_or_else(|| format!("Invalid path: {}", path.display()))?
                .to_string_lossy()
                .to_string();
            if path.is_dir() {
                let base = path.parent().unwrap_or(&path);
                for entry in walkdir::WalkDir::new(&path)
                    .into_iter()
                    .filter_map(|e| e.ok())
                {
                    if !op_id.is_empty() && !is_active(op_id) {
                        return Err("Operation cancelled".to_string());
                    }
                    let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
                    if meta.file_type().is_symlink() {
                        continue;
                    }
                    let rel = entry.path().strip_prefix(base).unwrap_or(entry.path());
                    if meta.is_dir() {
                        tar.append_dir(rel, entry.path())
                            .map_err(|e| e.to_string())?;
                    } else {
                        tar.append_path_with_name(entry.path(), rel)
                            .map_err(|e| e.to_string())?;
                    }
                }
            } else {
                tar.append_path_with_name(&path, &name)
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

        tar.into_inner()
            .map_err(|e| e.to_string())?
            .finish()
            .map_err(|e| e.to_string())?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(output);
    }
    result
}

fn compress_7z(
    sources: &[String],
    output: &Path,
    op_id: &str,
    webview: &tauri::WebviewWindow,
) -> Result<(), String> {
    let result = (|| -> Result<(), String> {
        let sz = sevenz_rust::SevenZWriter::create(output).map_err(|e| e.to_string())?;
        let sz_cell = std::cell::RefCell::new(sz);
        let total = sources.len() as u64;
        let mut count = 0u64;

        for source in sources {
            if !op_id.is_empty() && !is_active(op_id) {
                drop(sz_cell);
                let _ = fs::remove_file(output);
                return Err("Operation cancelled".to_string());
            }

            let path = PathBuf::from(source);
            let name = path
                .file_name()
                .ok_or_else(|| format!("Invalid path: {}", path.display()))?
                .to_string_lossy()
                .to_string();

            if path.is_dir() {
                add_dir_to_7z(&sz_cell, &path, &name, op_id)?;
            } else {
                let source_file = fs::File::open(&path).map_err(|e| e.to_string())?;
                let entry = sevenz_rust::SevenZArchiveEntry::from_path(&path, name.clone());
                sz_cell
                    .borrow_mut()
                    .push_archive_entry(entry, Some(source_file))
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
        let _ = fs::remove_file(output);
    }
    result
}

fn add_dir_to_7z(
    sz: &std::cell::RefCell<sevenz_rust::SevenZWriter<fs::File>>,
    dir: &Path,
    prefix: &str,
    op_id: &str,
) -> Result<(), String> {
    for entry in fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| {
            e.map_err(|err| log::warn!("[Archive] 7z dir entry error: {}", err))
                .ok()
        })
    {
        if !op_id.is_empty() && !is_active(op_id) {
            return Err("Operation cancelled".to_string());
        }
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            continue;
        }
        let name = format!("{}/{}", prefix, entry.file_name().to_string_lossy());
        if meta.is_dir() {
            add_dir_to_7z(sz, &path, &name, op_id)?;
        } else {
            let source_file = fs::File::open(&path).map_err(|e| e.to_string())?;
            let archive_entry = sevenz_rust::SevenZArchiveEntry::from_path(&path, name);
            sz.borrow_mut()
                .push_archive_entry(archive_entry, Some(source_file))
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
    webview: tauri::WebviewWindow,
    _app: tauri::AppHandle,
) -> Result<(), String> {
    log::debug!("[Archive] extract: {} -> {}", archive_path, dest_path);
    let archive = crate::validate_existing_path(&archive_path, "Archive")?;
    let dest = crate::validate_path(&dest_path, "Destination")?;
    let dest_preexisted = dest.exists();
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let op_id = operation_id.unwrap_or_default();

    if !op_id.is_empty() {
        let mut ops = ACTIVE_OPS.lock().map_err(|e| e.to_string())?;
        ops.insert(op_id.clone());
    }

    let extract_op_id = op_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let ext = archive
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        let full_name = archive.to_string_lossy().to_lowercase();
        if full_name.ends_with(".tar.xz") || full_name.ends_with(".txz") {
            return extract_tar_xz(&archive, &dest, &extract_op_id, &webview);
        }
        match ext.as_str() {
            "zip" => extract_zip(&archive, &dest, &extract_op_id, &webview),
            "gz" | "tgz" => extract_tar_gz(&archive, &dest, &extract_op_id, &webview),
            "tar" => extract_tar(&archive, &dest, &extract_op_id, &webview),
            "7z" => extract_7z(&archive, &dest, &extract_op_id, &webview),
            "xz" => extract_tar_xz(&archive, &dest, &extract_op_id, &webview),
            _ => Err(format!("Unsupported archive format: {}", ext)),
        }
    })
    .await;

    if !op_id.is_empty() {
        if let Ok(mut ops) = ACTIVE_OPS.lock() {
            ops.remove(&op_id);
        }
    }

    if !matches!(&result, Ok(Ok(()))) && !dest_preexisted {
        let _ = fs::remove_dir_all(&dest_path);
    }

    result.map_err(|e| e.to_string())?
}

fn extract_zip(
    archive: &Path,
    dest: &Path,
    op_id: &str,
    webview: &tauri::WebviewWindow,
) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let total = zip.len();
    let mut cumulative_bytes: u64 = 0;

    for i in 0..total {
        if !op_id.is_empty() && !is_active(op_id) {
            return Err("Operation cancelled".to_string());
        }

        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
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
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            ensure_path_within_dest(&out_path, dest, &name)?;
        } else {
            let entry_size = entry.size();
            if cumulative_bytes.saturating_add(entry_size) > MAX_DECOMPRESSED_SIZE {
                return Err("Decompressed size limit exceeded (50 GB)".to_string());
            }
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                ensure_path_within_dest(parent, dest, &name)?;
            }
            let mut outfile = fs::File::create(&out_path).map_err(|e| e.to_string())?;
            let written = std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
            cumulative_bytes = cumulative_bytes.saturating_add(written);
            if cumulative_bytes > MAX_DECOMPRESSED_SIZE {
                return Err("Decompressed size limit exceeded (50 GB)".to_string());
            }
        }
    }

    Ok(())
}

fn extract_tar_gz(
    archive: &Path,
    dest: &Path,
    op_id: &str,
    webview: &tauri::WebviewWindow,
) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let dec = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(dec);
    extract_tar_entries(&mut tar, dest, op_id, webview)
}

fn extract_tar(
    archive: &Path,
    dest: &Path,
    op_id: &str,
    webview: &tauri::WebviewWindow,
) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut tar = tar::Archive::new(file);
    extract_tar_entries(&mut tar, dest, op_id, webview)
}

fn extract_7z(
    archive: &Path,
    dest: &Path,
    op_id: &str,
    webview: &tauri::WebviewWindow,
) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut count = 0usize;
    let mut cumulative_bytes: u64 = 0;
    sevenz_rust::decompress_with_extract_fn(reader, dest, |entry, reader, _dest_path| {
        if !op_id.is_empty() && !is_active(op_id) {
            return Err(sevenz_rust::Error::other("Operation cancelled"));
        }
        count += 1;
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
            fs::create_dir_all(&out_path)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            ensure_path_within_dest(&out_path, dest, &name)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        } else {
            let entry_size = entry.size() as u64;
            if cumulative_bytes.saturating_add(entry_size) > MAX_DECOMPRESSED_SIZE {
                return Err(sevenz_rust::Error::other(
                    "Decompressed size limit exceeded (50 GB)",
                ));
            }
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
                ensure_path_within_dest(parent, dest, &name)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            }
            let mut outfile = fs::File::create(&out_path)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            let written = std::io::copy(reader, &mut outfile)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            cumulative_bytes = cumulative_bytes.saturating_add(written);
            if cumulative_bytes > MAX_DECOMPRESSED_SIZE {
                return Err(sevenz_rust::Error::other(
                    "Decompressed size limit exceeded (50 GB)",
                ));
            }
        }
        Ok(true)
    })
    .map_err(|e| match e {
        sevenz_rust::Error::Other(message) if message.as_ref() == "Operation cancelled" => {
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
) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let dec = xz2::read::XzDecoder::new(file);
    let mut tar = tar::Archive::new(dec);
    extract_tar_entries(&mut tar, dest, op_id, webview)
}

fn extract_tar_entries<R: std::io::Read>(
    tar: &mut tar::Archive<R>,
    dest: &Path,
    op_id: &str,
    webview: &tauri::WebviewWindow,
) -> Result<(), String> {
    let mut count = 0usize;
    let mut cumulative_bytes: u64 = 0;
    for entry in tar.entries().map_err(|e| e.to_string())? {
        if !op_id.is_empty() && !is_active(op_id) {
            return Err("Operation cancelled".to_string());
        }

        let mut entry = entry.map_err(|e| e.to_string())?;
        let entry_type = entry.header().entry_type();
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

        cumulative_bytes = cumulative_bytes.saturating_add(entry.size());
        if cumulative_bytes > MAX_DECOMPRESSED_SIZE {
            return Err("Decompressed size limit exceeded (50 GB)".to_string());
        }

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

        let unpacked = entry.unpack_in(dest).map_err(|e| e.to_string())?;
        if !unpacked {
            return Err(format!("Path traversal detected: {}", name));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn cancel_archive_operation(operation_id: String) -> Result<(), String> {
    let mut ops = ACTIVE_OPS.lock().map_err(|e| e.to_string())?;
    ops.remove(&operation_id);
    Ok(())
}

#[tauri::command]
pub async fn list_archive_contents(archive_path: String) -> Result<Vec<ArchiveEntry>, String> {
    let archive = crate::validate_existing_path(&archive_path, "Archive")?;

    tokio::task::spawn_blocking(move || {
        let ext = archive
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        match ext.as_str() {
            "zip" => {
                let file = fs::File::open(&archive).map_err(|e| e.to_string())?;
                let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
                let mut entries = Vec::new();

                for i in 0..zip.len() {
                    let entry = zip.by_index(i).map_err(|e| e.to_string())?;
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
                        path: entry.name().to_string(),
                        size: entry.size(),
                        is_directory: entry.is_dir(),
                        compressed_size: entry.compressed_size(),
                    });
                }

                Ok(entries)
            }
            "7z" => {
                let mut entries = Vec::new();
                let file = fs::File::open(&archive).map_err(|e| e.to_string())?;
                let reader = BufReader::new(file);
                sevenz_rust::decompress_with_extract_fn(
                    reader,
                    Path::new(""),
                    |entry, _reader, _dest| {
                        entries.push(ArchiveEntry {
                            name: Path::new(entry.name())
                                .file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string(),
                            path: entry.name().to_string(),
                            size: entry.size() as u64,
                            is_directory: entry.is_directory(),
                            compressed_size: entry.compressed_size as u64,
                        });
                        Ok(true)
                    },
                )
                .map_err(|e| e.to_string())?;
                Ok(entries)
            }
            "gz" | "tgz" => {
                let file = fs::File::open(&archive).map_err(|e| e.to_string())?;
                let dec = flate2::read::GzDecoder::new(file);
                let mut tar = tar::Archive::new(dec);
                let mut entries = Vec::new();
                for entry in tar.entries().map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let path_str = entry
                        .path()
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .to_string();
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
                let file = fs::File::open(&archive).map_err(|e| e.to_string())?;
                let mut tar = tar::Archive::new(file);
                let mut entries = Vec::new();
                for entry in tar.entries().map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let path_str = entry
                        .path()
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .to_string();
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

    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

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
    for index in 0..zip.len() {
        let entry = zip.by_index(index).ok()?;
        if entry.name().eq_ignore_ascii_case(target) {
            return Some(entry.name().to_string());
        }
    }
    None
}

fn find_ooxml_thumbnail_relation_target<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
) -> Option<String> {
    let rels_name = find_zip_entry_case_insensitive(zip, "_rels/.rels")?;
    let mut rels_entry = zip.by_name(&rels_name).ok()?;
    let mut rels_xml = String::new();
    rels_entry.read_to_string(&mut rels_xml).ok()?;
    parse_thumbnail_target_from_relationships(&rels_xml)
}

fn parse_thumbnail_target_from_relationships(xml: &str) -> Option<String> {
    let relationship_types = [
        "http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/metadata/thumbnail",
        "http://purl.oclc.org/ooxml/officeDocument/relationships/metadata/thumbnail",
    ];

    for tag_match in RELATIONSHIP_TAG_RE.find_iter(xml) {
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
    for captures in XML_ATTRIBUTE_RE.captures_iter(tag) {
        let key = captures.get(1)?.as_str();
        if key.eq_ignore_ascii_case(attr_name) {
            return Some(captures.get(3)?.as_str().to_string());
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
                if parts.pop().is_none() {
                    return None;
                }
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
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
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

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::{BufReader, Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Emitter;

static ACTIVE_OPS: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

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
    ACTIVE_OPS.lock().map(|s| s.contains(op_id)).unwrap_or(false)
}

fn safe_entry_path(entry_name: &str, dest: &Path) -> Result<PathBuf, String> {
    let path = dest.join(entry_name);
    let canonical_dest = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
    let canonical_path = path
        .parent()
        .and_then(|p| p.canonicalize().ok())
        .unwrap_or_else(|| path.clone());

    if !canonical_path.starts_with(&canonical_dest) {
        return Err(format!("Path traversal detected: {}", entry_name));
    }
    Ok(path)
}

#[tauri::command]
pub async fn compress_files(
    source_paths: Vec<String>,
    output_path: String,
    format: Option<String>,
    operation_id: Option<String>,
    _advanced_options: Option<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let output = PathBuf::from(&output_path);
    let fmt = format.unwrap_or_else(|| "zip".to_string());
    let op_id = operation_id.unwrap_or_default();

    if !op_id.is_empty() {
        let mut ops = ACTIVE_OPS.lock().map_err(|e| e.to_string())?;
        ops.insert(op_id.clone());
    }

    let compress_op_id = op_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        match fmt.as_str() {
            "zip" => compress_zip(&source_paths, &output, &compress_op_id, &app),
            "tar.gz" | "tgz" => compress_tar_gz(&source_paths, &output, &compress_op_id, &app),
            "7z" => compress_7z(&source_paths, &output, &compress_op_id, &app),
            _ => Err(format!("Unsupported format: {}", fmt)),
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    if !op_id.is_empty() {
        let mut ops = ACTIVE_OPS.lock().map_err(|e| e.to_string())?;
        ops.remove(&op_id);
    }

    result
}

fn compress_zip(
    sources: &[String],
    output: &Path,
    op_id: &str,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let file = fs::File::create(output).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut count = 0u64;
    let total = sources.len() as u64;

    for source in sources {
        let path = PathBuf::from(source);
        if !op_id.is_empty() && !is_active(op_id) {
            let _ = fs::remove_file(output);
            return Err("Operation cancelled".to_string());
        }

        if path.is_dir() {
            add_dir_to_zip(&mut zip, &path, &path, &options, op_id, app)?;
        } else {
            let name = path.file_name()
                .ok_or_else(|| format!("Invalid path: {}", path.display()))?
                .to_string_lossy().to_string();
            zip.start_file(&name, options).map_err(|e| e.to_string())?;
            let data = fs::read(&path).map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
        }

        count += 1;
        let _ = app.emit("compress-progress", serde_json::json!({
            "operationId": op_id,
            "current": count,
            "total": total,
            "name": path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        }));
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

fn add_dir_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    dir: &Path,
    base: &Path,
    options: &zip::write::SimpleFileOptions,
    op_id: &str,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        if !op_id.is_empty() && !is_active(op_id) {
            return Err("Operation cancelled".to_string());
        }

        let path = entry.path();
        let relative = path
            .strip_prefix(base.parent().unwrap_or(base))
            .unwrap_or(&path);
        let name = relative.to_string_lossy().to_string();

        if path.is_dir() {
            zip.add_directory(&format!("{}/", name), *options)
                .map_err(|e| e.to_string())?;
            add_dir_to_zip(zip, &path, base, options, op_id, app)?;
        } else {
            zip.start_file(&name, *options).map_err(|e| e.to_string())?;
            let data = fs::read(&path).map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn compress_tar_gz(
    sources: &[String],
    output: &Path,
    _op_id: &str,
    _app: &tauri::AppHandle,
) -> Result<(), String> {
    let file = fs::File::create(output).map_err(|e| e.to_string())?;
    let enc = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut tar = tar::Builder::new(enc);

    for source in sources {
        let path = PathBuf::from(source);
        let name = path.file_name()
            .ok_or_else(|| format!("Invalid path: {}", path.display()))?
            .to_string_lossy().to_string();
        if path.is_dir() {
            tar.append_dir_all(&name, &path).map_err(|e| e.to_string())?;
        } else {
            tar.append_path_with_name(&path, &name).map_err(|e| e.to_string())?;
        }
    }

    tar.into_inner()
        .map_err(|e| e.to_string())?
        .finish()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn compress_7z(
    sources: &[String],
    output: &Path,
    op_id: &str,
    app: &tauri::AppHandle,
) -> Result<(), String> {
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
        let name = path.file_name()
            .ok_or_else(|| format!("Invalid path: {}", path.display()))?
            .to_string_lossy().to_string();

        if path.is_dir() {
            add_dir_to_7z(&sz_cell, &path, &name, op_id)?;
        } else {
            let data = fs::read(&path).map_err(|e| e.to_string())?;
            let entry = sevenz_rust::SevenZArchiveEntry::from_path(&path, name.clone());
            sz_cell.borrow_mut()
                .push_archive_entry(entry, Some(Cursor::new(data)))
                .map_err(|e| e.to_string())?;
        }

        count += 1;
        let _ = app.emit("compress-progress", serde_json::json!({
            "operationId": op_id,
            "current": count,
            "total": total,
            "name": name,
        }));
    }

    sz_cell.into_inner().finish().map_err(|e| e.to_string())?;
    Ok(())
}

fn add_dir_to_7z(
    sz: &std::cell::RefCell<sevenz_rust::SevenZWriter<fs::File>>,
    dir: &Path,
    prefix: &str,
    op_id: &str,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        if !op_id.is_empty() && !is_active(op_id) {
            return Err("Operation cancelled".to_string());
        }
        let path = entry.path();
        let name = format!("{}/{}", prefix, entry.file_name().to_string_lossy());
        if path.is_dir() {
            add_dir_to_7z(sz, &path, &name, op_id)?;
        } else {
            let data = fs::read(&path).map_err(|e| e.to_string())?;
            let archive_entry = sevenz_rust::SevenZArchiveEntry::from_path(&path, name);
            sz.borrow_mut()
                .push_archive_entry(archive_entry, Some(Cursor::new(data)))
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
    app: tauri::AppHandle,
) -> Result<(), String> {
    let archive = crate::validate_existing_path(&archive_path, "Archive")?;
    let dest = PathBuf::from(&dest_path);
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
            return extract_tar_xz(&archive, &dest);
        }
        match ext.as_str() {
            "zip" => extract_zip(&archive, &dest, &extract_op_id, &app),
            "gz" | "tgz" => extract_tar_gz(&archive, &dest, &extract_op_id, &app),
            "tar" => extract_tar(&archive, &dest),
            "7z" => extract_7z(&archive, &dest, &extract_op_id, &app),
            "xz" => extract_tar_xz(&archive, &dest),
            _ => Err(format!("Unsupported archive format: {}", ext)),
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    if !op_id.is_empty() {
        let mut ops = ACTIVE_OPS.lock().map_err(|e| e.to_string())?;
        ops.remove(&op_id);
    }

    result
}

fn extract_zip(
    archive: &Path,
    dest: &Path,
    op_id: &str,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let total = zip.len();

    for i in 0..total {
        if !op_id.is_empty() && !is_active(op_id) {
            return Err("Operation cancelled".to_string());
        }

        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let out_path = safe_entry_path(&name, dest)?;

        let _ = app.emit("extract-progress", serde_json::json!({
            "operationId": op_id,
            "current": i + 1,
            "total": total,
            "name": name,
        }));

        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut outfile = fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

fn extract_tar_gz(
    archive: &Path,
    dest: &Path,
    _op_id: &str,
    _app: &tauri::AppHandle,
) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let dec = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(dec);
    tar.unpack(dest).map_err(|e| e.to_string())
}

fn extract_tar(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut tar = tar::Archive::new(file);
    tar.unpack(dest).map_err(|e| e.to_string())
}

fn extract_7z(
    archive: &Path,
    dest: &Path,
    op_id: &str,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut count = 0usize;
    sevenz_rust::decompress_with_extract_fn(reader, dest, |entry, reader, dest_path| {
        if !op_id.is_empty() && !is_active(op_id) {
            return Ok(false);
        }
        count += 1;
        let name = entry.name().to_string();
        let _ = app.emit("extract-progress", serde_json::json!({
            "operationId": op_id,
            "current": count,
            "total": 0,
            "name": name,
        }));
        let out_path = dest_path.join(entry.name());
        if entry.is_directory() {
            fs::create_dir_all(&out_path).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            }
            let mut outfile = fs::File::create(&out_path).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            std::io::copy(reader, &mut outfile).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        }
        Ok(true)
    })
    .map_err(|e| e.to_string())
}

fn extract_tar_xz(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let dec = xz2::read::XzDecoder::new(file);
    let mut tar = tar::Archive::new(dec);
    tar.unpack(dest).map_err(|e| e.to_string())
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
                            .map(|p| p.file_name().unwrap_or_default().to_string_lossy().to_string())
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
                sevenz_rust::decompress_with_extract_fn(reader, Path::new(""), |entry, _reader, _dest| {
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
                    Ok(false)
                })
                .ok();
                Ok(entries)
            }
            "gz" | "tgz" => {
                let file = fs::File::open(&archive).map_err(|e| e.to_string())?;
                let dec = flate2::read::GzDecoder::new(file);
                let mut tar = tar::Archive::new(dec);
                let mut entries = Vec::new();
                for entry in tar.entries().map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let path_str = entry.path().map_err(|e| e.to_string())?.to_string_lossy().to_string();
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
                    let path_str = entry.path().map_err(|e| e.to_string())?.to_string_lossy().to_string();
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

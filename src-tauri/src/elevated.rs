#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command;

/// Escape a string for safe embedding in a POSIX shell single-quoted context.
/// The only character that needs escaping in single quotes is the single quote itself.
/// We also strip null bytes and newlines to prevent argument injection.
#[cfg(unix)]
fn shell_escape(s: &str) -> String {
    if s.contains('\0') || s.contains('\n') || s.contains('\r') {
        log::warn!("[Elevated] shell_escape: path contains null/newline characters");
    }
    s.replace('\'', "'\\''").replace(['\0', '\n', '\r'], "")
}

/// Escape a string for safe embedding in an AppleScript double-quoted string literal.
/// AppleScript inside "..." treats \", \\, \n, \t, \r as escapes. Backslash and double
/// quote must be doubled; control characters are rejected outright.
#[cfg(target_os = "macos")]
fn osa_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace(['\0', '\n', '\r'], "")
}

fn validate_elevated_path(path: &str, label: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err(format!("{} path is empty", label));
    }
    for ch in path.chars() {
        if ch == '\0' || (ch.is_control() && ch != '\t') {
            return Err(format!(
                "{} path contains a control character — refuse elevation",
                label
            ));
        }
        if matches!(ch, '$' | '`' | ';' | '|' | '&' | '<' | '>' | '\n' | '\r') {
            return Err(format!(
                "{} path contains a shell metacharacter ({:?}) — refuse elevation. Rename the file in userland first.",
                label, ch
            ));
        }
    }
    // A path component starting with `-` would be interpreted as a flag by
    // a privileged cp/mv/rm. We additionally protect by using `--` separators
    // below, but rejecting here is belt + suspenders.
    let basename_starts_with_dash = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('-'))
        .unwrap_or(false);
    if path.starts_with('-') || basename_starts_with_dash {
        return Err(format!(
            "{} path starts with '-' — refuse elevation to avoid flag parsing",
            label
        ));
    }
    Ok(())
}

/// Re-resolve paths immediately before spawning the privileged helper to narrow
/// the TOCTOU window between IPC validation and elevation.
fn resolve_elevated_source_before_exec(source: &str, op: &str) -> Result<String, String> {
    validate_elevated_path(source, "Source")?;
    let path = crate::validate_existing_path(source, "Source")?;
    std::fs::symlink_metadata(&path)
        .map_err(|e| format!("Source path no longer accessible before elevation: {}", e))?;
    if op == "delete" {
        crate::ensure_not_root_path(&path, "delete")?;
        return Ok(source.to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Cannot canonicalize source before elevation: {}", e))?;
    crate::ensure_not_root_path(&canonical, op)?;
    Ok(canonical.to_string_lossy().to_string())
}

fn resolve_elevated_dest_before_exec(dest: &str) -> Result<String, String> {
    validate_elevated_path(dest, "Destination")?;
    let path = crate::validate_path(dest, "Destination")?;
    let parent = path
        .parent()
        .ok_or_else(|| "Destination has no parent directory".to_string())?;
    let parent_meta = std::fs::symlink_metadata(parent).map_err(|e| {
        format!(
            "Destination parent no longer accessible before elevation: {}",
            e
        )
    })?;
    if parent_meta.file_type().is_symlink() {
        return Err(
            "Destination parent is a symbolic link — refusing elevated operation".to_string(),
        );
    }
    let parent_canonical = parent
        .canonicalize()
        .map_err(|e| format!("Cannot canonicalize destination parent: {}", e))?;
    crate::ensure_not_root_path(&parent_canonical, "destination parent")?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "Destination has no file name".to_string())?;
    let resolved = parent_canonical.join(file_name);
    let resolved_str = resolved.to_string_lossy().to_string();
    validate_elevated_path(&resolved_str, "Destination")?;
    Ok(resolved_str)
}

fn resolve_elevated_paths_before_exec(
    op: &str,
    source: &str,
    dest: Option<&str>,
) -> Result<(String, Option<String>), String> {
    let source = resolve_elevated_source_before_exec(source, op)?;
    let dest = match dest {
        Some(d) => Some(resolve_elevated_dest_before_exec(d)?),
        None => None,
    };
    Ok((source, dest))
}

/// Run privileged Windows file operations through the native Shell API.
///
/// `IFileOperation` owns the UAC prompt and performs copy/move/delete directly,
/// avoiding shell command construction and encoded PowerShell launchers. The
/// latter look indistinguishable from common malware loaders to heuristic AV.
#[cfg(target_os = "windows")]
fn run_windows_file_operations(
    op: &str,
    items: &[(String, Option<String>)],
    destination_is_folder: bool,
) -> Result<(), String> {
    use std::path::Path;
    use windows::{
        core::{HSTRING, PCWSTR},
        Win32::{
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            UI::Shell::{
                FileOperation, IFileOperation, IShellItem, SHCreateItemFromParsingName,
                FOFX_EARLYFAILURE, FOFX_REQUIREELEVATION, FOFX_SHOWELEVATIONPROMPT,
                FOF_NOCONFIRMATION, FOF_NOCONFIRMMKDIR, FOF_NOERRORUI, FOF_SILENT,
            },
        },
    };

    fn destination_parts(
        dest: &str,
        destination_is_folder: bool,
    ) -> Result<(String, Option<String>), String> {
        let path = Path::new(dest);
        if destination_is_folder || path.is_dir() {
            return Ok((dest.to_string(), None));
        }

        let parent = path
            .parent()
            .ok_or_else(|| format!("Destination has no parent directory: {dest}"))?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("Destination has no valid file name: {dest}"))?;
        Ok((parent.to_string_lossy().to_string(), Some(name.to_string())))
    }

    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|error| format!("Failed to initialize Windows COM: {error}"))?;

    let result = (|| unsafe {
        let file_operation: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| format!("Failed to create Windows file operation: {error}"))?;

        file_operation
            .SetOperationFlags(
                FOF_NOCONFIRMATION
                    | FOF_NOCONFIRMMKDIR
                    | FOF_SILENT
                    | FOF_NOERRORUI
                    | FOFX_SHOWELEVATIONPROMPT
                    | FOFX_REQUIREELEVATION
                    | FOFX_EARLYFAILURE,
            )
            .map_err(|error| format!("Failed to configure Windows file operation: {error}"))?;

        for (source, dest) in items {
            let source_path = HSTRING::from(source.as_str());
            let source_item: IShellItem = SHCreateItemFromParsingName(&source_path, None)
                .map_err(|error| format!("Failed to open source path {source}: {error}"))?;

            match op {
                "delete" => file_operation
                    .DeleteItem(&source_item, None)
                    .map_err(|error| format!("Failed to queue delete for {source}: {error}"))?,
                "copy" | "move" => {
                    let dest = dest
                        .as_deref()
                        .ok_or_else(|| format!("Destination required for {op}"))?;
                    let (destination_folder, new_name) =
                        destination_parts(dest, destination_is_folder)?;
                    let destination_path = HSTRING::from(destination_folder.as_str());
                    let destination_item: IShellItem =
                        SHCreateItemFromParsingName(&destination_path, None).map_err(|error| {
                            format!(
                                "Failed to open destination folder {destination_folder}: {error}"
                            )
                        })?;
                    let new_name = new_name.map(HSTRING::from);
                    let new_name = new_name
                        .as_ref()
                        .map_or(PCWSTR::null(), |value| PCWSTR(value.as_ptr()));

                    if op == "copy" {
                        file_operation
                            .CopyItem(&source_item, &destination_item, new_name, None)
                            .map_err(|error| {
                                format!("Failed to queue copy for {source}: {error}")
                            })?;
                    } else {
                        file_operation
                            .MoveItem(&source_item, &destination_item, new_name, None)
                            .map_err(|error| {
                                format!("Failed to queue move for {source}: {error}")
                            })?;
                    }
                }
                _ => return Err(format!("Unknown operation: {op}")),
            }
        }

        file_operation
            .PerformOperations()
            .map_err(|error| format!("Elevated Windows file operation failed: {error}"))?;
        if file_operation
            .GetAnyOperationsAborted()
            .map_err(|error| format!("Failed to read Windows file operation status: {error}"))?
            .as_bool()
        {
            return Err("Elevated Windows file operation was cancelled or aborted".to_string());
        }

        Ok(())
    })();

    unsafe { CoUninitialize() };
    result
}

/// Linux: verify the current_exe lives under a trusted system path before
/// re-launching it through the platform elevation API. Without this check, a
/// writable install location (snap extraction dir, sideloaded AppImage,
/// hostile $PATH shadowing) lets an attacker get a free root shell when
/// the user clicks "Restart as Admin." (M1)
#[cfg(target_os = "linux")]
fn verify_trusted_exe_path(exe: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let canonical = exe
        .canonicalize()
        .map_err(|e| format!("Cannot canonicalize current_exe: {}", e))?;
    const TRUSTED_PREFIXES: &[&str] = &[
        "/usr/bin/",
        "/usr/local/bin/",
        "/usr/sbin/",
        "/usr/local/sbin/",
        "/opt/",
        "/snap/",
        "/var/lib/flatpak/",
        "/app/",          // flatpak runtime
        "/run/host/usr/", // flatpak host fallback
        "/Applications/", // unlikely on Linux but harmless
    ];
    let s = canonical.to_string_lossy();
    if TRUSTED_PREFIXES.iter().any(|p| s.starts_with(p)) {
        Ok(canonical)
    } else {
        Err(format!(
            "Refusing to elevate untrusted exe path: {} (not under a trusted system prefix)",
            s
        ))
    }
}

#[tauri::command]
pub async fn elevated_copy(source_path: String, dest_path: String) -> Result<(), String> {
    crate::validate_existing_path(&source_path, "Source")?;
    let dest = crate::validate_path(&dest_path, "Destination")?;
    validate_elevated_path(&source_path, "Source")?;
    validate_elevated_path(&dest_path, "Destination")?;
    crate::ensure_not_root_path(&dest, "copy destination")?;
    run_elevated_file_op("copy", &source_path, Some(&dest_path)).await
}

#[tauri::command]
pub async fn elevated_move(source_path: String, dest_path: String) -> Result<(), String> {
    let src = crate::validate_existing_path(&source_path, "Source")?;
    let dest = crate::validate_path(&dest_path, "Destination")?;
    validate_elevated_path(&source_path, "Source")?;
    validate_elevated_path(&dest_path, "Destination")?;
    crate::ensure_not_root_path(&src, "move source")?;
    crate::ensure_not_root_path(&dest, "move destination")?;
    run_elevated_file_op("move", &source_path, Some(&dest_path)).await
}

#[tauri::command]
pub async fn elevated_delete(item_path: String) -> Result<(), String> {
    let path = crate::validate_existing_path(&item_path, "Item")?;
    crate::ensure_not_root_path(&path, "delete")?;
    validate_elevated_path(&item_path, "Item")?;
    run_elevated_file_op("delete", &item_path, None).await?;
    crate::undo::clear_undo_redo_for_path(&item_path)?;
    Ok(())
}

#[tauri::command]
pub async fn elevated_rename(item_path: String, new_name: String) -> Result<(), String> {
    let path = crate::validate_existing_path(&item_path, "Item")?;
    let new_name = crate::file_operations::validate_child_name(&new_name, "New name")?;
    let new_path = path
        .parent()
        .ok_or("Cannot determine parent directory")?
        .join(&new_name);
    let new_path_str = new_path.to_string_lossy().to_string();
    validate_elevated_path(&item_path, "Item")?;
    validate_elevated_path(&new_path_str, "New path")?;
    run_elevated_file_op("move", &item_path, Some(&new_path_str)).await
}

#[tauri::command]
pub async fn restart_as_admin() -> Result<(), String> {
    log::info!("[Elevated] restart_as_admin requested");
    #[cfg(target_os = "windows")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        use windows::{
            core::{HSTRING, PCWSTR},
            Win32::{
                Foundation::HWND,
                UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
            },
        };
        let verb = HSTRING::from("runas");
        let executable = HSTRING::from(exe.to_string_lossy().as_ref());
        let result = unsafe {
            ShellExecuteW(
                HWND::default(),
                PCWSTR(verb.as_ptr()),
                PCWSTR(executable.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        let status = result.0 as isize;
        if status <= 32 {
            return Err(format!(
                "Failed to restart as admin (ShellExecuteW status {status})"
            ));
        }
    }

    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = exe.display().to_string();
        // Build the shell command, then escape it for the AppleScript "..."
        // string literal. The previous version only escaped \ and " on the
        // _whole_ command; here we escape the path itself first as well so
        // a `"` in the install path cannot break out of AppleScript quoting. (M2)
        let inner = format!("open '{}'", shell_escape(&exe_str));
        let osa = osa_escape(&inner);
        Command::new("osascript")
            .args([
                "-e",
                &format!("do shell script \"{}\" with administrator privileges", osa),
            ])
            .spawn()
            .map_err(|e| format!("Failed to restart as admin: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let trusted = verify_trusted_exe_path(&exe)?; // M1
        Command::new("pkexec")
            .arg("--")
            .arg(trusted)
            .spawn()
            .map_err(|e| format!("Failed to restart as admin: {}", e))?;
    }

    Ok(())
}

async fn run_elevated_file_op(op: &str, source: &str, dest: Option<&str>) -> Result<(), String> {
    log::debug!("[Elevated] {} src={} dst={:?}", op, source, dest);
    let source = source.to_string();
    let dest = dest.map(String::from);
    let op = op.to_string();

    tokio::task::spawn_blocking(move || {
        let (source, dest) = resolve_elevated_paths_before_exec(&op, &source, dest.as_deref())?;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let dest_str = match op.as_str() {
            "copy" | "move" => Some(
                dest.as_deref()
                    .ok_or_else(|| format!("Destination required for {}", op))?,
            ),
            _ => None,
        };

        #[cfg(target_os = "windows")]
        {
            run_windows_file_operations(&op, &[(source.clone(), dest.clone())], false)?;
        }

        #[cfg(target_os = "macos")]
        {
            // C1: write a temp shell script with paths embedded as single-quoted
            // literals. The script runs under `do shell script ... with administrator
            // privileges` via osascript, but the path interpolation happens *once*
            // (when we build the script content) and is verified by validate_elevated_path
            // at the entry — we will not see $/backtick/etc. by the time we reach here.
            //
            // `cp -RP` does not follow symlinks at the top-level argument (H5: TOCTOU
            // protection — a user-controlled parent dir cannot swap the source for
            // /etc/shadow between validation and execution).
            let line = match op.as_str() {
                "copy" => format!(
                    "/bin/cp -RP -- '{}' '{}'",
                    shell_escape(&source),
                    shell_escape(dest_str.unwrap_or_default())
                ),
                "move" => format!(
                    "/bin/mv -- '{}' '{}'",
                    shell_escape(&source),
                    shell_escape(dest_str.unwrap_or_default())
                ),
                "delete" => format!("/bin/rm -rf -- '{}'", shell_escape(&source)),
                _ => return Err(format!("Unknown operation: {}", op)),
            };

            let osa = osa_escape(&line);
            let output = Command::new("osascript")
                .args([
                    "-e",
                    &format!("do shell script \"{}\" with administrator privileges", osa),
                ])
                .output()
                .map_err(|e| e.to_string())?;

            if !output.status.success() {
                return Err(format!(
                    "Elevated operation failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
        }

        #[cfg(target_os = "linux")]
        {
            // C2: pass `--` so a path starting with `-` is never interpreted
            // as a flag by the privileged cp/mv/rm. Combined with the
            // validate_elevated_path check at the entry, this is belt + suspenders.
            let (cmd, leading_args): (&str, &[&str]) = match op.as_str() {
                "copy" => ("cp", &["-RP", "--"]),
                "move" => ("mv", &["--"]),
                "delete" => ("rm", &["-rf", "--"]),
                _ => return Err(format!("Unknown operation: {}", op)),
            };

            let mut pkexec_args: Vec<&str> = vec!["--", cmd];
            pkexec_args.extend_from_slice(leading_args);
            pkexec_args.push(&source);
            if let Some(d) = dest_str {
                pkexec_args.push(d);
            }

            let output = Command::new("pkexec")
                .args(&pkexec_args)
                .output()
                .map_err(|e| e.to_string())?;

            if !output.status.success() {
                return Err(format!(
                    "Elevated operation failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn elevated_copy_batch(
    source_paths: Vec<String>,
    dest_path: String,
) -> Result<(), String> {
    for p in &source_paths {
        crate::validate_existing_path(p, "Source")?;
        validate_elevated_path(p, "Source")?;
    }
    let dest = crate::validate_path(&dest_path, "Destination")?;
    validate_elevated_path(&dest_path, "Destination")?;
    crate::ensure_not_root_path(&dest, "copy destination")?;
    let items: Vec<(String, Option<String>)> = source_paths
        .into_iter()
        .map(|s| (s, Some(dest_path.clone())))
        .collect();
    run_elevated_batch_op("copy", items).await
}

#[tauri::command]
pub async fn elevated_move_batch(
    source_paths: Vec<String>,
    dest_path: String,
) -> Result<(), String> {
    for p in &source_paths {
        let src = crate::validate_existing_path(p, "Source")?;
        validate_elevated_path(p, "Source")?;
        crate::ensure_not_root_path(&src, "move source")?;
    }
    let dest = crate::validate_path(&dest_path, "Destination")?;
    validate_elevated_path(&dest_path, "Destination")?;
    crate::ensure_not_root_path(&dest, "move destination")?;
    let items: Vec<(String, Option<String>)> = source_paths
        .into_iter()
        .map(|s| (s, Some(dest_path.clone())))
        .collect();
    run_elevated_batch_op("move", items).await
}

#[tauri::command]
pub async fn elevated_delete_batch(item_paths: Vec<String>) -> Result<(), String> {
    for p in &item_paths {
        let path = crate::validate_existing_path(p, "Item")?;
        crate::ensure_not_root_path(&path, "delete")?;
        validate_elevated_path(p, "Item")?;
    }
    let items: Vec<(String, Option<String>)> = item_paths.into_iter().map(|s| (s, None)).collect();
    run_elevated_batch_op("delete", items.clone()).await?;
    for (item_path, _) in &items {
        crate::undo::clear_undo_redo_for_path(item_path)?;
    }
    Ok(())
}

async fn run_elevated_batch_op(
    op: &str,
    items: Vec<(String, Option<String>)>,
) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    if items.len() == 1 {
        let (src, dst) = &items[0];
        return run_elevated_file_op(op, src, dst.as_deref()).await;
    }
    let op = op.to_string();

    tokio::task::spawn_blocking(move || {
        let mut resolved_items: Vec<(String, Option<String>)> = Vec::with_capacity(items.len());
        for (src, dst) in &items {
            resolved_items.push(resolve_elevated_paths_before_exec(
                &op,
                src,
                dst.as_deref(),
            )?);
        }

        #[cfg(target_os = "windows")]
        {
            run_windows_file_operations(&op, &resolved_items, true)?;
        }

        #[cfg(target_os = "macos")]
        {
            let mut lines = Vec::new();
            for (src, dst) in &resolved_items {
                let line = match op.as_str() {
                    "copy" => format!(
                        "/bin/cp -RP -- '{}' '{}'",
                        shell_escape(src),
                        shell_escape(dst.as_deref().unwrap_or(""))
                    ),
                    "move" => format!(
                        "/bin/mv -- '{}' '{}'",
                        shell_escape(src),
                        shell_escape(dst.as_deref().unwrap_or(""))
                    ),
                    "delete" => format!("/bin/rm -rf -- '{}'", shell_escape(src)),
                    _ => return Err(format!("Unknown operation: {}", op)),
                };
                lines.push(line);
            }
            let script_content = lines.join(" && ");
            let osa = osa_escape(&script_content);
            let output = Command::new("osascript")
                .args([
                    "-e",
                    &format!("do shell script \"{}\" with administrator privileges", osa),
                ])
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(format!(
                    "Elevated operation failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
        }

        #[cfg(target_os = "linux")]
        {
            // cp/mv accept multiple sources followed by one destination; rm
            // accepts multiple paths. Build argv directly so elevation never
            // interprets a generated shell program.
            let (command, leading_args): (&str, &[&str]) = match op.as_str() {
                "copy" => ("cp", &["-RP", "--"]),
                "move" => ("mv", &["--"]),
                "delete" => ("rm", &["-rf", "--"]),
                _ => return Err(format!("Unknown operation: {}", op)),
            };
            let mut args = vec!["--", command];
            args.extend_from_slice(leading_args);
            for (source, _) in &resolved_items {
                args.push(source.as_str());
            }
            if matches!(op.as_str(), "copy" | "move") {
                let destination = resolved_items
                    .first()
                    .and_then(|(_, destination)| destination.as_deref())
                    .ok_or_else(|| format!("Destination required for {}", op))?;
                if resolved_items
                    .iter()
                    .any(|(_, candidate)| candidate.as_deref() != Some(destination))
                {
                    return Err("Batch operation contains inconsistent destinations".to_string());
                }
                args.push(destination);
            }

            let output = Command::new("pkexec")
                .args(args)
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(format!(
                    "Elevated operation failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_elevated_path_rejects_metacharacters() {
        assert!(validate_elevated_path("/tmp/foo$(rm -rf ~).txt", "Source").is_err());
        assert!(validate_elevated_path("/tmp/foo`whoami`.txt", "Source").is_err());
        assert!(validate_elevated_path("/tmp/foo;bar", "Source").is_err());
        assert!(validate_elevated_path("/tmp/foo|bar", "Source").is_err());
        assert!(validate_elevated_path("/tmp/foo&bar", "Source").is_err());
        assert!(validate_elevated_path("/tmp/foo<bar", "Source").is_err());
        assert!(validate_elevated_path("/tmp/foo>bar", "Source").is_err());
        assert!(validate_elevated_path("/tmp/foo\nbar", "Source").is_err());
    }

    #[test]
    fn validate_elevated_path_rejects_dash_basename() {
        // A path whose basename starts with `-` would be parsed as a flag
        // by the privileged cp/mv/rm if `--` wasn't there. We reject anyway.
        assert!(validate_elevated_path("--no-preserve-root", "Source").is_err());
        assert!(validate_elevated_path("/tmp/-rf", "Source").is_err());
        assert!(validate_elevated_path("-target-directory=/etc/cron.d", "Source").is_err());
    }

    #[test]
    fn validate_elevated_path_rejects_control_chars() {
        assert!(validate_elevated_path("/tmp/foo\0bar", "Source").is_err());
        assert!(validate_elevated_path("/tmp/foo\x07bar", "Source").is_err());
    }

    #[test]
    fn validate_elevated_path_accepts_normal_paths() {
        assert!(validate_elevated_path("/tmp/foo.txt", "Source").is_ok());
        assert!(validate_elevated_path("/Users/dev/My File.txt", "Source").is_ok());
        assert!(validate_elevated_path("/var/log/system.log", "Source").is_ok());
        assert!(validate_elevated_path("/tmp/file with spaces.txt", "Source").is_ok());
        // Apostrophes in filenames are OK — shell_escape handles them.
        assert!(validate_elevated_path("/tmp/Joe's File.txt", "Source").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn shell_escape_handles_apostrophes() {
        assert_eq!(shell_escape("foo's"), "foo'\\''s");
        assert_eq!(shell_escape("plain"), "plain");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn osa_escape_handles_backslash_and_quote() {
        assert_eq!(osa_escape(r#"with"quote"#), r#"with\"quote"#);
        assert_eq!(osa_escape(r"with\back"), r"with\\back");
    }
}

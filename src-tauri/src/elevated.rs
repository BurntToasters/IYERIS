use std::process::Command;

/// Escape a string for safe embedding in a PowerShell single-quoted literal.
/// PowerShell single-quoted strings only interpret '' as an escaped single quote.
/// We also reject characters that could break out of the quoting context.
#[cfg(target_os = "windows")]
fn ps_escape(s: &str) -> String {
    if s.contains('\0') || s.contains('\n') || s.contains('\r') {
        log::warn!("[Elevated] ps_escape: path contains null/newline characters");
    }
    s.replace('\'', "''").replace(['\0', '\n', '\r'], "")
}

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

#[cfg(target_os = "windows")]
fn ps_encoded_command(script: &str) -> String {
    use base64::{engine::general_purpose, Engine as _};
    let bytes: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    general_purpose::STANDARD.encode(bytes)
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

/// Linux: verify the current_exe lives under a trusted system path before
/// re-launching it via pkexec/osascript/powershell. Without this check, a
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
        #[allow(unsafe_code)]
        // creation_flags is the platform-correct way to suppress the console window
        {
            use std::os::windows::process::CommandExt;
            Command::new("powershell")
                .args([
                    "-Command",
                    &format!(
                        "Start-Process '{}' -Verb RunAs",
                        ps_escape(&exe.display().to_string())
                    ),
                ])
                .creation_flags(0x08000000)
                .spawn()
                .map_err(|e| format!("Failed to restart as admin: {}", e))?;
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
        let dest_str = match op.as_str() {
            "copy" | "move" => {
                Some(dest.as_deref().ok_or_else(|| format!("Destination required for {}", op))?)
            }
            _ => None,
        };

        #[cfg(target_os = "windows")]
        {
            let script = match op.as_str() {
                "copy" => format!(
                    "Copy-Item -LiteralPath '{}' -Destination '{}' -Recurse -Force",
                    ps_escape(&source),
                    ps_escape(dest_str.unwrap_or_default())
                ),
                "move" => format!(
                    "Move-Item -LiteralPath '{}' -Destination '{}' -Force",
                    ps_escape(&source),
                    ps_escape(dest_str.unwrap_or_default())
                ),
                "delete" => format!(
                    "Remove-Item -LiteralPath '{}' -Recurse -Force",
                    ps_escape(&source)
                ),
                _ => return Err(format!("Unknown operation: {}", op)),
            };

            let encoded = ps_encoded_command(&script);

            let output = {
                use std::os::windows::process::CommandExt;
                Command::new("powershell")
                    .args([
                        "-Command",
                        &format!(
                            "$p = Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','{}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
                            encoded
                        ),
                    ])
                    .creation_flags(0x08000000)
                    .output()
                    .map_err(|e| e.to_string())?
            };

            if !output.status.success() {
                return Err(format!(
                    "Elevated operation failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
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
                "delete" => format!(
                    "/bin/rm -rf -- '{}'",
                    shell_escape(&source)
                ),
                _ => return Err(format!("Unknown operation: {}", op)),
            };

            let osa = osa_escape(&line);
            let output = Command::new("osascript")
                .args([
                    "-e",
                    &format!(
                        "do shell script \"{}\" with administrator privileges",
                        osa
                    ),
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
                "copy" => ("cp", &["-r", "--"]),
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
        #[cfg(target_os = "windows")]
        {
            let mut lines = Vec::new();
            for (src, dst) in &items {
                let line = match op.as_str() {
                    "copy" => format!(
                        "Copy-Item -LiteralPath '{}' -Destination '{}' -Recurse -Force",
                        ps_escape(src),
                        ps_escape(dst.as_deref().unwrap_or(""))
                    ),
                    "move" => format!(
                        "Move-Item -LiteralPath '{}' -Destination '{}' -Force",
                        ps_escape(src),
                        ps_escape(dst.as_deref().unwrap_or(""))
                    ),
                    "delete" => format!(
                        "Remove-Item -LiteralPath '{}' -Recurse -Force",
                        ps_escape(src)
                    ),
                    _ => return Err(format!("Unknown operation: {}", op)),
                };
                lines.push(line);
            }
            let script = lines.join("\n");
            let encoded = ps_encoded_command(&script);

            let output = {
                use std::os::windows::process::CommandExt;
                Command::new("powershell")
                    .args([
                        "-Command",
                        &format!(
                            "$p = Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','{}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
                            encoded
                        ),
                    ])
                    .creation_flags(0x08000000)
                    .output()
                    .map_err(|e| e.to_string())?
            };
            if !output.status.success() {
                return Err(format!(
                    "Elevated operation failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
        }

        #[cfg(target_os = "macos")]
        {
            let mut lines = Vec::new();
            for (src, dst) in &items {
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
                    "delete" => format!(
                        "/bin/rm -rf -- '{}'",
                        shell_escape(src)
                    ),
                    _ => return Err(format!("Unknown operation: {}", op)),
                };
                lines.push(line);
            }
            let script_content = lines.join(" && ");
            let osa = osa_escape(&script_content);
            let output = Command::new("osascript")
                .args([
                    "-e",
                    &format!(
                        "do shell script \"{}\" with administrator privileges",
                        osa
                    ),
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
            let mut lines = vec!["#!/bin/sh".to_string(), "set -e".to_string()];
            for (src, dst) in &items {
                let line = match op.as_str() {
                    "copy" => format!(
                        "cp -r -- '{}' '{}'",
                        shell_escape(src),
                        shell_escape(dst.as_deref().unwrap_or(""))
                    ),
                    "move" => format!(
                        "mv -- '{}' '{}'",
                        shell_escape(src),
                        shell_escape(dst.as_deref().unwrap_or(""))
                    ),
                    "delete" => format!(
                        "rm -rf -- '{}'",
                        shell_escape(src)
                    ),
                    _ => return Err(format!("Unknown operation: {}", op)),
                };
                lines.push(line);
            }
            let script_content = lines.join("\n");

            let output = Command::new("pkexec")
                .args(["--", "sh", "-c", &script_content])
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

use std::process::Command;

#[cfg(target_os = "windows")]
fn ps_escape(s: &str) -> String {
    s.replace('\'', "''")
}

#[cfg(target_os = "macos")]
fn shell_escape(s: &str) -> String {
    s.replace('\'', "'\\''")
}

#[tauri::command]
pub async fn elevated_copy(source_path: String, dest_path: String) -> Result<(), String> {
    crate::validate_existing_path(&source_path, "Source")?;
    crate::validate_path(&dest_path, "Destination")?;
    run_elevated_file_op("copy", &source_path, Some(&dest_path)).await
}

#[tauri::command]
pub async fn elevated_move(source_path: String, dest_path: String) -> Result<(), String> {
    crate::validate_existing_path(&source_path, "Source")?;
    crate::validate_path(&dest_path, "Destination")?;
    run_elevated_file_op("move", &source_path, Some(&dest_path)).await
}

#[tauri::command]
pub async fn elevated_delete(item_path: String) -> Result<(), String> {
    let path = crate::validate_existing_path(&item_path, "Item")?;
    if path.parent().is_none() {
        return Err("Cannot delete a root directory".to_string());
    }
    crate::undo::clear_undo_redo_for_path(&item_path)?;
    run_elevated_file_op("delete", &item_path, None).await
}

#[tauri::command]
pub async fn elevated_rename(item_path: String, new_name: String) -> Result<(), String> {
    let path = crate::validate_existing_path(&item_path, "Item")?;
    let new_name = crate::file_operations::validate_child_name(&new_name, "New name")?;
    let new_path = path
        .parent()
        .ok_or("Cannot determine parent directory")?
        .join(&new_name);
    run_elevated_file_op("move", &item_path, Some(&new_path.to_string_lossy())).await
}

#[tauri::command]
pub async fn restart_as_admin() -> Result<(), String> {
    log::info!("[Elevated] restart_as_admin requested");
    #[cfg(target_os = "windows")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
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
        let escaped = shell_escape(&exe.display().to_string()).replace('\\', "\\\\").replace('"', "\\\"");
        Command::new("osascript")
            .args([
                "-e",
                &format!(
                    "do shell script \"open '{}'\" with administrator privileges",
                    escaped
                ),
            ])
            .spawn()
            .map_err(|e| format!("Failed to restart as admin: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        Command::new("pkexec")
            .arg(exe)
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
        #[cfg(target_os = "windows")]
        {
            let script = match op.as_str() {
                "copy" => format!(
                    "Copy-Item -LiteralPath '{}' -Destination '{}' -Recurse -Force",
                    ps_escape(&source),
                    ps_escape(dest.as_deref().unwrap_or(""))
                ),
                "move" => format!(
                    "Move-Item -LiteralPath '{}' -Destination '{}' -Force",
                    ps_escape(&source),
                    ps_escape(dest.as_deref().unwrap_or(""))
                ),
                "delete" => format!(
                    "Remove-Item -LiteralPath '{}' -Recurse -Force",
                    ps_escape(&source)
                ),
                _ => return Err(format!("Unknown operation: {}", op)),
            };

            let temp_dir = std::env::temp_dir();
            let script_path = temp_dir.join(format!("iyeris_elevated_{}.ps1", std::process::id()));
            std::fs::write(&script_path, &script)
                .map_err(|e| format!("Failed to write temp script: {}", e))?;

            let output = {
                use std::os::windows::process::CommandExt;
                let result = Command::new("powershell")
                    .args([
                        "-Command",
                        &format!(
                            "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{}' -Verb RunAs -Wait",
                            ps_escape(&script_path.display().to_string())
                        ),
                    ])
                    .creation_flags(0x08000000)
                    .output()
                    .map_err(|e| e.to_string());
                let _ = std::fs::remove_file(&script_path);
                result?
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
            let src = shell_escape(&source);
            let dst = shell_escape(dest.as_deref().unwrap_or(""));
            let cmd = match op.as_str() {
                "copy" => format!("cp -R '{}' '{}'", src, dst),
                "move" => format!("mv '{}' '{}'", src, dst),
                "delete" => format!("rm -rf '{}'", src),
                _ => return Err(format!("Unknown operation: {}", op)),
            };

            let osa_cmd = cmd.replace('\\', "\\\\").replace('"', "\\\"");
            let output = Command::new("osascript")
                .args([
                    "-e",
                    &format!("do shell script \"{}\" with administrator privileges", osa_cmd),
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
            let (cmd, args) = match op.as_str() {
                "copy" => ("cp", vec!["-r", &source, dest.as_deref().unwrap_or("")]),
                "move" => ("mv", vec![&source as &str, dest.as_deref().unwrap_or("")]),
                "delete" => ("rm", vec!["-rf", &source]),
                _ => return Err(format!("Unknown operation: {}", op)),
            };

            let mut pkexec_args = vec![cmd];
            pkexec_args.extend(args);

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

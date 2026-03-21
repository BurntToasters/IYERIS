use std::process::Command;

#[cfg(target_os = "windows")]
fn ps_escape(s: &str) -> String {
    s.replace('\'', "''")
}

fn shell_escape(s: &str) -> String {
    s.replace('\'', "'\\''")
}

#[tauri::command]
pub async fn elevated_copy(source_path: String, dest_path: String) -> Result<(), String> {
    run_elevated_file_op("copy", &source_path, Some(&dest_path)).await
}

#[tauri::command]
pub async fn elevated_move(source_path: String, dest_path: String) -> Result<(), String> {
    run_elevated_file_op("move", &source_path, Some(&dest_path)).await
}

#[tauri::command]
pub async fn elevated_delete(item_path: String) -> Result<(), String> {
    run_elevated_file_op("delete", &item_path, None).await
}

#[tauri::command]
pub async fn elevated_rename(item_path: String, new_name: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(&item_path);
    let new_path = path
        .parent()
        .ok_or("Cannot determine parent directory")?
        .join(&new_name);
    run_elevated_file_op("move", &item_path, Some(&new_path.to_string_lossy())).await
}

#[tauri::command]
pub async fn restart_as_admin() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        Command::new("powershell")
            .args([
                "-Command",
                &format!(
                    "Start-Process '{}' -Verb RunAs",
                    exe.display()
                ),
            ])
            .spawn()
            .map_err(|e| format!("Failed to restart as admin: {}", e))?;
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
    let source = source.to_string();
    let dest = dest.map(String::from);
    let op = op.to_string();

    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            let src = ps_escape(&source);
            let dst = ps_escape(dest.as_deref().unwrap_or(""));
            let script = match op.as_str() {
                "copy" => format!(
                    "Copy-Item -Path ''{}'' -Destination ''{}'' -Recurse -Force",
                    src, dst
                ),
                "move" => format!(
                    "Move-Item -Path ''{}'' -Destination ''{}'' -Force",
                    src, dst
                ),
                "delete" => format!("Remove-Item -Path ''{}'' -Recurse -Force", src),
                _ => return Err(format!("Unknown operation: {}", op)),
            };

            let output = Command::new("powershell")
                .args([
                    "-Command",
                    &format!("Start-Process powershell -ArgumentList '-Command {}' -Verb RunAs -Wait", script),
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

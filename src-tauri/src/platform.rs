use std::process::Command;

#[tauri::command]
pub async fn check_for_updates() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "available": false,
        "message": "Updates are handled by the Tauri updater plugin"
    }))
}

#[tauri::command]
pub async fn download_update() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn install_update() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn get_git_status(
    dir_path: String,
    include_untracked: Option<bool>,
) -> Result<serde_json::Value, String> {
    let path = crate::validate_existing_path(&dir_path, "Directory")?;
    let include_untracked = include_untracked.unwrap_or(false);

    tokio::task::spawn_blocking(move || {
        let mut args = vec!["status", "--porcelain"];
        if include_untracked {
            args.push("-uall");
        }

        let output = Command::new("git")
            .args(&args)
            .current_dir(&path)
            .output();

        match output {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let mut modified = Vec::new();
                let mut added = Vec::new();
                let mut deleted = Vec::new();
                let mut untracked = Vec::new();

                for line in stdout.lines() {
                    if line.len() < 3 {
                        continue;
                    }
                    let status = &line[..2];
                    let file = line[3..].trim().to_string();

                    match status.trim() {
                        "M" | "MM" | "AM" => modified.push(file),
                        "A" => added.push(file),
                        "D" => deleted.push(file),
                        "??" => untracked.push(file),
                        _ => {}
                    }
                }

                Ok(serde_json::json!({
                    "isGitRepo": true,
                    "modified": modified,
                    "added": added,
                    "deleted": deleted,
                    "untracked": untracked,
                }))
            }
            _ => Ok(serde_json::json!({
                "isGitRepo": false,
                "modified": [],
                "added": [],
                "deleted": [],
                "untracked": [],
            })),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_git_branch(dir_path: String) -> Result<String, String> {
    let path = crate::validate_existing_path(&dir_path, "Directory")?;

    tokio::task::spawn_blocking(move || {
        let output = Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&path)
            .output();

        match output {
            Ok(out) if out.status.success() => {
                Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
            }
            _ => Ok(String::new()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

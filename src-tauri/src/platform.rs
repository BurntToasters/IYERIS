use std::process::Command;
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const GIT_TIMEOUT: Duration = Duration::from_secs(5);

#[tauri::command]
pub async fn get_git_status(
    dir_path: String,
    include_untracked: Option<bool>,
) -> Result<serde_json::Value, String> {
    log::debug!("[Git] get_git_status: {}", dir_path);
    let path = crate::validate_existing_path(&dir_path, "Directory")?;
    let include_untracked = include_untracked.unwrap_or(false);

    match tokio::time::timeout(
        GIT_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            let mut probe_cmd = Command::new("git");
            probe_cmd
                .args(["rev-parse", "--is-inside-work-tree"])
                .current_dir(&path);
            #[cfg(target_os = "windows")]
            probe_cmd.creation_flags(0x08000000);
            let probe = probe_cmd.output().map_err(|e| e.to_string())?;
            if !probe.status.success() {
                return Ok(serde_json::json!({
                    "isGitRepo": false,
                    "modified": [],
                    "added": [],
                    "deleted": [],
                    "untracked": [],
                }));
            }

            let mut args = vec!["status", "--porcelain"];
            if include_untracked {
                args.push("-uall");
            }

            let mut cmd = Command::new("git");
            cmd.args(&args).current_dir(&path);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000);
            match cmd.output() {
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
                Ok(out) => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
                Err(error) => Err(error.to_string()),
            }
        }),
    )
    .await
    {
        Ok(Ok(Ok(val))) => Ok(val),
        Ok(Ok(Err(e))) => Err(e),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("Git status timed out".to_string()),
    }
}

#[tauri::command]
pub async fn get_git_branch(dir_path: String) -> Result<String, String> {
    log::debug!("[Git] get_git_branch: {}", dir_path);
    let path = crate::validate_existing_path(&dir_path, "Directory")?;

    match tokio::time::timeout(
        GIT_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            let mut cmd = Command::new("git");
            cmd.args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(&path);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000);
            let mut probe_cmd = Command::new("git");
            probe_cmd
                .args(["rev-parse", "--is-inside-work-tree"])
                .current_dir(&path);
            #[cfg(target_os = "windows")]
            probe_cmd.creation_flags(0x08000000);
            let probe = probe_cmd.output().map_err(|e| e.to_string())?;
            if !probe.status.success() {
                return Ok(String::new());
            }

            match cmd.output() {
                Ok(out) if out.status.success() => Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()),
                Ok(out) => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
                Err(error) => Err(error.to_string()),
            }
        }),
    )
    .await
    {
        Ok(Ok(Ok(val))) => Ok(val),
        Ok(Ok(Err(e))) => Err(e),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("Git branch query timed out".to_string()),
    }
}

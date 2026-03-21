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
    let path = crate::validate_existing_path(&dir_path, "Directory")?;
    let include_untracked = include_untracked.unwrap_or(false);

    match tokio::time::timeout(GIT_TIMEOUT, tokio::task::spawn_blocking(move || {
        let mut args = vec!["status", "--porcelain"];
        if include_untracked {
            args.push("-uall");
        }

        let mut cmd = Command::new("git");
        cmd.args(&args).current_dir(&path);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        let output = cmd.output();

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

                serde_json::json!({
                    "isGitRepo": true,
                    "modified": modified,
                    "added": added,
                    "deleted": deleted,
                    "untracked": untracked,
                })
            }
            _ => serde_json::json!({
                "isGitRepo": false,
                "modified": [],
                "added": [],
                "deleted": [],
                "untracked": [],
            }),
        }
    }))
    .await
    {
        Ok(Ok(val)) => Ok(val),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Ok(serde_json::json!({
            "isGitRepo": false,
            "modified": [],
            "added": [],
            "deleted": [],
            "untracked": [],
        })),
    }
}

#[tauri::command]
pub async fn get_git_branch(dir_path: String) -> Result<String, String> {
    let path = crate::validate_existing_path(&dir_path, "Directory")?;

    match tokio::time::timeout(GIT_TIMEOUT, tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new("git");
        cmd.args(["rev-parse", "--abbrev-ref", "HEAD"]).current_dir(&path);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        let output = cmd.output();

        match output {
            Ok(out) if out.status.success() => {
                String::from_utf8_lossy(&out.stdout).trim().to_string()
            }
            _ => String::new(),
        }
    }))
    .await
    {
        Ok(Ok(val)) => Ok(val),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Ok(String::new()),
    }
}

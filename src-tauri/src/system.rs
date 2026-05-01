use std::fs;
use std::path::Path;
#[cfg(target_os = "linux")]
use std::path::PathBuf;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

static TRAY_READY: AtomicBool = AtomicBool::new(false);
static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);
static LAST_FOCUS_LOST_MS: AtomicU64 = AtomicU64::new(0);

pub fn record_focus_lost() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    LAST_FOCUS_LOST_MS.store(now, Ordering::Relaxed);
}

fn was_recently_focused() -> bool {
    let last = LAST_FOCUS_LOST_MS.load(Ordering::Relaxed);
    if last == 0 {
        return false;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    now.saturating_sub(last) < 500
}

#[cfg(target_os = "linux")]
const DESKTOP_EXEC_FIELD_REGEX: &str = "%[fFuUdDnNickvm]";

#[cfg(target_os = "windows")]
fn is_valid_windows_filetype(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

#[cfg(target_os = "windows")]
fn is_valid_windows_extension(value: &str) -> bool {
    value.starts_with('.')
        && value.len() > 1
        && value[1..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[cfg(target_os = "linux")]
fn tokenize_exec_command(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for ch in command.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }

        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }

        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }

        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }

        if ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            continue;
        }

        current.push(ch);
    }

    if escaped {
        current.push('\\');
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

#[cfg(target_os = "linux")]
fn build_linux_exec_invocation(
    exec_line: &str,
    file_path: Option<&str>,
) -> Option<(String, Vec<String>)> {
    let tokens = tokenize_exec_command(exec_line.trim());
    if tokens.is_empty() {
        return None;
    }

    let mut expanded: Vec<String> = Vec::new();
    let mut has_file_placeholder = false;
    let re = regex::Regex::new(DESKTOP_EXEC_FIELD_REGEX).ok()?;

    for raw in tokens {
        let token = raw.replace("%%", "%");
        if token.contains("%f")
            || token.contains("%F")
            || token.contains("%u")
            || token.contains("%U")
        {
            has_file_placeholder = true;
        }
        let mut replaced = token.clone();
        if let Some(file) = file_path {
            replaced = replaced
                .replace("%f", file)
                .replace("%F", file)
                .replace("%u", file)
                .replace("%U", file);
        } else {
            replaced = replaced
                .replace("%f", "")
                .replace("%F", "")
                .replace("%u", "")
                .replace("%U", "");
        }

        replaced = re.replace_all(&replaced, "").trim().to_string();
        if !replaced.is_empty() {
            expanded.push(replaced);
        }
    }

    if expanded.is_empty() {
        return None;
    }

    let command = expanded[0].clone();
    let mut args = expanded[1..].to_vec();
    if file_path.is_some() && !has_file_placeholder {
        args.push(file_path.unwrap_or_default().to_string());
    }
    Some((command, args))
}

#[cfg(target_os = "linux")]
fn desktop_search_paths() -> Vec<PathBuf> {
    let mut paths = vec![
        PathBuf::from("/usr/share/applications"),
        PathBuf::from("/usr/local/share/applications"),
        PathBuf::from("/var/lib/flatpak/exports/share/applications"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        paths.push(Path::new(&home).join(".local/share/applications"));
        paths.push(Path::new(&home).join(".local/share/flatpak/exports/share/applications"));
    }
    paths
}

#[cfg(target_os = "linux")]
fn load_desktop_entry(desktop_file_name: &str) -> Option<(String, String)> {
    if desktop_file_name.contains("..")
        || desktop_file_name.contains('/')
        || desktop_file_name.contains('\\')
    {
        return None;
    }
    for dir in desktop_search_paths() {
        let full_path = dir.join(desktop_file_name);
        let Ok(content) = fs::read_to_string(&full_path) else {
            continue;
        };
        if content.lines().any(|line| line.trim() == "NoDisplay=true") {
            continue;
        }
        let name = content
            .lines()
            .find_map(|line| line.strip_prefix("Name="))
            .map(|value| value.trim().to_string())
            .unwrap_or_else(|| desktop_file_name.trim_end_matches(".desktop").to_string());
        let exec = content
            .lines()
            .find_map(|line| line.strip_prefix("Exec="))
            .map(|value| value.trim().to_string())?;
        return Some((name, exec));
    }
    None
}

#[cfg(target_os = "linux")]
fn is_path_in_directory(path: &Path, dir: &Path) -> bool {
    let canonical_path = path.canonicalize();
    let canonical_dir = dir.canonicalize();
    match (canonical_path, canonical_dir) {
        (Ok(path_value), Ok(dir_value)) => path_value.starts_with(dir_value),
        _ => false,
    }
}

#[cfg(target_os = "linux")]
fn is_trusted_desktop_entry_path(path: &Path) -> bool {
    desktop_search_paths()
        .into_iter()
        .any(|dir| is_path_in_directory(path, &dir))
}

#[cfg(target_os = "linux")]
fn parse_mime_cache_apps(mime_type: &str) -> Vec<String> {
    let mut desktop_files: Vec<String> = Vec::new();
    let cache_files = {
        let mut files = vec![
            PathBuf::from("/usr/share/applications/mimeinfo.cache"),
            PathBuf::from("/usr/local/share/applications/mimeinfo.cache"),
        ];
        if let Ok(home) = std::env::var("HOME") {
            files.push(Path::new(&home).join(".local/share/applications/mimeinfo.cache"));
        }
        files
    };

    for cache_file in cache_files {
        let Ok(content) = fs::read_to_string(cache_file) else {
            continue;
        };
        for line in content.lines() {
            let Some(rest) = line.strip_prefix(mime_type) else {
                continue;
            };
            let Some(list) = rest.strip_prefix('=') else {
                continue;
            };
            for item in list.split(';').filter(|entry| !entry.trim().is_empty()) {
                let desktop_file = item.trim().to_string();
                if !desktop_files.contains(&desktop_file) {
                    desktop_files.push(desktop_file);
                }
            }
        }
    }

    desktop_files
}

#[cfg(target_os = "linux")]
fn collect_linux_open_with_apps(path: &Path) -> Vec<(String, String)> {
    let mut desktop_ids: Vec<String> = Vec::new();
    let mut apps: Vec<(String, String)> = Vec::new();

    if let Ok(mime_output) = Command::new("xdg-mime")
        .args(["query", "filetype", &path.to_string_lossy()])
        .output()
    {
        if mime_output.status.success() {
            let mime_type = String::from_utf8_lossy(&mime_output.stdout)
                .trim()
                .to_string();
            if !mime_type.is_empty() {
                if let Ok(default_output) = Command::new("xdg-mime")
                    .args(["query", "default", &mime_type])
                    .output()
                {
                    if default_output.status.success() {
                        let desktop_id = String::from_utf8_lossy(&default_output.stdout)
                            .trim()
                            .to_string();
                        if !desktop_id.is_empty() {
                            desktop_ids.push(desktop_id);
                        }
                    }
                }

                for desktop_id in parse_mime_cache_apps(&mime_type) {
                    if !desktop_ids.contains(&desktop_id) {
                        desktop_ids.push(desktop_id);
                    }
                }
            }
        }
    }

    for desktop_id in desktop_ids.into_iter().take(20) {
        if let Some((name, _exec)) = load_desktop_entry(&desktop_id) {
            apps.push((desktop_id, name));
        }
    }

    if apps.is_empty() {
        apps.push(("default".to_string(), "Default Application".to_string()));
    }

    apps
}

#[cfg(target_os = "windows")]
fn collect_windows_open_with_apps(path: &Path) -> Vec<(String, String)> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_ascii_lowercase()))
        .filter(|value| is_valid_windows_extension(value))
        .unwrap_or_default();

    let mut apps: Vec<(String, String)> = Vec::new();
    if !ext.is_empty() {
        if let Ok(assoc_output) = {
            use std::os::windows::process::CommandExt;
            Command::new("cmd")
                .args(["/C", "assoc", &ext])
                .creation_flags(0x08000000)
                .output()
        } {
            if assoc_output.status.success() {
                let assoc_text = String::from_utf8_lossy(&assoc_output.stdout)
                    .trim()
                    .to_string();
                if let Some(file_type) = assoc_text.split('=').nth(1).map(|value| value.trim()) {
                    if is_valid_windows_filetype(file_type) {
                        if let Ok(ftype_output) = {
                            use std::os::windows::process::CommandExt;
                            Command::new("cmd")
                                .args(["/C", "ftype", file_type])
                                .creation_flags(0x08000000)
                                .output()
                        } {
                            if ftype_output.status.success() {
                                let ftype_text = String::from_utf8_lossy(&ftype_output.stdout)
                                    .trim()
                                    .to_string();
                                if let Some(command) = ftype_text.split('=').nth(1) {
                                    let command = command.trim();
                                    let executable = if command.starts_with('"') {
                                        command
                                            .trim_start_matches('"')
                                            .split('"')
                                            .next()
                                            .unwrap_or("")
                                            .to_string()
                                    } else {
                                        command.split_whitespace().next().unwrap_or("").to_string()
                                    };
                                    if !executable.is_empty() {
                                        let name = Path::new(&executable)
                                            .file_stem()
                                            .and_then(|value| value.to_str())
                                            .unwrap_or("Default Application")
                                            .to_string();
                                        apps.push((executable, name));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    for (id, name) in [
        ("notepad.exe".to_string(), "Notepad".to_string()),
        ("mspaint.exe".to_string(), "Paint".to_string()),
        ("wordpad.exe".to_string(), "WordPad".to_string()),
    ] {
        if !apps
            .iter()
            .any(|(existing_id, _)| existing_id.eq_ignore_ascii_case(&id))
        {
            apps.push((id, name));
        }
    }

    if apps.is_empty() {
        apps.push(("default".to_string(), "Default Application".to_string()));
    }

    apps
}

#[tauri::command]
pub fn get_platform() -> String {
    match std::env::consts::OS {
        "macos" => "darwin".to_string(),
        "windows" => "win32".to_string(),
        os => os.to_string(),
    }
}

#[tauri::command]
pub fn get_system_accent_color() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(serde_json::json!({
            "accentColor": "007AFF",
            "isDarkMode": is_dark_mode(),
        }))
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let accent = (|| -> Option<String> {
            let output = std::process::Command::new("reg")
                .args([
                    "query",
                    "HKCU\\SOFTWARE\\Microsoft\\Windows\\DWM",
                    "/v",
                    "ColorizationColor",
                ])
                .creation_flags(0x08000000)
                .output()
                .ok()?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if let Some(pos) = line.find("0x") {
                    if let Ok(val) = u32::from_str_radix(line[pos + 2..].trim(), 16) {
                        let r = (val >> 16) & 0xFF;
                        let g = (val >> 8) & 0xFF;
                        let b = val & 0xFF;
                        return Some(format!("{:02X}{:02X}{:02X}", r, g, b));
                    }
                }
            }
            None
        })()
        .unwrap_or_else(|| "0078D4".into());

        let is_dark = (|| -> Option<bool> {
            let output = std::process::Command::new("reg")
                .args([
                    "query",
                    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                    "/v",
                    "AppsUseLightTheme",
                ])
                .creation_flags(0x08000000)
                .output()
                .ok()?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if line.contains("0x0") {
                    return Some(true);
                }
                if line.contains("0x1") {
                    return Some(false);
                }
            }
            None
        })()
        .unwrap_or(false);

        Ok(serde_json::json!({
            "accentColor": accent,
            "isDarkMode": is_dark,
        }))
    }

    #[cfg(target_os = "linux")]
    {
        let accent = (|| -> Option<String> {
            let output = std::process::Command::new("gsettings")
                .args(["get", "org.gnome.desktop.interface", "accent-color"])
                .output()
                .ok()?;
            if output.status.success() {
                let color = String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .trim_matches('\'')
                    .to_string();
                let mapped = match color.as_str() {
                    "blue" => "3584E4",
                    "teal" => "2190A4",
                    "green" => "3A944A",
                    "yellow" => "C88800",
                    "orange" => "ED5B00",
                    "red" => "E62D42",
                    "pink" => "D56199",
                    "purple" => "9141AC",
                    "slate" => "6F8396",
                    _ => return None,
                };
                return Some(mapped.into());
            }
            None
        })()
        .unwrap_or_else(|| "3584E4".into());

        let is_dark = (|| -> Option<bool> {
            let output = std::process::Command::new("gsettings")
                .args(["get", "org.gnome.desktop.interface", "color-scheme"])
                .output()
                .ok()?;
            if output.status.success() {
                let scheme = String::from_utf8_lossy(&output.stdout).trim().to_string();
                return Some(scheme.contains("dark"));
            }
            let output = std::process::Command::new("gsettings")
                .args(["get", "org.gnome.desktop.interface", "gtk-theme"])
                .output()
                .ok()?;
            if output.status.success() {
                let theme = String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .to_lowercase();
                return Some(theme.contains("dark"));
            }
            None
        })()
        .unwrap_or(false);

        Ok(serde_json::json!({
            "accentColor": accent,
            "isDarkMode": is_dark,
        }))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Ok(serde_json::json!({
            "accentColor": "0078D4",
            "isDarkMode": false,
        }))
    }
}

#[cfg(target_os = "macos")]
fn is_dark_mode() -> bool {
    std::process::Command::new("defaults")
        .args(["read", "-globalDomain", "AppleInterfaceStyle"])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).contains("Dark"))
        .unwrap_or(false)
}

#[tauri::command]
pub fn get_system_text_scale() -> f64 {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("reg")
            .args([
                "query",
                "HKCU\\SOFTWARE\\Microsoft\\Accessibility",
                "/v",
                "TextScaleFactor",
            ])
            .creation_flags(0x08000000)
            .output();
        if let Ok(out) = output {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for line in stdout.lines() {
                if let Some(pos) = line.find("0x") {
                    if let Ok(val) = u32::from_str_radix(line[pos + 2..].trim(), 16) {
                        return (val as f64) / 100.0;
                    }
                }
                if line.contains("REG_DWORD") {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if let Some(last) = parts.last() {
                        if let Ok(val) = last.parse::<u32>() {
                            return (val as f64) / 100.0;
                        }
                    }
                }
            }
        }
        1.0
    }

    #[cfg(target_os = "linux")]
    {
        let output = std::process::Command::new("gsettings")
            .args(["get", "org.gnome.desktop.interface", "text-scaling-factor"])
            .output();
        if let Ok(out) = output {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Ok(val) = stdout.parse::<f64>() {
                return val;
            }
        }
        if let Ok(val) = std::env::var("QT_SCALE_FACTOR") {
            if let Ok(scale) = val.parse::<f64>() {
                return scale;
            }
        }
        if let Ok(val) = std::env::var("GDK_SCALE") {
            if let Ok(scale) = val.parse::<f64>() {
                return scale;
            }
        }
        1.0
    }

    #[cfg(target_os = "macos")]
    {
        1.0
    }
}

#[tauri::command]
pub fn is_mas() -> bool {
    #[cfg(target_os = "macos")]
    {
        if cfg!(feature = "mas") {
            return true;
        }

        if std::env::var("APP_SANDBOX_CONTAINER_ID").is_ok() {
            return true;
        }

        if let Ok(exe) = std::env::current_exe() {
            for ancestor in exe.ancestors() {
                let Some(name) = ancestor.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                if !name.ends_with(".app") {
                    continue;
                }

                let receipt = ancestor
                    .join("Contents")
                    .join("_MASReceipt")
                    .join("receipt");
                if receipt.exists() {
                    return true;
                }
            }
        }

        false
    }

    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[tauri::command]
pub fn is_flatpak() -> bool {
    std::env::var("FLATPAK_ID").is_ok()
}

#[tauri::command]
pub fn is_snap() -> bool {
    std::env::var("SNAP").is_ok()
}

#[tauri::command]
pub fn is_ms_store() -> bool {
    #[cfg(target_os = "windows")]
    {
        if std::env::var("APPX_PACKAGE_FAMILY_NAME").is_ok()
            || std::env::var("PACKAGE_FAMILY_NAME").is_ok()
        {
            return true;
        }

        if let Ok(exe) = std::env::current_exe() {
            let exe_path = exe.to_string_lossy().to_ascii_lowercase();
            if exe_path.contains("\\windowsapps\\") {
                return true;
            }
        }

        false
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
pub fn is_msi() -> bool {
    #[cfg(target_os = "windows")]
    {
        let output = {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("reg")
                .args(["query", "HKCU\\Software\\IYERIS", "/v", "InstalledViaMsi"])
                .creation_flags(0x08000000)
                .output()
        };

        if let Ok(result) = output {
            if result.status.success() {
                let stdout = String::from_utf8_lossy(&result.stdout);
                return stdout.contains("InstalledViaMsi") && stdout.contains("0x1");
            }
        }
        false
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
pub fn minimize_window(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn maximize_window(window: tauri::Window) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn close_window(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_new_window(app: tauri::AppHandle) -> Result<(), String> {
    log::debug!("[System] open_new_window");
    let label = format!("window-{}", WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed));

    let builder =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
            .title("IYERIS")
            .inner_size(1200.0, 800.0)
            .min_inner_size(800.0, 500.0)
            .visible(true)
            .focused(true);

    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);

    builder.build().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn set_zoom_level(
    webview: tauri::WebviewWindow,
    zoom_level: f64,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let label = webview.label().to_string();
    webview.set_zoom(zoom_level).map_err(|e| e.to_string())?;
    if let Ok(mut z) = state.zoom_levels.lock() {
        z.insert(label, zoom_level);
    }
    Ok(())
}

#[tauri::command]
pub fn get_zoom_level(
    window: tauri::Window,
    state: tauri::State<'_, crate::AppState>,
) -> Result<f64, String> {
    let label = window.label();
    let z = state.zoom_levels.lock().map_err(|e| e.to_string())?;
    Ok(*z.get(label).unwrap_or(&1.0))
}

#[tauri::command]
pub async fn open_terminal(dir_path: String) -> Result<(), String> {
    log::debug!("[System] open_terminal: {}", dir_path);
    let path = crate::validate_existing_path(&dir_path, "Directory")?;

    #[cfg(target_os = "macos")]
    {
        let mac_terminals = ["iTerm", "Warp", "Alacritty", "kitty", "Hyper", "Terminal"];
        let preferred = std::env::var("TERM_PROGRAM")
            .unwrap_or_default()
            .to_lowercase();
        let ordered: Vec<&str> = if !preferred.is_empty() {
            let mut v: Vec<&str> = Vec::with_capacity(mac_terminals.len());
            for t in &mac_terminals {
                if preferred.contains(&t.to_lowercase()) {
                    v.insert(0, t);
                } else {
                    v.push(t);
                }
            }
            v
        } else {
            mac_terminals.to_vec()
        };

        for app_name in &ordered {
            let status = std::process::Command::new("open")
                .args(["-a", app_name, "--", path.to_str().unwrap_or(".")])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            if let Ok(s) = status {
                if s.success() {
                    return Ok(());
                }
            }
        }
        return Err("No terminal emulator found".into());
    }

    #[cfg(target_os = "windows")]
    {
        let has_wt = std::process::Command::new("where")
            .arg("wt")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

        if has_wt {
            std::process::Command::new("wt")
                .args(["-d", path.to_str().unwrap_or(".")])
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            let cd_command = format!("cd /d \"{}\"", path.display());
            std::process::Command::new("cmd")
                .args(["/c", "start", "", "cmd", "/k", &cd_command])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        let terminals: Vec<(&str, Vec<String>)> = vec![
            (
                "x-terminal-emulator",
                vec!["--working-directory".into(), dir_path.clone()],
            ),
            (
                "gnome-terminal",
                vec![format!("--working-directory={}", dir_path)],
            ),
            ("konsole", vec!["--workdir".into(), dir_path.clone()]),
            (
                "xfce4-terminal",
                vec![format!("--working-directory={}", dir_path)],
            ),
            (
                "mate-terminal",
                vec![format!("--working-directory={}", dir_path)],
            ),
            ("tilix", vec![format!("--working-directory={}", dir_path)]),
            (
                "terminator",
                vec![format!("--working-directory={}", dir_path)],
            ),
            (
                "alacritty",
                vec!["--working-directory".into(), dir_path.clone()],
            ),
            ("kitty", vec!["--directory".into(), dir_path.clone()]),
            (
                "wezterm",
                vec!["start".into(), "--cwd".into(), dir_path.clone()],
            ),
            ("foot", vec![format!("--working-directory={}", dir_path)]),
            (
                "lxterminal",
                vec![format!("--working-directory={}", dir_path)],
            ),
            ("sakura", vec![format!("--working-directory={}", dir_path)]),
            (
                "xterm",
                vec![
                    "-e".into(),
                    "sh".into(),
                    "-lc".into(),
                    format!(
                        "cd '{}' && exec \"$SHELL\"",
                        path.to_string_lossy().replace('\'', "'\\''")
                    ),
                ],
            ),
        ];

        let in_flatpak =
            std::env::var("FLATPAK_ID").is_ok() || std::path::Path::new("/.flatpak-info").exists();

        for (cmd, args) in &terminals {
            let result = if in_flatpak {
                let mut fp_args = vec!["--host".to_string(), cmd.to_string()];
                fp_args.extend(args.iter().cloned());
                std::process::Command::new("flatpak-spawn")
                    .args(&fp_args)
                    .current_dir(&path)
                    .spawn()
            } else {
                std::process::Command::new(cmd)
                    .args(args)
                    .current_dir(&path)
                    .spawn()
            };
            if result.is_ok() {
                return Ok(());
            }
        }
        return Err("No terminal emulator found".into());
    }

    #[allow(unreachable_code)]
    Ok(())
}

#[tauri::command]
pub fn is_dev_mode() -> bool {
    crate::is_dev_mode()
}

#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn relaunch_app(app: tauri::AppHandle) -> Result<(), String> {
    app.restart();
    #[allow(unreachable_code)]
    Ok(())
}

#[tauri::command]
pub fn get_licenses(app: tauri::AppHandle) -> Result<String, String> {
    fn load_license_file(
        app: &tauri::AppHandle,
        file_name: &str,
        attempted_paths: &mut Vec<String>,
    ) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
        attempted_paths.push(format!("asset:{file_name}"));
        if let Some(asset) = app.asset_resolver().get(file_name.to_string()) {
            let content = String::from_utf8(asset.bytes)
                .map_err(|e| format!("Failed to decode bundled {file_name}: {e}"))?;
            let parsed: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse bundled {file_name}: {e}"))?;
            let object = parsed
                .as_object()
                .ok_or_else(|| format!("Bundled {file_name} must be a JSON object"))?;
            return Ok(Some(object.clone()));
        }

        let candidate_suffixes = [
            file_name.to_string(),
            format!("public/{file_name}"),
            format!("dist/{file_name}"),
        ];

        if let Ok(resource_path) = app.path().resource_dir() {
            for suffix in &candidate_suffixes {
                let license_path = resource_path.join(suffix);
                attempted_paths.push(license_path.display().to_string());
                if let Ok(content) = fs::read_to_string(&license_path) {
                    let parsed: serde_json::Value =
                        serde_json::from_str(&content).map_err(|e| {
                            format!("Failed to parse {}: {}", license_path.display(), e)
                        })?;
                    let object = parsed.as_object().ok_or_else(|| {
                        format!("{} must be a JSON object", license_path.display())
                    })?;
                    return Ok(Some(object.clone()));
                }
            }
        }

        for suffix in &candidate_suffixes {
            let license_path = std::path::Path::new(suffix);
            attempted_paths.push(license_path.display().to_string());
            if let Ok(content) = fs::read_to_string(license_path) {
                let parsed: serde_json::Value = serde_json::from_str(&content)
                    .map_err(|e| format!("Failed to parse {}: {}", license_path.display(), e))?;
                let object = parsed
                    .as_object()
                    .ok_or_else(|| format!("{} must be a JSON object", license_path.display()))?;
                return Ok(Some(object.clone()));
            }
        }

        Ok(None)
    }

    let mut attempted_paths: Vec<String> = Vec::new();
    let mut merged = serde_json::Map::new();
    let mut loaded_any = false;

    for file_name in ["licenses.json", "licenses-cargo.json"] {
        if let Some(entries) = load_license_file(&app, file_name, &mut attempted_paths)? {
            loaded_any = true;
            for (key, value) in entries {
                merged.insert(key, value);
            }
        }
    }

    if !loaded_any {
        return Err(format!(
            "Failed to read licenses: no license files were found in bundled assets or known paths (tried: {})",
            attempted_paths.join(", ")
        ));
    }

    serde_json::to_string(&serde_json::Value::Object(merged))
        .map_err(|e| format!("Failed to encode merged licenses payload: {e}"))
}

#[tauri::command]
pub fn get_logs_path(app: tauri::AppHandle) -> Result<String, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    Ok(log_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn open_logs_folder(app: tauri::AppHandle) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    open::that(&log_dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_diagnostics(app: tauri::AppHandle) -> Result<String, String> {
    let settings_summary = match app.path().app_data_dir() {
        Ok(dir) => {
            let path = dir.join("settings.json");
            match fs::read_to_string(&path) {
                Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
                    Ok(mut val) => {
                        if let Some(obj) = val.as_object_mut() {
                            obj.remove("bookmarks");
                            obj.remove("tabState");
                            obj.remove("recentFiles");
                            obj.remove("searchHistory");
                            obj.remove("directoryHistory");
                        }
                        val
                    }
                    Err(_) => serde_json::json!("parse error"),
                },
                Err(_) => serde_json::json!("not found"),
            }
        }
        Err(_) => serde_json::json!("unavailable"),
    };

    let (indexer_building, indexer_entries, indexer_last_built) = crate::indexer::get_status();

    let info = serde_json::json!({
        "version": app.package_info().version.to_string(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "platform": get_platform(),
        "devMode": crate::is_dev_mode(),
        "indexer": {
            "building": indexer_building,
            "entries": indexer_entries,
            "lastBuilt": indexer_last_built,
        },
        "settings": settings_summary,
    });
    Ok(serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub fn get_log_file_content(app: tauri::AppHandle) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};

    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    let log_file = log_dir.join("iyeris.log");

    let mut file = fs::File::open(&log_file).map_err(|e| format!("Failed to read log: {}", e))?;

    const MAX_LOG_BYTES: u64 = 1_024 * 1_024;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if metadata.len() > MAX_LOG_BYTES {
        file.seek(SeekFrom::End(-(MAX_LOG_BYTES as i64)))
            .map_err(|e| e.to_string())?;
    }

    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|e| format!("Failed to read log: {}", e))?;
    Ok(content)
}

#[tauri::command]
pub async fn share_items(file_paths: Vec<String>) -> Result<(), String> {
    if file_paths.is_empty() {
        return Err("No files to share".into());
    }
    let validated_paths: Vec<std::path::PathBuf> = file_paths
        .iter()
        .map(|path| crate::validate_existing_path(path, "File"))
        .collect::<Result<Vec<_>, _>>()?;

    #[cfg(target_os = "macos")]
    {
        for path in &validated_paths {
            std::process::Command::new("open")
                .arg("-R")
                .arg(path.as_os_str())
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        for path in &validated_paths {
            let parent = path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| "/".to_string());
            let _ = open::that(&parent);
        }
    }

    #[cfg(target_os = "windows")]
    {
        for path in &validated_paths {
            std::process::Command::new("explorer")
                .arg("/select,")
                .arg(path.as_os_str())
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn check_full_disk_access() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let test_paths = vec![format!(
            "{}/Library/Application Support/com.apple.TCC/TCC.db",
            std::env::var("HOME").unwrap_or_default()
        )];
        for path in test_paths {
            if fs::metadata(&path).is_ok() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

#[tauri::command]
pub async fn request_full_disk_access() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        open::that("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_open_with_apps(file_path: String) -> Result<Vec<serde_json::Value>, String> {
    #[cfg(target_os = "macos")]
    {
        let path = crate::validate_existing_path(&file_path, "File")?;
        let output = tokio::task::spawn_blocking(move || {
            let jxa_code = r#"ObjC.import('AppKit');
ObjC.import('Foundation');
const env = $.NSProcessInfo.processInfo.environment;
const filePath = ObjC.unwrap(env.objectForKey('FILE_PATH'));
const fileUrl = $.NSURL.fileURLWithPath(filePath);
const apps = $.NSWorkspace.sharedWorkspace.urlsForApplicationsToOpenURL(fileUrl);
const fm = $.NSFileManager.defaultManager;
const result = [];
for (let i = 0; i < apps.count; i++) {
  const appUrl = apps.objectAtIndex(i);
  const appPath = ObjC.unwrap(appUrl.path);
  const displayName = ObjC.unwrap(fm.displayNameAtPath(appPath));
  result.push({ id: appPath, name: displayName });
}
JSON.stringify(result);"#;
            let jxa_output = std::process::Command::new("osascript")
                .args(["-l", "JavaScript", "-e", jxa_code])
                .env("FILE_PATH", path.to_string_lossy().as_ref())
                .output();
            if let Ok(output) = jxa_output {
                if output.status.success() {
                    return Ok(output);
                }
            }

            let swift_code = r#"import AppKit; import Foundation;
let url = URL(fileURLWithPath: ProcessInfo.processInfo.environment["FILE_PATH"]!);
let apps = NSWorkspace.shared.urlsForApplications(toOpen: url);
var result: [[String: String]] = [];
for app in apps {
    let name = FileManager.default.displayName(atPath: app.path);
    result.append(["id": app.path, "name": name]);
}
let data = try! JSONSerialization.data(withJSONObject: result);
print(String(data: data, encoding: .utf8)!)"#;
            std::process::Command::new("swift")
                .args(["-e", swift_code])
                .env("FILE_PATH", path.to_string_lossy().as_ref())
                .output()
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Ok(apps) = serde_json::from_str::<Vec<serde_json::Value>>(&stdout) {
                if !apps.is_empty() {
                    return Ok(apps);
                }
            }
        }
        let fallback_apps: Vec<(&str, &str)> = vec![
            ("/System/Applications/TextEdit.app", "TextEdit"),
            ("/System/Applications/Preview.app", "Preview"),
            ("/Applications/Safari.app", "Safari"),
            ("/System/Applications/Utilities/Terminal.app", "Terminal"),
            (
                "/System/Applications/QuickTime Player.app",
                "QuickTime Player",
            ),
        ];
        let available: Vec<serde_json::Value> = fallback_apps
            .into_iter()
            .filter(|(path, _)| std::path::Path::new(path).exists())
            .map(|(id, name)| serde_json::json!({ "id": id, "name": name }))
            .collect();
        Ok(available)
    }

    #[cfg(target_os = "windows")]
    {
        let path = crate::validate_existing_path(&file_path, "File")?;
        let apps = collect_windows_open_with_apps(&path);
        Ok(apps
            .into_iter()
            .map(|(id, name)| serde_json::json!({ "id": id, "name": name }))
            .collect())
    }

    #[cfg(target_os = "linux")]
    {
        let path = crate::validate_existing_path(&file_path, "File")?;
        let apps = collect_linux_open_with_apps(&path);

        Ok(apps
            .into_iter()
            .map(|(id, name)| serde_json::json!({ "id": id, "name": name }))
            .collect())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = file_path;
        Ok(vec![
            serde_json::json!({ "id": "default", "name": "Default Application" }),
        ])
    }
}

#[tauri::command]
pub async fn open_file_with_app(file_path: String, app_id: String) -> Result<(), String> {
    log::debug!("[System] open_file_with_app: {} with {}", file_path, app_id);
    #[cfg(target_os = "macos")]
    {
        let path = crate::validate_existing_path(&file_path, "File")?;
        if app_id.trim().is_empty() || app_id == "default" {
            return open::that(&path).map_err(|e| e.to_string());
        }
        let app_path = crate::validate_existing_path(&app_id, "Application")?;
        let is_app_bundle = app_path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("app"))
            .unwrap_or(false);
        if !is_app_bundle {
            return Err("Selected application must be a .app bundle.".to_string());
        }
        std::process::Command::new("open")
            .arg("-a")
            .arg(app_path.as_os_str())
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let path = crate::validate_existing_path(&file_path, "File")?;
        if app_id.is_empty() || app_id == "default" {
            return open::that(&path).map_err(|e| e.to_string());
        }

        let allowed_apps = collect_windows_open_with_apps(&path);
        if !allowed_apps
            .iter()
            .any(|(allowed_id, _)| allowed_id.eq_ignore_ascii_case(&app_id))
        {
            return Err("Selected application is not allowed for this file type.".to_string());
        }

        Command::new(&app_id)
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let path = crate::validate_existing_path(&file_path, "File")?;
        if app_id.is_empty() || app_id == "default" {
            return open::that(&path).map_err(|e| e.to_string());
        }

        let allowed_apps = collect_linux_open_with_apps(&path);
        if !allowed_apps
            .iter()
            .any(|(allowed_id, _)| allowed_id == &app_id)
        {
            return Err("Selected application is not allowed for this file type.".to_string());
        }

        if app_id.ends_with(".desktop") {
            if let Some((_name, exec_line)) = load_desktop_entry(&app_id) {
                if let Some((command, args)) =
                    build_linux_exec_invocation(&exec_line, Some(path.to_string_lossy().as_ref()))
                {
                    Command::new(command)
                        .args(args)
                        .spawn()
                        .map_err(|e| e.to_string())?;
                    return Ok(());
                }
            }
            return Err("Failed to launch selected desktop application.".to_string());
        }

        Err("Only .desktop launchers are supported on Linux.".to_string())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = app_id;
        open::that(&file_path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn launch_desktop_entry(file_path: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let path = crate::validate_existing_path(&file_path, "Desktop entry")?;
        if path.extension().and_then(|ext| ext.to_str()) != Some("desktop") {
            return Err("Selected file is not a .desktop entry.".to_string());
        }
        if !is_trusted_desktop_entry_path(&path) {
            return Err(
                "Only desktop entries from trusted application directories can be launched."
                    .to_string(),
            );
        }

        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read desktop entry: {}", e))?;

        let exec_line = content
            .lines()
            .find(|line| line.starts_with("Exec="))
            .ok_or("Desktop entry is missing an Exec field.")?;

        let exec_line = exec_line.trim_start_matches("Exec=").trim();
        let Some((command, args)) = build_linux_exec_invocation(exec_line, None) else {
            return Err("Desktop entry command is empty.".to_string());
        };

        Command::new(command)
            .args(args)
            .spawn()
            .map_err(|e| format!("Failed to launch desktop entry: {}", e))?;
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = file_path;
        Err("Desktop entry launch is only supported on Linux.".to_string())
    }
}

fn app_exe_string() -> Result<String, String> {
    std::env::current_exe()
        .map_err(|e| e.to_string())
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_native_integration_status() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let installed = Command::new("reg")
            .args(["query", r"HKCU\Software\Classes\Directory\shell\IYERIS"])
            .creation_flags(0x08000000)
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
        return Ok(serde_json::json!({
            "supported": true,
            "installed": installed,
            "message": if installed { "Windows context menu entries installed" } else { "Windows context menu entries not installed" },
        }));
    }

    #[cfg(target_os = "macos")]
    {
        let installed = std::env::var("HOME")
            .ok()
            .map(|home| {
                Path::new(&home)
                    .join("Library/Services/Open in IYERIS.workflow")
                    .exists()
            })
            .unwrap_or(false);
        return Ok(serde_json::json!({
            "supported": true,
            "installed": installed,
            "message": if installed { "Finder service installed" } else { "Finder service not installed" },
        }));
    }

    #[cfg(target_os = "linux")]
    {
        let installed = std::env::var("HOME")
            .ok()
            .map(|home| {
                Path::new(&home)
                    .join(".local/share/kio/servicemenus/iyeris-open.desktop")
                    .exists()
                    || Path::new(&home)
                        .join(".local/share/nautilus/scripts/Open in IYERIS")
                        .exists()
            })
            .unwrap_or(false);
        return Ok(serde_json::json!({
            "supported": true,
            "installed": installed,
            "message": if installed { "Linux file manager entries installed" } else { "Linux file manager entries not installed" },
        }));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Ok(serde_json::json!({
        "supported": false,
        "installed": false,
        "message": "Native integration is not supported on this platform",
    }))
}

#[tauri::command]
pub async fn install_native_integration() -> Result<(), String> {
    let exe = app_exe_string()?;

    #[cfg(target_os = "windows")]
    {
        let command = format!("\"{}\" \"%1\"", exe.replace('\\', "\\\\"));
        let pairs = [
            (r"HKCU\Software\Classes\*\shell\IYERIS", "Open in IYERIS"),
            (
                r"HKCU\Software\Classes\Directory\shell\IYERIS",
                "Open in IYERIS",
            ),
        ];
        for (key, label) in pairs {
            Command::new("reg")
                .args(["add", key, "/ve", "/d", label, "/f"])
                .creation_flags(0x08000000)
                .status()
                .map_err(|e| e.to_string())?;
            Command::new("reg")
                .args([
                    "add",
                    &format!(r"{}\command", key),
                    "/ve",
                    "/d",
                    &command,
                    "/f",
                ])
                .creation_flags(0x08000000)
                .status()
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
        let workflow = Path::new(&home).join("Library/Services/Open in IYERIS.workflow/Contents");
        fs::create_dir_all(&workflow).map_err(|e| e.to_string())?;
        fs::write(
            workflow.join("Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>NSServices</key><array><dict><key>NSMenuItem</key><dict><key>default</key><string>Open in IYERIS</string></dict><key>NSMessage</key><string>runWorkflowAsService</string><key>NSSendFileTypes</key><array><string>public.item</string></array></dict></array></dict></plist>"#,
        )
        .map_err(|e| e.to_string())?;
        fs::write(
            workflow.join("document.wflow"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>actions</key><array><dict><key>action</key><dict><key>AMAccepts</key><dict><key>Container</key><string>List</string><key>Types</key><array><string>com.apple.cocoa.path</string></array></dict><key>AMActionVersion</key><string>2.0.3</string><key>AMApplication</key><array><string>Automator</string></array><key>AMParameterProperties</key><dict><key>COMMAND_STRING</key><dict><key>default value</key><string>while IFS= read -r item; do "{}" "$item"; done</string></dict></dict><key>AMProvides</key><dict><key>Container</key><string>List</string><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict><key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string><key>ActionName</key><string>Run Shell Script</string><key>ActionParameters</key><dict><key>COMMAND_STRING</key><string>while IFS= read -r item; do "{}" "$item"; done</string><key>inputMethod</key><integer>1</integer><key>shell</key><string>/bin/zsh</string></dict><key>BundleIdentifier</key><string>com.apple.RunShellScript</string></dict></dict></array></dict></plist>"#,
                exe, exe
            ),
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
        let service_dir = Path::new(&home).join(".local/share/kio/servicemenus");
        fs::create_dir_all(&service_dir).map_err(|e| e.to_string())?;
        fs::write(
            service_dir.join("iyeris-open.desktop"),
            format!(
                "[Desktop Entry]\nType=Service\nMimeType=all/all;inode/directory;\nActions=openInIyeris;openParentInIyeris;\nX-KDE-ServiceTypes=KonqPopupMenu/Plugin\n\n[Desktop Action openInIyeris]\nName=Open in IYERIS\nExec=\"{}\" %f\n\n[Desktop Action openParentInIyeris]\nName=Open Parent in IYERIS\nExec=sh -c '\"{}\" \"$(dirname \"$1\")\"' -- %f\n",
                exe, exe
            ),
        )
        .map_err(|e| e.to_string())?;

        let nautilus_dir = Path::new(&home).join(".local/share/nautilus/scripts");
        fs::create_dir_all(&nautilus_dir).map_err(|e| e.to_string())?;
        let script = nautilus_dir.join("Open in IYERIS");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$NAUTILUS_SCRIPT_SELECTED_FILE_PATHS\" | while IFS= read -r item; do [ -n \"$item\" ] && \"{}\" \"$item\"; done\n",
                exe
            ),
        )
        .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = exe;
        Err("Native integration is not supported on this platform".to_string())
    }
}

#[tauri::command]
pub async fn uninstall_native_integration() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        for key in [
            r"HKCU\Software\Classes\*\shell\IYERIS",
            r"HKCU\Software\Classes\Directory\shell\IYERIS",
        ] {
            let _ = Command::new("reg")
                .args(["delete", key, "/f"])
                .creation_flags(0x08000000)
                .status();
        }
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            let _ = fs::remove_dir_all(
                Path::new(&home).join("Library/Services/Open in IYERIS.workflow"),
            );
        }
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(home) = std::env::var("HOME") {
            let _ = fs::remove_file(
                Path::new(&home).join(".local/share/kio/servicemenus/iyeris-open.desktop"),
            );
            let _ = fs::remove_file(
                Path::new(&home).join(".local/share/nautilus/scripts/Open in IYERIS"),
            );
        }
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err("Native integration is not supported on this platform".to_string())
}

pub fn has_other_visible_windows(app: &tauri::AppHandle, exclude_label: &str) -> bool {
    app.webview_windows()
        .iter()
        .any(|(label, w)| label != exclude_label && w.is_visible().unwrap_or(false))
}

pub fn should_minimize_to_tray(app: &tauri::AppHandle) -> bool {
    if !TRAY_READY.load(Ordering::Relaxed) {
        return false;
    }

    let dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return false,
    };
    let path = dir.join("settings.json");
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return false,
    };
    json.get("minimizeToTray")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    manager.is_enabled().map_err(|e| e.to_string())
}

pub fn setup_tray(
    app: &mut tauri::App,
) -> Result<tauri::tray::TrayIcon, Box<dyn std::error::Error>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItemBuilder::with_id("show", "Show IYERIS").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

    #[cfg(target_os = "macos")]
    let icon_bytes = include_bytes!("../icons/icon-tray-Template.png");
    #[cfg(not(target_os = "macos"))]
    let icon_bytes = include_bytes!("../icons/icon.png");
    let icon = tauri::image::Image::from_bytes(icon_bytes)?;

    let tray_builder = TrayIconBuilder::new().icon(icon);
    #[cfg(target_os = "macos")]
    let tray_builder = tray_builder.icon_as_template(true);
    #[cfg(not(target_os = "linux"))]
    let tray_builder = tray_builder.show_menu_on_left_click(false);
    let tray = tray_builder
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                #[cfg(target_os = "macos")]
                {
                    let _ = app.set_dock_visibility(true);
                    let _ = app.show();
                }
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                } else {
                    let windows = app.webview_windows();
                    let target = windows
                        .values()
                        .find(|w| w.is_visible().unwrap_or(false))
                        .or_else(|| windows.values().next());
                    if let Some(w) = target {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let windows = app.webview_windows();
                let visible_windows: Vec<_> = windows
                    .values()
                    .filter(|w| w.is_visible().unwrap_or(false))
                    .collect();

                if !visible_windows.is_empty() {
                    let any_focused = visible_windows
                        .iter()
                        .any(|w| w.is_focused().unwrap_or(false));
                    if any_focused || was_recently_focused() {
                        #[cfg(target_os = "macos")]
                        {
                            let _ = app.hide();
                            let _ = app.set_dock_visibility(false);
                        }
                        for w in &visible_windows {
                            let _ = w.hide();
                        }
                    } else {
                        for w in &visible_windows {
                            let _ = w.set_focus();
                        }
                    }
                } else {
                    #[cfg(target_os = "macos")]
                    {
                        let _ = app.set_dock_visibility(true);
                        let _ = app.show();
                    }
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    } else if let Some(w) = windows.values().next() {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    TRAY_READY.store(true, Ordering::Relaxed);
    Ok(tray)
}

#[cfg(target_os = "linux")]
use std::collections::HashSet;
use std::fs;
use std::io::Read;
#[cfg(not(target_os = "windows"))]
use std::io::Write;
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
#[cfg(target_os = "linux")]
const MAX_DESKTOP_ENTRY_BYTES: u64 = 512 * 1024;
#[cfg(target_os = "linux")]
const MAX_MIME_CACHE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LICENSE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SETTINGS_SUMMARY_BYTES: u64 = 8 * 1024 * 1024;
const MAX_DIAGNOSTICS_BYTES: u64 = 1024 * 1024;
const MAX_SHARED_ITEMS: usize = 10_000;
const MAX_SHARED_PATH_BYTES: usize = 8 * 1024 * 1024;
#[cfg(any(target_os = "windows", target_os = "linux", test))]
const MIN_SYSTEM_TEXT_SCALE: f64 = 0.5;
#[cfg(any(target_os = "windows", target_os = "linux", test))]
const MAX_SYSTEM_TEXT_SCALE: f64 = 3.0;

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn sanitize_system_text_scale(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(MIN_SYSTEM_TEXT_SCALE, MAX_SYSTEM_TEXT_SCALE)
    } else {
        1.0
    }
}

fn open_regular_read(path: &Path) -> Result<fs::File, String> {
    crate::file_operations::open_regular_read(path)
}

fn read_text_limited(path: &Path, max_bytes: u64) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Refusing to read a non-regular text file".to_string());
    }
    if metadata.len() > max_bytes {
        return Err(format!("Text file exceeds {} byte limit", max_bytes));
    }
    let file = open_regular_read(path)?;
    let mut bytes = Vec::with_capacity(metadata.len().min(max_bytes) as usize);
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("Text file exceeds {} byte limit", max_bytes));
    }
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

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
fn is_valid_windows_extension(value: &str) -> bool {
    value.starts_with('.')
        && value.len() > 1
        && value[1..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[cfg(target_os = "linux")]
fn tokenize_exec_command(command: &str) -> Vec<String> {
    if let Ok(parsed) = shell_words::split(command) {
        if !parsed.is_empty() {
            return parsed;
        }
    }
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
        PathBuf::from("/var/lib/snapd/desktop/applications"),
        PathBuf::from("/snap/share/applications"),
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
        let Ok(content) = read_text_limited(&full_path, MAX_DESKTOP_ENTRY_BYTES) else {
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
        let Ok(content) = read_text_limited(&cache_file, MAX_MIME_CACHE_BYTES) else {
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

    let mime_lookup = Command::new("xdg-mime")
        .args(["query", "filetype", &path.to_string_lossy()])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            Command::new("file")
                .args(["--mime-type", "-b", &path.to_string_lossy()])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
        });

    if let Some(mime_type) = mime_lookup {
        {
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
    if let Some(executable) = crate::native_windows::associated_executable(&ext) {
        let name = Path::new(&executable)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Default Application")
            .to_string();
        apps.push((executable, name));
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
pub async fn get_system_accent_color() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(get_system_accent_color_sync)
        .await
        .map_err(|error| error.to_string())?
}

fn get_system_accent_color_sync() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(serde_json::json!({
            "accentColor": "007AFF",
            "isDarkMode": is_dark_mode(),
        }))
    }

    #[cfg(target_os = "windows")]
    {
        let accent = crate::native_windows::read_user_dword(
            r"SOFTWARE\Microsoft\Windows\DWM",
            "ColorizationColor",
        )
        .map(|value| {
            let r = (value >> 16) & 0xFF;
            let g = (value >> 8) & 0xFF;
            let b = value & 0xFF;
            format!("{r:02X}{g:02X}{b:02X}")
        })
        .unwrap_or_else(|| "0078D4".into());

        let is_dark = crate::native_windows::read_user_dword(
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "AppsUseLightTheme",
        )
        .is_some_and(|value| value == 0);

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
    crate::native_macos::is_dark_mode()
}

#[tauri::command]
pub async fn get_system_text_scale() -> f64 {
    tokio::task::spawn_blocking(get_system_text_scale_sync)
        .await
        .unwrap_or(1.0)
}

fn get_system_text_scale_sync() -> f64 {
    #[cfg(target_os = "windows")]
    {
        crate::native_windows::read_user_dword(
            r"SOFTWARE\Microsoft\Accessibility",
            "TextScaleFactor",
        )
        .map(|value| sanitize_system_text_scale(value as f64 / 100.0))
        .unwrap_or(1.0)
    }

    #[cfg(target_os = "linux")]
    {
        let output = std::process::Command::new("gsettings")
            .args(["get", "org.gnome.desktop.interface", "text-scaling-factor"])
            .output();
        if let Ok(out) = output {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Ok(val) = stdout.parse::<f64>() {
                return sanitize_system_text_scale(val);
            }
        }
        if let Ok(val) = std::env::var("QT_SCALE_FACTOR") {
            if let Ok(scale) = val.parse::<f64>() {
                return sanitize_system_text_scale(scale);
            }
        }
        if let Ok(val) = std::env::var("GDK_SCALE") {
            if let Ok(scale) = val.parse::<f64>() {
                return sanitize_system_text_scale(scale);
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
        crate::native_windows::read_user_dword(r"Software\IYERIS", "InstalledViaMsi") == Some(1)
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
    if !zoom_level.is_finite() || !(0.5..=2.0).contains(&zoom_level) {
        return Err("Zoom level must be finite and between 0.5 and 2.0".to_string());
    }
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
    tokio::task::spawn_blocking(move || open_terminal_sync(dir_path))
        .await
        .map_err(|e| e.to_string())?
}

fn open_terminal_sync(dir_path: String) -> Result<(), String> {
    log::debug!("[System] open_terminal: {}", dir_path);
    let path = crate::validate_existing_path(&dir_path, "Directory")?;

    #[cfg(target_os = "macos")]
    {
        return crate::native_macos::open_terminal(&path);
    }

    #[cfg(target_os = "windows")]
    {
        let terminal = std::process::Command::new("wt")
            .args(["-d", path.to_str().unwrap_or(".")])
            .spawn();
        if terminal.is_err() {
            // Pass the path via current_dir so it is never embedded in a shell
            // command string — avoids %VAR% expansion in folder names. (W1)
            use std::os::windows::process::CommandExt;
            let command_processor = std::env::var_os("ComSpec")
                .filter(|value| std::path::Path::new(value).is_absolute())
                .unwrap_or_else(|| std::ffi::OsString::from(r"C:\Windows\System32\cmd.exe"));
            std::process::Command::new(command_processor)
                .current_dir(&path)
                .creation_flags(0x00000010) // CREATE_NEW_CONSOLE
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
            // xterm inherits the working directory and starts the user's shell.
            // No shell command string is needed.
            ("xterm", vec![]),
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
pub async fn get_licenses(app: tauri::AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || get_licenses_sync(app))
        .await
        .map_err(|error| error.to_string())?
}

fn get_licenses_sync(app: tauri::AppHandle) -> Result<String, String> {
    fn load_license_file(
        app: &tauri::AppHandle,
        file_name: &str,
        attempted_paths: &mut Vec<String>,
    ) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
        attempted_paths.push(format!("asset:{file_name}"));
        if let Some(asset) = app.asset_resolver().get(file_name.to_string()) {
            if asset.bytes.len() as u64 > MAX_LICENSE_BYTES {
                return Err(format!(
                    "Bundled {file_name} exceeds {} byte limit",
                    MAX_LICENSE_BYTES
                ));
            }
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
                if let Ok(content) = read_text_limited(&license_path, MAX_LICENSE_BYTES) {
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
            if let Ok(content) = read_text_limited(license_path, MAX_LICENSE_BYTES) {
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
pub async fn open_logs_folder(app: tauri::AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || open_logs_folder_sync(app))
        .await
        .map_err(|error| error.to_string())?
}

fn open_logs_folder_sync(app: tauri::AppHandle) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    #[cfg(target_os = "macos")]
    return crate::native_macos::open_path(&log_dir);

    #[cfg(target_os = "windows")]
    return crate::native_windows::open_path(&log_dir);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    open::that(&log_dir).map_err(|e| e.to_string())
}

fn diagnostics_settings_allowlist(raw: &serde_json::Value) -> serde_json::Value {
    const BOOLEAN_FLAGS: &[&str] = &[
        "useSystemTheme",
        "showDangerousOptions",
        "showHiddenFiles",
        "enableSearchHistory",
        "enableIndexer",
        "minimizeToTray",
        "startOnLogin",
        "autoCheckUpdates",
        "showRecentFiles",
        "showFolderTree",
        "useLegacyTreeSpacing",
        "enableTabs",
        "globalContentSearch",
        "globalClipboard",
        "enableSyntaxHighlighting",
        "enableGitStatus",
        "gitIncludeUntracked",
        "showFileHoverCard",
        "showFileCheckboxes",
        "reduceMotion",
        "highContrast",
        "largeText",
        "boldText",
        "visibleFocus",
        "reduceTransparency",
        "liquidGlassMode",
        "themedIcons",
        "disableHardwareAcceleration",
        "useSystemFontSize",
        "confirmFileOperations",
        "autoPlayVideos",
        "compactFileInfo",
        "showFileExtensions",
        "dualPaneEnabled",
        "nativeMenuEnabled",
        "operationPanelCollapsed",
        "utilityDrawerCollapsed",
        "enableAutoChecksum",
    ];
    const LIMITS: &[&str] = &[
        "maxThumbnailSizeMB",
        "maxPreviewSizeMB",
        "maxSearchHistoryItems",
        "maxDirectoryHistoryItems",
        "iconSize",
        "navTransitionDuration",
        "operationAnimationDuration",
    ];

    let mut safe = serde_json::Map::new();
    let Some(settings) = raw.as_object() else {
        return serde_json::Value::Object(safe);
    };
    let theme = [
        "dark",
        "light",
        "default",
        "custom",
        "nord",
        "catppuccin",
        "dracula",
        "solarized",
        "github",
    ];
    let view_modes = ["grid", "list", "column"];
    for (key, allowed) in [("theme", &theme[..]), ("viewMode", &view_modes[..])] {
        if let Some(value) = settings
            .get(key)
            .filter(|value| value.as_str().is_some_and(|item| allowed.contains(&item)))
        {
            safe.insert(key.to_string(), value.clone());
        }
    }
    for key in BOOLEAN_FLAGS {
        if let Some(value) = settings.get(*key).filter(|value| value.is_boolean()) {
            safe.insert((*key).to_string(), value.clone());
        }
    }
    for key in LIMITS {
        if let Some(value) = settings
            .get(*key)
            .filter(|value| value.as_u64().is_some() || value.as_i64().is_some())
        {
            safe.insert((*key).to_string(), value.clone());
        }
    }
    serde_json::Value::Object(safe)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExportResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

fn diagnostics_export_result(path: Option<std::path::PathBuf>) -> DiagnosticsExportResult {
    match path {
        Some(path) => DiagnosticsExportResult {
            status: "saved".to_string(),
            path: Some(path.to_string_lossy().to_string()),
        },
        None => DiagnosticsExportResult {
            status: "cancelled".to_string(),
            path: None,
        },
    }
}

fn write_diagnostics_file(path: &Path, content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_DIAGNOSTICS_BYTES {
        return Err("Diagnostics file exceeds size limit".to_string());
    }
    serde_json::from_str::<serde_json::Value>(content)
        .map_err(|_| "Diagnostics payload is not valid JSON".to_string())?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("Refusing to overwrite a symbolic-link diagnostics path".to_string());
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err("Diagnostics path is not a regular file".to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Cannot inspect selected diagnostics destination".to_string()),
    }

    let (temp_path, mut file) = crate::create_secure_temp_file(path, "diagnostics")
        .map_err(|_| "Cannot prepare selected diagnostics destination".to_string())?;
    let write_result = (|| -> Result<(), String> {
        use std::io::Write;
        file.write_all(content.as_bytes())
            .map_err(|_| "Cannot write diagnostics file".to_string())?;
        file.sync_all()
            .map_err(|_| "Cannot flush diagnostics file".to_string())?;
        Ok(())
    })();
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600));
    }

    crate::atomic_replace_file(&temp_path, path).inspect_err(|_| {
        let _ = fs::remove_file(&temp_path);
    })
}

fn export_diagnostics_content(app: &tauri::AppHandle) -> Result<String, String> {
    let settings_summary = match app.path().app_data_dir() {
        Ok(dir) => {
            let path = dir.join("settings.json");
            match read_text_limited(&path, MAX_SETTINGS_SUMMARY_BYTES) {
                Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
                    Ok(value) => diagnostics_settings_allowlist(&value),
                    Err(_) => serde_json::json!({}),
                },
                Err(_) => serde_json::json!({}),
            }
        }
        Err(_) => serde_json::json!({}),
    };

    let (indexer_building, indexer_entries, indexer_last_built, _indexer_metadata) =
        crate::indexer::get_status();

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
    let content =
        serde_json::to_string_pretty(&info).map_err(|_| "Cannot encode diagnostics".to_string())?;
    if content.len() as u64 > MAX_DIAGNOSTICS_BYTES {
        return Err("Diagnostics file exceeds size limit".to_string());
    }
    Ok(content)
}

#[tauri::command]
pub async fn export_diagnostics(app: tauri::AppHandle) -> Result<DiagnosticsExportResult, String> {
    tokio::task::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;

        let content = export_diagnostics_content(&app)?;
        let selected = app
            .dialog()
            .file()
            .set_file_name("iyeris-diagnostics.json")
            .add_filter("JSON", &["json"])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(diagnostics_export_result(None));
        };
        let path = selected
            .into_path()
            .map_err(|_| "Selected diagnostics destination is invalid".to_string())?;
        write_diagnostics_file(&path, &content)?;
        Ok(diagnostics_export_result(Some(path)))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn get_log_file_content(app: tauri::AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || get_log_file_content_sync(app))
        .await
        .map_err(|error| error.to_string())?
}

fn get_log_file_content_sync(app: tauri::AppHandle) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};

    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    let log_file = log_dir.join("iyeris.log");

    let metadata =
        fs::symlink_metadata(&log_file).map_err(|e| format!("Failed to read log: {}", e))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Refusing to read an unsafe log path".to_string());
    }
    let mut file =
        open_regular_read(&log_file).map_err(|e| format!("Failed to read log: {}", e))?;

    const MAX_LOG_BYTES: u64 = 1_024 * 1_024;
    // Derive the tail offset from the opened handle, not the pre-open lstat;
    // otherwise a replacement race could turn a previously small log into an
    // unbounded read.
    let opened_len = file.metadata().map_err(|e| e.to_string())?.len();
    if opened_len > MAX_LOG_BYTES {
        file.seek(SeekFrom::End(-(MAX_LOG_BYTES as i64)))
            .map_err(|e| e.to_string())?;
    }

    let mut content = String::new();
    file.take(MAX_LOG_BYTES.saturating_add(1))
        .read_to_string(&mut content)
        .map_err(|e| format!("Failed to read log: {}", e))?;
    if content.len() as u64 > MAX_LOG_BYTES {
        return Err("Log file exceeds the read limit".to_string());
    }
    Ok(content)
}

#[tauri::command]
pub async fn share_items(file_paths: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || share_items_sync(file_paths))
        .await
        .map_err(|error| error.to_string())?
}

fn share_items_sync(file_paths: Vec<String>) -> Result<(), String> {
    if file_paths.is_empty() {
        return Err("No files to share".into());
    }
    if file_paths.len() > MAX_SHARED_ITEMS {
        return Err(format!(
            "Too many files to share (max {})",
            MAX_SHARED_ITEMS
        ));
    }
    if file_paths.iter().map(String::len).sum::<usize>() > MAX_SHARED_PATH_BYTES {
        return Err(format!(
            "Shared paths exceed aggregate size limit (max {} bytes)",
            MAX_SHARED_PATH_BYTES
        ));
    }
    let validated_paths: Vec<std::path::PathBuf> = file_paths
        .iter()
        .map(|path| crate::validate_existing_path(path, "File"))
        .collect::<Result<Vec<_>, _>>()?;

    #[cfg(target_os = "macos")]
    {
        crate::native_macos::reveal_items(&validated_paths)?;
    }

    #[cfg(target_os = "linux")]
    {
        let mut opened_parents = HashSet::new();
        for path in &validated_paths {
            let parent = path
                .parent()
                .unwrap_or_else(|| Path::new("/"))
                .to_path_buf();
            if opened_parents.insert(parent.clone()) {
                let _ = open::that(&parent);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        crate::native_windows::reveal_items(&validated_paths)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn check_full_disk_access() -> Result<bool, String> {
    tokio::task::spawn_blocking(check_full_disk_access_sync)
        .await
        .map_err(|error| error.to_string())?
}

fn check_full_disk_access_sync() -> Result<bool, String> {
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
    tokio::task::spawn_blocking(request_full_disk_access_sync)
        .await
        .map_err(|error| error.to_string())?
}

fn request_full_disk_access_sync() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::native_macos::open_url(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
        )?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_open_with_apps(file_path: String) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || get_open_with_apps_sync(file_path))
        .await
        .map_err(|e| e.to_string())?
}

fn get_open_with_apps_sync(file_path: String) -> Result<Vec<serde_json::Value>, String> {
    #[cfg(target_os = "macos")]
    {
        let path = crate::validate_existing_path(&file_path, "File")?;
        Ok(crate::native_macos::applications_for_path(&path)
            .into_iter()
            .map(|(id, name)| serde_json::json!({ "id": id, "name": name }))
            .collect())
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
    tokio::task::spawn_blocking(move || open_file_with_app_sync(file_path, app_id))
        .await
        .map_err(|e| e.to_string())?
}

fn open_file_with_app_sync(file_path: String, app_id: String) -> Result<(), String> {
    log::debug!("[System] open_file_with_app: {} with {}", file_path, app_id);
    #[cfg(target_os = "macos")]
    {
        let path = crate::validate_existing_path(&file_path, "File")?;
        if app_id.trim().is_empty() || app_id == "default" {
            return crate::native_macos::open_path(&path);
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
        // M9: require the .app bundle to live under a trusted root. Without
        // this, a planted /tmp/Evil.app could be picked from the "Open with"
        // dialog and launched. macOS launch services normally surface only
        // apps in these locations; this just enforces it.
        let canonical_app = app_path
            .canonicalize()
            .map_err(|e| format!("Cannot resolve application path: {}", e))?;
        let canonical_str = canonical_app.to_string_lossy();
        let home = std::env::var("HOME").unwrap_or_default();
        let allowed_roots: Vec<String> = vec![
            "/Applications/".to_string(),
            "/System/Applications/".to_string(),
            "/System/Library/CoreServices/".to_string(),
            format!("{}/Applications/", home),
        ];
        if !allowed_roots
            .iter()
            .any(|root| canonical_str.starts_with(root))
        {
            return Err(
                "Selected application must live under /Applications, /System/Applications, /System/Library/CoreServices, or ~/Applications."
                    .to_string(),
            );
        }
        crate::native_macos::open_path_with_app(&path, &canonical_app)
    }

    #[cfg(target_os = "windows")]
    {
        let path = crate::validate_existing_path(&file_path, "File")?;
        if app_id.is_empty() || app_id == "default" {
            return crate::native_windows::open_path(&path);
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
    tokio::task::spawn_blocking(move || launch_desktop_entry_sync(file_path))
        .await
        .map_err(|e| e.to_string())?
}

fn launch_desktop_entry_sync(file_path: String) -> Result<(), String> {
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

        let content = read_text_limited(&path, MAX_DESKTOP_ENTRY_BYTES)
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

#[cfg(not(target_os = "windows"))]
fn write_native_integration_file(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Native integration file has no parent directory".to_string())?;
    crate::ensure_real_directory_tree(parent, "Native integration directory")?;
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!(
                "Refusing to overwrite unsafe native integration path: {}",
                path.display()
            ));
        }
    }
    let (temporary, mut file) = crate::create_secure_temp_file(path, "integration")?;
    let write_result = (|| -> Result<(), String> {
        file.write_all(content).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    crate::atomic_replace_file(&temporary, path).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })
}

/// H1: reject the current exe path for native-integration installation if it
/// contains shell metacharacters, quote, or escape characters. The macOS and Linux
/// installations write the path into shell-backed integration templates, and a
/// path containing `"`, `$`, `\\`, etc. would either break the template or
/// (worse) make the registered entry a shell-injection primitive that fires
/// on every right-click. Today the install path is a vendor-controlled
/// .app / .exe / AppImage and never contains these characters, but if a
/// future Tauri release ever generates one with weird path encoding we want
/// to refuse rather than silently writing a broken/exploitable workflow.
#[cfg(not(target_os = "windows"))]
fn validate_native_integration_exe_path(exe: &str) -> Result<(), String> {
    for ch in exe.chars() {
        if matches!(
            ch,
            '\'' | '"' | '\\' | '$' | '`' | ';' | '|' | '&' | '<' | '>' | '%' | '\n' | '\r' | '\0'
        ) {
            return Err(format!(
                "Refusing to install native integration: exe path contains shell metacharacter {:?}",
                ch
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn get_native_integration_status() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let installed =
            crate::native_windows::user_key_exists(r"Software\Classes\Directory\shell\IYERIS");
        Ok(serde_json::json!({
            "supported": true,
            "installed": installed,
            "message": if installed { "Windows context menu entries installed" } else { "Windows context menu entries not installed" },
        }))
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
        Ok(serde_json::json!({
            "supported": true,
            "installed": installed,
            "message": if installed { "Finder service installed" } else { "Finder service not installed" },
        }))
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
        Ok(serde_json::json!({
            "supported": true,
            "installed": installed,
            "message": if installed { "Linux file manager entries installed" } else { "Linux file manager entries not installed" },
        }))
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
    tokio::task::spawn_blocking(install_native_integration_sync)
        .await
        .map_err(|e| e.to_string())?
}

fn install_native_integration_sync() -> Result<(), String> {
    let exe = app_exe_string()?;

    #[cfg(not(target_os = "windows"))]
    validate_native_integration_exe_path(&exe)?; // H1

    #[cfg(target_os = "windows")]
    {
        crate::native_windows::install_context_menu(Path::new(&exe))
    }

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
        let workflow = Path::new(&home).join("Library/Services/Open in IYERIS.workflow/Contents");
        crate::ensure_real_directory_tree(&workflow, "Native integration directory")?;
        write_native_integration_file(
            &workflow.join("Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>NSServices</key><array><dict><key>NSMenuItem</key><dict><key>default</key><string>Open in IYERIS</string></dict><key>NSMessage</key><string>runWorkflowAsService</string><key>NSSendFileTypes</key><array><string>public.item</string></array></dict></array></dict></plist>"#.as_bytes(),
        )?;
        write_native_integration_file(
            &workflow.join("document.wflow"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>actions</key><array><dict><key>action</key><dict><key>AMAccepts</key><dict><key>Container</key><string>List</string><key>Types</key><array><string>com.apple.cocoa.path</string></array></dict><key>AMActionVersion</key><string>2.0.3</string><key>AMApplication</key><array><string>Automator</string></array><key>AMParameterProperties</key><dict><key>COMMAND_STRING</key><dict><key>default value</key><string>while IFS= read -r item; do "{}" "$item"; done</string></dict></dict><key>AMProvides</key><dict><key>Container</key><string>List</string><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict><key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string><key>ActionName</key><string>Run Shell Script</string><key>ActionParameters</key><dict><key>COMMAND_STRING</key><string>while IFS= read -r item; do "{}" "$item"; done</string><key>inputMethod</key><integer>1</integer><key>shell</key><string>/bin/zsh</string></dict><key>BundleIdentifier</key><string>com.apple.RunShellScript</string></dict></dict></array></dict></plist>"#,
                exe, exe
            )
            .as_bytes(),
        )?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
        let service_dir = Path::new(&home).join(".local/share/kio/servicemenus");
        crate::ensure_real_directory_tree(&service_dir, "Native integration directory")?;
        let service_file = service_dir.join("iyeris-open.desktop");
        // Use `ServiceTypes=` (the current KDE key) rather than the legacy
        // `X-KDE-ServiceTypes=`, which newer Plasma (5.85+/6) does not honor.
        write_native_integration_file(
            &service_file,
            format!(
                "[Desktop Entry]\nType=Service\nMimeType=all/all;inode/directory;\nActions=openInIyeris;openParentInIyeris;\nServiceTypes=KonqPopupMenu/Plugin\n\n[Desktop Action openInIyeris]\nName=Open in IYERIS\nExec=\"{}\" %f\n\n[Desktop Action openParentInIyeris]\nName=Open Parent in IYERIS\nExec=sh -c '\"{}\" \"$(dirname \"$1\")\"' -- %f\n",
                exe, exe
            )
            .as_bytes(),
        )?;
        // KDE Plasma 5.85+ / 6 only loads servicemenus from this non-standard
        // user location if the .desktop file is marked executable; without this
        // the entry is silently ignored. (The nautilus script below is chmod'd
        // for the same reason.)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&service_file, fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }

        let nautilus_dir = Path::new(&home).join(".local/share/nautilus/scripts");
        crate::ensure_real_directory_tree(&nautilus_dir, "Native integration directory")?;
        let script = nautilus_dir.join("Open in IYERIS");
        write_native_integration_file(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$NAUTILUS_SCRIPT_SELECTED_FILE_PATHS\" | while IFS= read -r item; do [ -n \"$item\" ] && \"{}\" \"$item\"; done\n",
                exe
            )
            .as_bytes(),
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = exe;
        Err("Native integration is not supported on this platform".to_string())
    }
}

#[tauri::command]
pub async fn uninstall_native_integration() -> Result<(), String> {
    tokio::task::spawn_blocking(uninstall_native_integration_sync)
        .await
        .map_err(|e| e.to_string())?
}

fn uninstall_native_integration_sync() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        crate::native_windows::uninstall_context_menu()
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            let _ = fs::remove_dir_all(
                Path::new(&home).join("Library/Services/Open in IYERIS.workflow"),
            );
        }
        Ok(())
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
        Ok(())
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
    let content = match read_text_limited(&path, MAX_SETTINGS_SUMMARY_BYTES) {
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

#[cfg(test)]
mod tests {
    #[test]
    fn system_text_scale_is_finite_and_bounded() {
        assert_eq!(super::sanitize_system_text_scale(f64::NAN), 1.0);
        assert_eq!(super::sanitize_system_text_scale(f64::INFINITY), 1.0);
        assert_eq!(super::sanitize_system_text_scale(-10.0), 0.5);
        assert_eq!(super::sanitize_system_text_scale(10.0), 3.0);
        assert_eq!(super::sanitize_system_text_scale(1.25), 1.25);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn native_integration_exe_validation_rejects_shell_delimiters() {
        assert!(super::validate_native_integration_exe_path("/opt/IYERIS/app").is_ok());
        assert!(super::validate_native_integration_exe_path("/opt/IYERIS's/app").is_err());
        assert!(super::validate_native_integration_exe_path("/opt/IYERIS\"s/app").is_err());
        assert!(super::validate_native_integration_exe_path("/opt/IYERIS;app").is_err());
        assert!(super::validate_native_integration_exe_path("/opt/IYERIS%f/app").is_err());
    }

    #[test]
    fn diagnostics_settings_allowlist_excludes_private_and_unknown_fields() {
        let private_marker = "private-value-must-not-leak";
        let raw = serde_json::json!({
            "theme": "dark",
            "viewMode": "list",
            "enableIndexer": true,
            "maxSearchHistoryItems": 12,
            "startupPath": private_marker,
            "savedSearches": [{ "query": private_marker, "scopePath": private_marker }],
            "recentTransferDestinations": [private_marker],
            "folderIcons": { private_marker: private_marker },
            "searchHistory": [private_marker],
            "directoryHistory": [private_marker],
            "bookmarks": [private_marker],
            "arbitraryFutureField": private_marker
        });

        let safe = super::diagnostics_settings_allowlist(&raw);
        let serialized = serde_json::to_string(&safe).expect("safe settings should serialize");
        assert_eq!(safe["theme"], "dark");
        assert_eq!(safe["viewMode"], "list");
        assert_eq!(safe["enableIndexer"], true);
        assert_eq!(safe["maxSearchHistoryItems"], 12);
        assert!(!serialized.contains(private_marker));
        assert!(safe.get("savedSearches").is_none());
        assert!(safe.get("arbitraryFutureField").is_none());
    }

    #[test]
    fn diagnostics_export_writes_real_json_and_returns_the_chosen_path() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let path = directory.path().join("diagnostics.json");
        let content = r#"{"version":"3.0","settings":{"theme":"dark"}}"#;

        super::write_diagnostics_file(&path, content).expect("diagnostics should be written");
        let actual = std::fs::read_to_string(&path).expect("chosen output should exist");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&actual).unwrap(),
            serde_json::json!({ "version": "3.0", "settings": { "theme": "dark" } })
        );
        let result = super::diagnostics_export_result(Some(path.clone()));
        assert_eq!(result.status, "saved");
        assert_eq!(result.path.as_deref(), path.to_str());
    }

    #[test]
    fn diagnostics_export_cancellation_is_distinct_from_failure() {
        let result = super::diagnostics_export_result(None);
        assert_eq!(result.status, "cancelled");
        assert!(result.path.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn diagnostics_export_refuses_to_clobber_symlink_destinations() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let target = directory.path().join("target.json");
        let link = directory.path().join("diagnostics.json");
        std::fs::write(&target, "keep target").expect("target should be written");
        symlink(&target, &link).expect("symlink should be created");

        assert!(super::write_diagnostics_file(&link, "{} ").is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep target");
    }
}

#[tauri::command]
pub async fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    tokio::task::spawn_blocking(move || set_autostart_sync(app, enabled))
        .await
        .map_err(|error| error.to_string())?
}

fn set_autostart_sync(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || get_autostart_sync(app))
        .await
        .map_err(|error| error.to_string())?
}

fn get_autostart_sync(app: tauri::AppHandle) -> Result<bool, String> {
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

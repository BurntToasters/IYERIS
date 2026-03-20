use std::fs;
use tauri::Manager;

#[tauri::command]
pub fn get_platform() -> String {
    std::env::consts::OS.to_string()
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

    #[cfg(not(target_os = "macos"))]
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
    1.0
}

#[tauri::command]
pub fn is_mas() -> bool {
    cfg!(feature = "mas")
}

#[tauri::command]
pub fn is_flatpak() -> bool {
    std::env::var("FLATPAK_ID").is_ok()
}

#[tauri::command]
pub fn is_ms_store() -> bool {
    false
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
pub fn open_new_window(app: tauri::AppHandle) -> Result<(), String> {
    let label = format!("window-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis());

    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("IYERIS")
    .inner_size(1200.0, 800.0)
    .min_inner_size(800.0, 500.0)
    .decorations(false)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn set_zoom_level(webview: tauri::WebviewWindow, zoom_level: f64) -> Result<(), String> {
    webview
        .set_zoom(zoom_level)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_zoom_level(webview: tauri::WebviewWindow) -> Result<f64, String> {
    webview.scale_factor().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_terminal(dir_path: String) -> Result<(), String> {
    let path = crate::validate_existing_path(&dir_path, "Directory")?;

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Terminal", path.to_str().unwrap_or(".")])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", &format!("cd /d {}", path.display())])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        for terminal in &["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "xterm"] {
            if std::process::Command::new(terminal)
                .arg(format!("--working-directory={}", path.display()))
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        return Err("No terminal emulator found".into());
    }

    Ok(())
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
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    let licenses_path = resource_path.join("licenses.json");
    fs::read_to_string(&licenses_path).map_err(|e| format!("Failed to read licenses: {}", e))
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
    let info = serde_json::json!({
        "version": app.package_info().version.to_string(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "platform": get_platform(),
    });
    Ok(serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub fn get_log_file_content(app: tauri::AppHandle) -> Result<String, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    let log_file = log_dir.join("iyeris.log");
    fs::read_to_string(&log_file).map_err(|e| format!("Failed to read log: {}", e))
}

#[tauri::command]
pub async fn share_items(file_paths: Vec<String>) -> Result<(), String> {
    if file_paths.is_empty() {
        return Err("No files to share".into());
    }

    #[cfg(target_os = "macos")]
    {
        let _paths_arg = file_paths.join("\" \"");
        std::process::Command::new("osascript")
            .args([
                "-e",
                &format!(
                    "tell application \"Finder\" to activate\ntell application \"System Events\" to keystroke \"\" -- placeholder"
                ),
            ])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn select_folder() -> Result<Option<String>, String> {
    Ok(None)
}

#[tauri::command]
pub async fn check_full_disk_access() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let test_paths = vec![
            format!(
                "{}/Library/Application Support/com.apple.TCC/TCC.db",
                std::env::var("HOME").unwrap_or_default()
            ),
        ];
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
pub async fn get_open_with_apps(_file_path: String) -> Result<Vec<serde_json::Value>, String> {
    // TODO: platform-specific "Open With" app enumeration
    Ok(vec![])
}

#[tauri::command]
pub async fn open_file_with_app(file_path: String, _app_id: String) -> Result<(), String> {
    open::that(&file_path).map_err(|e| e.to_string())
}

pub fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::menu::{MenuBuilder, MenuItemBuilder};

    let show = MenuItemBuilder::with_id("show", "Show IYERIS").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(move |app, event| {
            match event.id().as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

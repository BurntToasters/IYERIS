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

                let receipt = ancestor.join("Contents").join("_MASReceipt").join("receipt");
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
        let output = std::process::Command::new("reg")
            .args(["query", "HKCU\\Software\\IYERIS", "/v", "InstalledViaMsi"])
            .output();

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
pub fn set_zoom_level(
    webview: tauri::WebviewWindow,
    zoom_level: f64,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    webview.set_zoom(zoom_level).map_err(|e| e.to_string())?;
    if let Ok(mut z) = state.zoom_level.lock() {
        *z = zoom_level;
    }
    Ok(())
}

#[tauri::command]
pub fn get_zoom_level(
    state: tauri::State<'_, crate::AppState>,
) -> Result<f64, String> {
    let z = state.zoom_level.lock().map_err(|e| e.to_string())?;
    Ok(*z)
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
        for path in &file_paths {
            std::process::Command::new("open")
                .args(["-R", path])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        for path in &file_paths {
            let parent = std::path::Path::new(path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let _ = open::that(&parent);
        }
    }

    #[cfg(target_os = "windows")]
    {
        for path in &file_paths {
            std::process::Command::new("explorer")
                .args(["/select,", path])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
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
pub async fn get_open_with_apps(file_path: String) -> Result<Vec<serde_json::Value>, String> {
    #[cfg(target_os = "macos")]
    {
        let path = crate::validate_existing_path(&file_path, "File")?;
        let output = tokio::task::spawn_blocking(move || {
            let swift_code = format!(
                r#"import AppKit; import Foundation;
let url = URL(fileURLWithPath: "{}");
let apps = NSWorkspace.shared.urlsForApplications(toOpen: url);
var result: [[String: String]] = [];
for app in apps {{
    let name = FileManager.default.displayName(atPath: app.path);
    result.append(["id": app.path, "name": name]);
}}
let data = try! JSONSerialization.data(withJSONObject: result);
print(String(data: data, encoding: .utf8)!)"#,
                path.display()
            );
            std::process::Command::new("swift")
                .args(["-e", &swift_code])
                .output()
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Ok(apps) = serde_json::from_str::<Vec<serde_json::Value>>(&stdout) {
                return Ok(apps);
            }
        }
        Ok(vec![])
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = file_path;
        Ok(vec![])
    }
}

#[tauri::command]
pub async fn open_file_with_app(file_path: String, app_id: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", &app_id, &file_path])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_id;
        open::that(&file_path).map_err(|e| e.to_string())
    }
}

pub fn should_minimize_to_tray(app: &tauri::AppHandle) -> bool {
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

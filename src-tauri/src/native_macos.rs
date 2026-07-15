use objc2::rc::autoreleasepool;
use objc2_app_kit::{
    NSPasteboard, NSPasteboardTypeString, NSWorkspace, NSWorkspaceOpenConfiguration,
};
use objc2_foundation::{NSArray, NSProcessInfo, NSString, NSUserDefaults, NSURL};
use std::path::{Path, PathBuf};

fn file_url(path: &Path) -> objc2::rc::Retained<NSURL> {
    NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
}

pub fn open_path(path: &Path) -> Result<(), String> {
    autoreleasepool(|_| {
        if NSWorkspace::sharedWorkspace().openURL(&file_url(path)) {
            Ok(())
        } else {
            Err(format!("macOS could not open {}", path.display()))
        }
    })
}

pub fn open_url(url: &str) -> Result<(), String> {
    autoreleasepool(|_| {
        let url = NSURL::URLWithString(&NSString::from_str(url))
            .ok_or_else(|| "Invalid URL".to_string())?;
        if NSWorkspace::sharedWorkspace().openURL(&url) {
            Ok(())
        } else {
            Err("macOS could not open URL".to_string())
        }
    })
}

pub fn reveal_items(paths: &[PathBuf]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    autoreleasepool(|_| {
        let urls: Vec<_> = paths.iter().map(|path| file_url(path)).collect();
        let urls = NSArray::from_retained_slice(&urls);
        NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&urls);
        Ok(())
    })
}

pub fn applications_for_path(path: &Path) -> Vec<(String, String)> {
    autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let apps = workspace.URLsForApplicationsToOpenURL(&file_url(path));
        apps.iter()
            .filter_map(|url| url.path())
            .map(|path| {
                let path = path.to_string();
                let name = Path::new(&path)
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("Application")
                    .to_string();
                (path, name)
            })
            .collect()
    })
}

pub fn open_path_with_app(path: &Path, app_path: &Path) -> Result<(), String> {
    autoreleasepool(|_| {
        let urls = NSArray::from_retained_slice(&[file_url(path)]);
        let configuration = NSWorkspaceOpenConfiguration::configuration();
        NSWorkspace::sharedWorkspace()
            .openURLs_withApplicationAtURL_configuration_completionHandler(
                &urls,
                &file_url(app_path),
                &configuration,
                None,
            );
        Ok(())
    })
}

pub fn open_terminal(path: &Path) -> Result<(), String> {
    const TERMINALS: &[(&str, &str)] = &[
        ("dev.warp.Warp-Stable", "/Applications/Warp.app"),
        ("com.googlecode.iterm2", "/Applications/iTerm.app"),
        ("org.alacritty", "/Applications/Alacritty.app"),
        ("net.kovidgoyal.kitty", "/Applications/kitty.app"),
        ("co.zeit.hyper", "/Applications/Hyper.app"),
        (
            "com.apple.Terminal",
            "/System/Applications/Utilities/Terminal.app",
        ),
    ];

    autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        for (bundle_id, fallback_path) in TERMINALS {
            let installed =
                workspace.URLsForApplicationsWithBundleIdentifier(&NSString::from_str(bundle_id));
            let app_path = installed
                .iter()
                .next()
                .and_then(|url| url.path())
                .map(|value| PathBuf::from(value.to_string()))
                .or_else(|| {
                    let fallback = PathBuf::from(fallback_path);
                    fallback.exists().then_some(fallback)
                });
            if let Some(app_path) = app_path {
                return open_path_with_app(path, &app_path);
            }
        }
        Err("No supported terminal emulator found".to_string())
    })
}

pub fn is_dark_mode() -> bool {
    autoreleasepool(|_| {
        NSUserDefaults::standardUserDefaults()
            .stringForKey(&NSString::from_str("AppleInterfaceStyle"))
            .is_some_and(|value| value.to_string().eq_ignore_ascii_case("dark"))
    })
}

pub fn system_uptime_seconds() -> u64 {
    autoreleasepool(|_| NSProcessInfo::processInfo().systemUptime().max(0.0) as u64)
}

pub fn clipboard_text() -> Option<String> {
    autoreleasepool(|_| {
        let string_type = unsafe { NSPasteboardTypeString };
        NSPasteboard::generalPasteboard()
            .stringForType(string_type)
            .map(|value| value.to_string())
    })
}

pub fn set_clipboard_text(text: &str) -> Result<(), String> {
    autoreleasepool(|_| {
        let pasteboard = NSPasteboard::generalPasteboard();
        let string_type = unsafe { NSPasteboardTypeString };
        pasteboard.clearContents();
        if pasteboard.setString_forType(&NSString::from_str(text), string_type) {
            Ok(())
        } else {
            Err("Failed to write macOS pasteboard".to_string())
        }
    })
}

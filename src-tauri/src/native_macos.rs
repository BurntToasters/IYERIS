use objc2::rc::autoreleasepool;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::ClassType;
use objc2_app_kit::{
    NSPasteboard, NSPasteboardTypeString, NSPasteboardURLReadingFileURLsOnlyKey, NSWorkspace,
    NSWorkspaceLaunchOptions,
};
use objc2_foundation::{
    NSArray, NSCopying, NSDictionary, NSNumber, NSProcessInfo, NSString, NSUserDefaults, NSURL,
};
use std::ffi::{c_char, CString};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr::NonNull;

fn file_url(path: &Path) -> objc2::rc::Retained<NSURL> {
    let representation = CString::new(path.as_os_str().as_bytes())
        .expect("filesystem paths cannot contain NUL bytes");
    let pointer = NonNull::new(representation.as_ptr() as *mut c_char)
        .expect("CString always has a non-null pointer");
    unsafe {
        NSURL::fileURLWithFileSystemRepresentation_isDirectory_relativeToURL(
            pointer,
            path.is_dir(),
            None,
        )
    }
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

#[allow(deprecated)]
pub fn open_path_with_app(path: &Path, app_path: &Path) -> Result<(), String> {
    autoreleasepool(|_| {
        let urls = NSArray::from_retained_slice(&[file_url(path)]);
        let configuration: objc2::rc::Retained<NSDictionary<NSString, AnyObject>> =
            NSDictionary::dictionary();
        unsafe {
            NSWorkspace::sharedWorkspace()
                .openURLs_withApplicationAtURL_options_configuration_error(
                    &urls,
                    &file_url(app_path),
                    NSWorkspaceLaunchOptions::Default,
                    &configuration,
                )
        }
        .map(|_| ())
        .map_err(|error| {
            format!(
                "macOS could not open {} with {}: {}",
                path.display(),
                app_path.display(),
                error.localizedDescription()
            )
        })
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

pub fn clipboard_file_paths() -> Vec<String> {
    autoreleasepool(|_| {
        let classes = NSArray::from_slice(&[NSURL::class()]);
        let file_urls_only = NSNumber::new_bool(true);
        let key: &ProtocolObject<dyn NSCopying> =
            ProtocolObject::from_ref(unsafe { NSPasteboardURLReadingFileURLsOnlyKey });
        let typed_options = unsafe {
            NSDictionary::<NSString, NSNumber>::dictionaryWithObject_forKey(&file_urls_only, key)
        };
        let options = unsafe { typed_options.cast_unchecked::<NSString, AnyObject>() };
        let Some(objects) = (unsafe {
            NSPasteboard::generalPasteboard().readObjectsForClasses_options(&classes, Some(options))
        }) else {
            return Vec::new();
        };

        objects
            .iter()
            .filter_map(|object| object.downcast::<NSURL>().ok())
            .filter(|url| url.isFileURL())
            .filter_map(|url| url.path())
            .map(|path| path.to_string())
            .collect()
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

#[cfg(test)]
mod tests {
    use super::file_url;
    use std::ffi::{CStr, OsStr};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    #[test]
    fn file_url_preserves_non_utf8_filesystem_representation() {
        let bytes = b"/tmp/iyeris-non-utf8-\xFF";
        let path = Path::new(OsStr::from_bytes(bytes));
        let url = file_url(path);
        let representation = unsafe { CStr::from_ptr(url.fileSystemRepresentation().as_ptr()) };

        assert_eq!(representation.to_bytes(), bytes);
    }
}

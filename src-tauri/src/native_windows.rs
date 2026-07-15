use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use windows::{
    core::{HSTRING, PCWSTR, PWSTR},
    Win32::{
        Foundation::HWND,
        Storage::FileSystem::{
            GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL,
            FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_SYSTEM, FILE_FLAGS_AND_ATTRIBUTES,
            INVALID_FILE_ATTRIBUTES,
        },
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::Shell::{
            AssocQueryStringW, Common::ITEMIDLIST, ILClone, ILCreateFromPathW, ILFindLastID,
            ILFree, ILRemoveLastID, SHOpenFolderAndSelectItems, ShellExecuteW, ASSOCF_NONE,
            ASSOCSTR_EXECUTABLE,
        },
        UI::WindowsAndMessaging::SW_SHOWNORMAL,
    },
};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn open_shell_target_wide(target: &[u16]) -> Result<(), String> {
    let result = unsafe {
        ShellExecuteW(
            HWND::default(),
            PCWSTR::null(),
            PCWSTR(target.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    let status = result.0 as isize;
    if status <= 32 {
        Err(format!(
            "Windows could not open target (ShellExecuteW status {status})"
        ))
    } else {
        Ok(())
    }
}

pub fn open_path(path: &Path) -> Result<(), String> {
    open_shell_target_wide(&wide_path(path))
}

pub fn open_uri(uri: &str) -> Result<(), String> {
    let uri = HSTRING::from(uri);
    open_shell_target_wide(uri.as_wide())
}

pub fn read_user_dword(key: &str, value: &str) -> Option<u32> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(key)
        .ok()?
        .get_value(value)
        .ok()
}

pub fn user_key_exists(key: &str) -> bool {
    RegKey::predef(HKEY_CURRENT_USER).open_subkey(key).is_ok()
}

pub fn associated_executable(extension: &str) -> Option<String> {
    let extension = HSTRING::from(extension);
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    let result = unsafe {
        AssocQueryStringW(
            ASSOCF_NONE,
            ASSOCSTR_EXECUTABLE,
            PCWSTR(extension.as_ptr()),
            PCWSTR::null(),
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
    };
    if result.is_err() || length == 0 {
        return None;
    }
    let end = length.saturating_sub(1) as usize;
    let executable = String::from_utf16_lossy(&buffer[..end]);
    (!executable.is_empty()).then_some(executable)
}

pub fn update_file_attributes(
    path: &Path,
    read_only: Option<bool>,
    hidden: Option<bool>,
    system: Option<bool>,
) -> Result<(), String> {
    let path = wide_path(path);
    let current = unsafe { GetFileAttributesW(PCWSTR(path.as_ptr())) };
    if current == INVALID_FILE_ATTRIBUTES {
        return Err(format!(
            "Failed to read Windows file attributes: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut attributes = current;
    for (value, flag) in [
        (read_only, FILE_ATTRIBUTE_READONLY.0),
        (hidden, FILE_ATTRIBUTE_HIDDEN.0),
        (system, FILE_ATTRIBUTE_SYSTEM.0),
    ] {
        match value {
            Some(true) => attributes |= flag,
            Some(false) => attributes &= !flag,
            None => {}
        }
    }
    if attributes == 0 {
        attributes = FILE_ATTRIBUTE_NORMAL.0;
    }

    unsafe { SetFileAttributesW(PCWSTR(path.as_ptr()), FILE_FLAGS_AND_ATTRIBUTES(attributes)) }
        .map_err(|error| format!("Failed to update Windows file attributes: {error}"))
}

pub fn reveal_items(paths: &[PathBuf]) -> Result<(), String> {
    let paths = paths.to_vec();
    std::thread::spawn(move || {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .ok()
            .map_err(|error| format!("Failed to initialize Windows shell: {error}"))?;

        let result = (|| {
            for path in paths {
                let path = wide_path(&path);
                let item = unsafe { ILCreateFromPathW(PCWSTR(path.as_ptr())) };
                if item.is_null() {
                    return Err("Windows could not resolve item for Explorer".to_string());
                }
                let parent = unsafe { ILClone(item) };
                if parent.is_null() {
                    unsafe { ILFree(Some(item)) };
                    return Err("Windows could not resolve the item's parent folder".to_string());
                }
                let child: *const ITEMIDLIST = unsafe { ILFindLastID(item) };
                if child.is_null() || !unsafe { ILRemoveLastID(Some(parent)) }.as_bool() {
                    unsafe {
                        ILFree(Some(parent));
                        ILFree(Some(item));
                    }
                    return Err(
                        "Windows could not split the item from its parent folder".to_string()
                    );
                }
                let selected = unsafe { SHOpenFolderAndSelectItems(parent, Some(&[child]), 0) }
                    .map_err(|error| format!("Failed to reveal item in Explorer: {error}"));
                unsafe { ILFree(Some(parent)) };
                unsafe { ILFree(Some(item)) };
                selected?;
            }
            Ok(())
        })();

        unsafe { CoUninitialize() };
        result
    })
    .join()
    .map_err(|_| "Windows Explorer worker panicked".to_string())?
}

pub fn install_context_menu(executable: &Path) -> Result<(), String> {
    let mut command = std::ffi::OsString::from("\"");
    command.push(executable.as_os_str());
    command.push("\" \"%1\"");
    let mut icon = std::ffi::OsString::from("\"");
    icon.push(executable.as_os_str());
    icon.push("\",0");
    let root = RegKey::predef(HKEY_CURRENT_USER);

    for key_path in [
        r"Software\Classes\*\shell\IYERIS",
        r"Software\Classes\Directory\shell\IYERIS",
    ] {
        let (key, _) = root
            .create_subkey(key_path)
            .map_err(|error| format!("Failed to create context-menu key: {error}"))?;
        key.set_value("", &"Open in IYERIS")
            .map_err(|error| format!("Failed to set context-menu label: {error}"))?;
        key.set_value("Icon", &icon)
            .map_err(|error| format!("Failed to set context-menu icon: {error}"))?;
        let (command_key, _) = key
            .create_subkey("command")
            .map_err(|error| format!("Failed to create context-menu command: {error}"))?;
        command_key
            .set_value("", &command)
            .map_err(|error| format!("Failed to set context-menu command: {error}"))?;
    }
    Ok(())
}

pub fn uninstall_context_menu() -> Result<(), String> {
    let root = RegKey::predef(HKEY_CURRENT_USER);
    for key_path in [
        r"Software\Classes\*\shell\IYERIS",
        r"Software\Classes\Directory\shell\IYERIS",
    ] {
        match root.delete_subkey_all(key_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Failed to remove context-menu key: {error}")),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::wide_path;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;

    #[test]
    fn wide_path_preserves_unpaired_surrogates() {
        let original = [b'C' as u16, b':' as u16, b'\\' as u16, 0xD800, b'x' as u16];
        let path = PathBuf::from(OsString::from_wide(&original));
        let mut expected = original.to_vec();
        expected.push(0);

        assert_eq!(wide_path(&path), expected);
    }
}

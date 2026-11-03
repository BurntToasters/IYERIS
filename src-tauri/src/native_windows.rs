use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use windows::{
    core::{HSTRING, PCWSTR, PWSTR},
    Win32::{
        Foundation::{LocalFree, SetLastError, HLOCAL, HWND, WIN32_ERROR},
        Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT},
        Security::{
            LookupAccountSidW, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SID_NAME_USE,
        },
        Storage::FileSystem::{
            GetCompressedFileSizeW, GetDiskFreeSpaceW, GetFileAttributesW, GetVolumePathNameW,
            SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL,
            FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_SYSTEM, FILE_FLAGS_AND_ATTRIBUTES,
            INVALID_FILE_ATTRIBUTES,
        },
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::Shell::{
            AssocQueryStringW, Common::ITEMIDLIST, ILClone, ILCreateFromPathW, ILFindLastID,
            ILFree, ILRemoveLastID, SHOpenFolderAndSelectItems, ShellExecuteW, ASSOCF_NONE,
            ASSOCSTR, ASSOCSTR_EXECUTABLE, ASSOCSTR_FRIENDLYAPPNAME,
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

fn assoc_query_string(extension: &str, kind: ASSOCSTR) -> Option<String> {
    let extension = HSTRING::from(extension);
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    // SAFETY: `extension` is a valid NUL-terminated HSTRING that outlives the
    // call. `buffer` is writable for `length` UTF-16 units, and `length` holds
    // that capacity on input as the API requires.
    let result = unsafe {
        AssocQueryStringW(
            ASSOCF_NONE,
            kind,
            PCWSTR(extension.as_ptr()),
            PCWSTR::null(),
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
    };
    if result.is_err() || length == 0 {
        return None;
    }
    let end = (length.saturating_sub(1) as usize).min(buffer.len());
    let value = String::from_utf16_lossy(&buffer[..end]);
    (!value.is_empty()).then_some(value)
}

pub fn associated_executable(extension: &str) -> Option<String> {
    assoc_query_string(extension, ASSOCSTR_EXECUTABLE)
}

/// Friendly display name of the default handler for an extension (for example
/// "Notepad"). Returns None when Windows has no registered name.
pub fn associated_app_name(extension: &str) -> Option<String> {
    assoc_query_string(extension, ASSOCSTR_FRIENDLYAPPNAME)
}

/// Bytes per allocation unit (sectors per cluster times bytes per sector) on
/// the volume holding `path`. None when Windows cannot report it.
fn volume_cluster_size(path: &Path) -> Option<u64> {
    let path = wide_path(path);
    let mut volume = vec![0u16; 1024];
    // SAFETY: `path` is a NUL-terminated UTF-16 buffer that outlives the call.
    // `volume` is a zeroed, writable buffer whose length is passed to the API.
    unsafe { GetVolumePathNameW(PCWSTR(path.as_ptr()), &mut volume) }.ok()?;
    let mut sectors_per_cluster: u32 = 0;
    let mut bytes_per_sector: u32 = 0;
    // SAFETY: `volume` now holds the NUL-terminated volume root written above.
    // Both out-pointers refer to valid, writable u32 locals.
    unsafe {
        GetDiskFreeSpaceW(
            PCWSTR(volume.as_ptr()),
            Some(&mut sectors_per_cluster as *mut u32),
            Some(&mut bytes_per_sector as *mut u32),
            None,
            None,
        )
    }
    .ok()?;
    let cluster = u64::from(sectors_per_cluster) * u64::from(bytes_per_sector);
    (cluster > 0).then_some(cluster)
}

/// On-disk size of a file: `GetCompressedFileSizeW` rounded up to the volume
/// cluster size, as Explorer shows it. If the cluster size cannot be resolved,
/// the unrounded value is returned. Zero-byte files stay at zero.
pub fn compressed_file_size(path: &Path) -> Option<u64> {
    let wide = wide_path(path);
    let mut high: u32 = 0;
    // SAFETY: SetLastError only writes the calling thread's error code. Clearing
    // it first lets a legitimate low word of 0xFFFFFFFF be told apart from a
    // real failure once the call returns.
    unsafe { SetLastError(WIN32_ERROR(0)) };
    // SAFETY: `wide` is a NUL-terminated UTF-16 buffer that outlives the call,
    // and `high` is a valid, writable u32 for the high-order size word.
    let low = unsafe { GetCompressedFileSizeW(PCWSTR(wide.as_ptr()), Some(&mut high as *mut u32)) };
    if low == u32::MAX && std::io::Error::last_os_error().raw_os_error() != Some(0) {
        return None;
    }
    let size = (u64::from(high) << 32) | u64::from(low);
    if size == 0 {
        return Some(0);
    }
    Some(match volume_cluster_size(path) {
        Some(cluster) => size.div_ceil(cluster).saturating_mul(cluster),
        None => size,
    })
}

/// Account name of the file owner as `DOMAIN\user` (or just `user` when no
/// domain is reported). Returns None when the security descriptor cannot be
/// read or the SID cannot be resolved.
pub fn owner_account_name(path: &Path) -> Option<String> {
    let path = wide_path(path);
    let mut owner = PSID(std::ptr::null_mut());
    let mut descriptor = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    // SAFETY: `path` is a NUL-terminated UTF-16 buffer that outlives the call.
    // On success the owner SID and the descriptor both point into memory that
    // stays valid until the LocalFree below. The out-pointers are valid,
    // writable locals.
    let status = unsafe {
        GetNamedSecurityInfoW(
            PCWSTR(path.as_ptr()),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            Some(&mut owner as *mut PSID),
            None,
            None,
            None,
            &mut descriptor as *mut PSECURITY_DESCRIPTOR,
        )
    };
    if status.0 != 0 {
        return None;
    }

    let account = if owner.0.is_null() {
        None
    } else {
        const MAX_ACCOUNT_CHARS: usize = 512;
        let mut name = vec![0u16; MAX_ACCOUNT_CHARS];
        let mut domain = vec![0u16; MAX_ACCOUNT_CHARS];
        let mut name_len = name.len() as u32;
        let mut domain_len = domain.len() as u32;
        let mut name_use = SID_NAME_USE(0);
        // SAFETY: `owner` points into the security descriptor, which is still
        // allocated. Both buffers are writable for the length passed in, and the
        // length out-params hold those capacities on input.
        let lookup = unsafe {
            LookupAccountSidW(
                PCWSTR::null(),
                owner,
                PWSTR(name.as_mut_ptr()),
                &mut name_len,
                PWSTR(domain.as_mut_ptr()),
                &mut domain_len,
                &mut name_use,
            )
        };
        if lookup.is_err() {
            None
        } else {
            let name = String::from_utf16_lossy(&name[..(name_len as usize).min(name.len())]);
            let domain =
                String::from_utf16_lossy(&domain[..(domain_len as usize).min(domain.len())]);
            if name.is_empty() {
                None
            } else if domain.is_empty() {
                Some(name)
            } else {
                Some(format!("{domain}\\{name}"))
            }
        }
    };

    if !descriptor.0.is_null() {
        // SAFETY: `descriptor` was allocated by GetNamedSecurityInfoW through
        // LocalAlloc and is freed exactly once here. Nothing references the
        // owner SID after this point.
        unsafe { LocalFree(HLOCAL(descriptor.0)) };
    }
    account
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

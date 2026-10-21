//! Preserve native metadata on newly created, private copy destinations.
use std::{fs, path::Path};

pub(crate) fn preserve_directory(
    source: &Path,
    destination: &Path,
    cancelled: &impl Fn() -> bool,
) -> Result<(), String> {
    let open = |path: &Path, _writable: bool| -> Result<fs::File, String> {
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            #[cfg(target_os = "macos")]
            options.custom_flags(0x100); // O_NOFOLLOW
            #[cfg(target_os = "linux")]
            options.custom_flags(0x20000); // O_NOFOLLOW
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // SYNCHRONIZE | READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
            // plus FILE_WRITE_ATTRIBUTES when writing timestamps.
            options.access_mode(0x0012_0081 | if _writable { 0x100 } else { 0 });
            options.custom_flags(0x0220_0000); // BACKUP_SEMANTICS | OPEN_REPARSE_POINT
        }
        let file = options.open(path).map_err(|error| error.to_string())?;
        if !file.metadata().map_err(|error| error.to_string())?.is_dir() {
            return Err("Directory changed while preserving metadata".to_string());
        }
        Ok(file)
    };
    let input = open(source, false)?;
    let output = open(destination, true)?;
    preserve(&input, &output, cancelled)?;
    #[cfg(windows)]
    preserve_windows_acl(source, destination)?;
    Ok(())
}

pub(crate) fn preserve(
    input: &fs::File,
    output: &fs::File,
    cancelled: &impl Fn() -> bool,
) -> Result<(), String> {
    if cancelled() {
        return Err("Operation cancelled".to_string());
    }
    let metadata = input.metadata().map_err(|error| error.to_string())?;
    let permissions = metadata.permissions();
    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let destination = output.metadata().map_err(|error| error.to_string())?;
        let mut mode = permissions.mode();
        // Copying as another owner must not create a new setuid/setgid program.
        if metadata.uid() != destination.uid() {
            mode &= !0o4000;
        }
        if metadata.gid() != destination.gid() {
            mode &= !0o2000;
        }
        fs::Permissions::from_mode(mode)
    };
    output
        .set_permissions(permissions)
        .map_err(|error| format!("Cannot preserve permissions: {error}"))?;
    #[cfg(target_os = "macos")]
    mac_metadata(input, output, cancelled)?;
    #[cfg(target_os = "linux")]
    linux_metadata(input, output, cancelled)?;
    let mut times = fs::FileTimes::new();
    if let Ok(time) = metadata.accessed() {
        times = times.set_accessed(time);
    }
    if let Ok(time) = metadata.modified() {
        times = times.set_modified(time);
    }
    output
        .set_times(times)
        .map_err(|error| format!("Cannot preserve timestamps: {error}"))?;
    if cancelled() {
        return Err("Operation cancelled".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn mac_metadata(
    input: &fs::File,
    output: &fs::File,
    cancelled: &impl Fn() -> bool,
) -> Result<(), String> {
    use std::{
        ffi::{c_char, c_void},
        os::fd::AsRawFd,
    };
    unsafe extern "C" {
        fn fcopyfile(source: i32, destination: i32, state: *mut c_void, flags: u32) -> i32;
        fn copyfile_state_alloc() -> *mut c_void;
        fn copyfile_state_free(state: *mut c_void) -> i32;
        fn copyfile_state_set(state: *mut c_void, flag: u32, value: *const c_void) -> i32;
    }
    extern "C" fn progress<F: Fn() -> bool>(
        _: i32,
        _: i32,
        _: *mut c_void,
        _: *const c_char,
        _: *const c_char,
        context: *mut c_void,
    ) -> i32 {
        // copyfile invokes callbacks synchronously; context outlives the call.
        let cancelled = unsafe { &*context.cast::<F>() };
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(cancelled)).unwrap_or(true) {
            2
        } else {
            0
        }
    }
    fn callback<F: Fn() -> bool>(_: &F) -> *const c_void {
        progress::<F> as *const c_void
    }
    unsafe {
        let state = copyfile_state_alloc();
        if state.is_null() {
            return Err("Cannot allocate metadata copy state".to_string());
        }
        let status = if copyfile_state_set(state, 6, callback(cancelled)) != 0
            || copyfile_state_set(state, 7, std::ptr::from_ref(cancelled).cast()) != 0
        {
            -1
        } else {
            fcopyfile(input.as_raw_fd(), output.as_raw_fd(), state, 1 | 4)
        }; // ACL | XATTR
        let error = std::io::Error::last_os_error();
        copyfile_state_free(state);
        if cancelled() {
            return Err("Operation cancelled".to_string());
        }
        if status != 0 {
            return Err(format!("Cannot preserve ACLs/extended attributes: {error}"));
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_metadata(
    input: &fs::File,
    output: &fs::File,
    cancelled: &impl Fn() -> bool,
) -> Result<(), String> {
    use std::{
        ffi::{c_char, c_void, CString},
        os::fd::AsRawFd,
    };
    unsafe extern "C" {
        fn flistxattr(fd: i32, list: *mut c_char, size: usize) -> isize;
        fn fgetxattr(fd: i32, name: *const c_char, value: *mut c_void, size: usize) -> isize;
        fn fsetxattr(
            fd: i32,
            name: *const c_char,
            value: *const c_void,
            size: usize,
            flags: i32,
        ) -> i32;
        fn fremovexattr(fd: i32, name: *const c_char) -> i32;
    }
    let fail = || {
        format!(
            "Cannot preserve ACLs/extended attributes: {}",
            std::io::Error::last_os_error()
        )
    };
    // Linux limits attribute name lists and individual values to 64 KiB.
    let mut names = vec![0u8; 65536];
    let count = unsafe { flistxattr(input.as_raw_fd(), names.as_mut_ptr().cast(), names.len()) };
    if count < 0 {
        if std::io::Error::last_os_error().raw_os_error() == Some(95) {
            return Ok(());
        }
        return Err(fail());
    }
    names.truncate(count as usize);
    for acl in [c"system.posix_acl_access", c"system.posix_acl_default"] {
        if !names
            .split(|byte| *byte == 0)
            .any(|name| name == acl.to_bytes())
            && unsafe { fremovexattr(output.as_raw_fd(), acl.as_ptr()) } != 0
            && !matches!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(61 | 95)
            )
        {
            return Err(fail());
        }
    }
    for name in names
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
    {
        if cancelled() {
            return Err("Operation cancelled".to_string());
        }
        let name = CString::new(name).map_err(|error| error.to_string())?;
        let mut value = vec![0u8; 65536];
        let count = unsafe {
            fgetxattr(
                input.as_raw_fd(),
                name.as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
            )
        };
        if count < 0 {
            return Err(fail());
        }
        if unsafe {
            fsetxattr(
                output.as_raw_fd(),
                name.as_ptr(),
                value.as_ptr().cast(),
                count as usize,
                0,
            )
        } != 0
        {
            return Err(fail());
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn preserve_windows_acl(source: &Path, destination: &Path) -> Result<(), String> {
    use windows::{
        core::HSTRING,
        Win32::Security::{
            GetFileSecurityW, GetSecurityDescriptorControl, SetFileSecurityW,
            DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
            SE_DACL_PROTECTED, UNPROTECTED_DACL_SECURITY_INFORMATION,
        },
    };
    let source = HSTRING::from(source.as_os_str());
    let destination = HSTRING::from(destination.as_os_str());
    let mut needed = 0;
    unsafe {
        let _ = GetFileSecurityW(
            &source,
            DACL_SECURITY_INFORMATION.0,
            PSECURITY_DESCRIPTOR::default(),
            0,
            &mut needed,
        );
        if needed == 0 || needed > 1024 * 1024 {
            return Err("Cannot read source ACL".to_string());
        }
        let mut descriptor = vec![0u32; (needed as usize).div_ceil(4)];
        let pointer = PSECURITY_DESCRIPTOR(descriptor.as_mut_ptr().cast());
        GetFileSecurityW(
            &source,
            DACL_SECURITY_INFORMATION.0,
            pointer,
            needed,
            &mut needed,
        )
        .ok()
        .map_err(|error| error.to_string())?;
        let mut control = 0;
        let mut revision = 0;
        GetSecurityDescriptorControl(pointer, &mut control, &mut revision)
            .map_err(|error| error.to_string())?;
        let inheritance = if control & SE_DACL_PROTECTED.0 != 0 {
            PROTECTED_DACL_SECURITY_INFORMATION
        } else {
            UNPROTECTED_DACL_SECURITY_INFORMATION
        };
        SetFileSecurityW(
            &destination,
            DACL_SECURITY_INFORMATION | inheritance,
            pointer,
        )
        .ok()
        .map_err(|error| format!("Cannot preserve ACL: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_and_directory_modification_times_survive_copy() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        fs::create_dir(&source).unwrap();
        let file = fs::File::create(source.join("file")).unwrap();
        let time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_500_000_000);
        file.set_times(fs::FileTimes::new().set_modified(time))
            .unwrap();
        #[cfg(unix)]
        fs::File::open(&source)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(time))
            .unwrap();
        crate::fs_utils::copy_dir_recursive(&source, &destination).unwrap();
        assert_eq!(
            fs::metadata(destination.join("file"))
                .unwrap()
                .modified()
                .unwrap(),
            time
        );
        #[cfg(unix)]
        assert_eq!(fs::metadata(destination).unwrap().modified().unwrap(), time);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_file_and_directory_keep_xattrs_and_acl() {
        use std::process::Command;
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("file"), b"contents").unwrap();
        for path in [&source, &source.join("file")] {
            assert!(Command::new("/usr/bin/xattr")
                .args(["-w", "run.iyeris.test", "metadata"])
                .arg(path)
                .status()
                .unwrap()
                .success());
            assert!(Command::new("/bin/chmod")
                .args(["+a", "everyone deny delete"])
                .arg(path)
                .status()
                .unwrap()
                .success());
        }
        crate::fs_utils::copy_dir_recursive(&source, &destination).unwrap();
        for path in [&destination, &destination.join("file")] {
            let attr = Command::new("/usr/bin/xattr")
                .args(["-p", "run.iyeris.test"])
                .arg(path)
                .output()
                .unwrap();
            assert!(attr.status.success());
            assert_eq!(String::from_utf8_lossy(&attr.stdout).trim(), "metadata");
            let acl = Command::new("/bin/ls")
                .arg("-lde")
                .arg(path)
                .output()
                .unwrap();
            let original = if path == &destination {
                source.clone()
            } else {
                source.join("file")
            };
            let original_acl = Command::new("/bin/ls")
                .arg("-lde")
                .arg(original)
                .output()
                .unwrap();
            let entries = |bytes: &[u8]| {
                String::from_utf8_lossy(bytes)
                    .lines()
                    .skip(1)
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            assert!(!entries(&acl.stdout).is_empty());
            assert_eq!(entries(&acl.stdout), entries(&original_acl.stdout));
        }
        // Undo the test ACL before the temporary directory's cleanup.
        for path in [
            &source,
            &source.join("file"),
            &destination,
            &destination.join("file"),
        ] {
            assert!(Command::new("/bin/chmod")
                .arg("-N")
                .arg(path)
                .status()
                .unwrap()
                .success());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_copies_user_xattrs_and_posix_acl() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        fs::write(&source, b"contents").unwrap();
        let source_c = CString::new(source.as_os_str().as_bytes()).unwrap();
        // POSIX ACL v2: owner rw, named uid 12345 r, group r, mask r, other none.
        let mut acl = 2u32.to_le_bytes().to_vec();
        for (tag, perm, id) in [
            (1u16, 6u16, u32::MAX),
            (2, 4, 12345),
            (4, 4, u32::MAX),
            (16, 4, u32::MAX),
            (32, 0, u32::MAX),
        ] {
            acl.extend(tag.to_le_bytes());
            acl.extend(perm.to_le_bytes());
            acl.extend(id.to_le_bytes());
        }
        for (name, value) in [
            (c"user.iyeris.test", b"metadata".as_slice()),
            (c"system.posix_acl_access", acl.as_slice()),
        ] {
            assert_eq!(
                unsafe {
                    nix::libc::setxattr(
                        source_c.as_ptr(),
                        name.as_ptr(),
                        value.as_ptr().cast(),
                        value.len(),
                        0,
                    )
                },
                0
            );
        }
        crate::fs_utils::copy_file_cancellable(&source, &destination, &|| false).unwrap();
        let destination_c = CString::new(destination.as_os_str().as_bytes()).unwrap();
        for (name, expected) in [
            (c"user.iyeris.test", b"metadata".as_slice()),
            (c"system.posix_acl_access", acl.as_slice()),
        ] {
            let mut value = vec![0u8; 65536];
            let count = unsafe {
                nix::libc::getxattr(
                    destination_c.as_ptr(),
                    name.as_ptr(),
                    value.as_mut_ptr().cast(),
                    value.len(),
                )
            };
            assert!(count >= 0);
            value.truncate(count as usize);
            assert_eq!(value, expected);
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_copy_keeps_protected_dacl() {
        use windows::{
            core::HSTRING,
            Win32::Security::{
                GetFileSecurityW, SetFileSecurityW, DACL_SECURITY_INFORMATION,
                PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
            },
        };
        fn read_acl(path: &Path) -> Vec<u32> {
            let mut buffer = vec![0u32; 16384];
            let mut needed = 0;
            unsafe {
                GetFileSecurityW(
                    &HSTRING::from(path.as_os_str()),
                    DACL_SECURITY_INFORMATION.0,
                    PSECURITY_DESCRIPTOR(buffer.as_mut_ptr().cast()),
                    (buffer.len() * 4) as u32,
                    &mut needed,
                )
                .ok()
                .unwrap();
            }
            buffer.truncate((needed as usize).div_ceil(4));
            buffer
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        fs::write(&source, b"contents").unwrap();
        let mut acl = read_acl(&source);
        unsafe {
            SetFileSecurityW(
                &HSTRING::from(source.as_os_str()),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                PSECURITY_DESCRIPTOR(acl.as_mut_ptr().cast()),
            )
            .ok()
            .unwrap();
        }
        crate::fs_utils::copy_file_cancellable(&source, &destination, &|| false).unwrap();
        assert_eq!(read_acl(&source), read_acl(&destination));
    }

    #[cfg(windows)]
    #[test]
    fn windows_copy_keeps_alternate_streams() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        fs::write(&source, b"contents").unwrap();
        fs::write(temp.path().join("source:iyeris-test"), b"stream contents").unwrap();
        crate::fs_utils::copy_file_cancellable(&source, &destination, &|| false).unwrap();
        assert_eq!(
            fs::read(temp.path().join("destination:iyeris-test")).unwrap(),
            b"stream contents"
        );
    }
}

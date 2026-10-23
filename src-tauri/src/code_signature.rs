//! Code signature inspection for the Properties dialog's "Digital Signatures" tab.
//!
//! Windows reads embedded Authenticode signatures through WinVerifyTrust and
//! the Crypt32 message APIs. macOS reads the code signature through
//! Security.framework. Every other platform reports `unsupported`. Nothing here
//! spawns a process.

#![cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]

use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SignatureStatus {
    Valid,
    Invalid,
    Untrusted,
    Expired,
    Revoked,
    Unsigned,
    Unsupported,
    Error,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodeSigner {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest_algorithm: Option<String>,
    /// Signing time in milliseconds since the Unix epoch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial_number: Option<String>,
    /// SHA-1 of the certificate, uppercase hex.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_to: Option<f64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CodeSignatureInfo {
    pub supported: bool,
    pub signed: bool,
    pub status: SignatureStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
    pub signers: Vec<CodeSigner>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hardened_runtime: Option<bool>,
}

impl CodeSignatureInfo {
    fn unsupported(message: &str) -> Self {
        Self {
            supported: false,
            signed: false,
            status: SignatureStatus::Unsupported,
            status_message: Some(message.to_string()),
            signers: Vec::new(),
            identifier: None,
            team_id: None,
            hardened_runtime: None,
        }
    }
}

#[tauri::command]
pub async fn get_code_signature(item_path: String) -> Result<CodeSignatureInfo, String> {
    tokio::task::spawn_blocking(move || get_code_signature_sync(item_path))
        .await
        .map_err(|e| e.to_string())?
}

fn get_code_signature_sync(item_path: String) -> Result<CodeSignatureInfo, String> {
    log::debug!("[CodeSignature] get_code_signature: {}", item_path);
    let path = crate::validate_existing_path(&item_path, "Item")?;
    // Signature parsing opens the file, so it follows the same sensitive-path
    // policy as content previews.
    crate::file_operations::ensure_safe_preview_read_path(&path)?;
    Ok(inspect(&path))
}

#[cfg(target_os = "windows")]
fn inspect(path: &Path) -> CodeSignatureInfo {
    if path.is_dir() {
        return CodeSignatureInfo::unsupported("Folders do not carry a code signature on Windows.");
    }
    authenticode::inspect(path)
}

#[cfg(target_os = "macos")]
fn inspect(path: &Path) -> CodeSignatureInfo {
    codesign::inspect(path)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn inspect(_path: &Path) -> CodeSignatureInfo {
    CodeSignatureInfo::unsupported("Code signatures are not inspected on this platform.")
}

/// Byte storage with 8-byte alignment, for Crypt32 structs that hold pointers.
#[cfg(target_os = "windows")]
struct AlignedBytes {
    words: Vec<u64>,
    len: usize,
}

#[cfg(target_os = "windows")]
impl AlignedBytes {
    fn with_len(len: usize) -> Self {
        Self {
            words: vec![0u64; len.div_ceil(8)],
            len,
        }
    }

    fn as_ptr(&self) -> *const std::ffi::c_void {
        self.words.as_ptr() as *const std::ffi::c_void
    }

    fn as_mut_ptr(&mut self) -> *mut std::ffi::c_void {
        self.words.as_mut_ptr() as *mut std::ffi::c_void
    }

    fn bytes(&self) -> &[u8] {
        // SAFETY: `words` holds at least `len` bytes of initialized storage
        // (zeroed on allocation, then written by the Win32 call), and `len`
        // never exceeds the allocated capacity.
        unsafe { std::slice::from_raw_parts(self.words.as_ptr() as *const u8, self.len) }
    }
}

#[cfg(target_os = "windows")]
mod authenticode {
    use super::{AlignedBytes, CodeSignatureInfo, CodeSigner, SignatureStatus};
    use std::ffi::{c_char, c_void, CStr};
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::null_mut;
    use std::slice;
    use windows::core::{HRESULT, PCWSTR};
    use windows::Win32::Foundation::{
        CERT_E_CHAINING, CERT_E_EXPIRED, CERT_E_REVOKED, CERT_E_UNTRUSTEDROOT, CRYPT_E_BAD_MSG,
        FILETIME, HANDLE, HWND, TRUST_E_BAD_DIGEST, TRUST_E_EXPLICIT_DISTRUST, TRUST_E_NOSIGNATURE,
        TRUST_E_PROVIDER_UNKNOWN, TRUST_E_SUBJECT_FORM_UNKNOWN,
    };
    use windows::Win32::Security::Cryptography::{
        CertCloseStore, CertFindCertificateInStore, CertFreeCertificateContext,
        CertGetCertificateContextProperty, CertGetNameStringW, CryptDecodeObjectEx, CryptMsgClose,
        CryptMsgGetParam, CryptQueryObject, CERT_CONTEXT, CERT_FIND_SUBJECT_CERT, CERT_INFO,
        CERT_NAME_ISSUER_FLAG, CERT_NAME_SIMPLE_DISPLAY_TYPE, CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED,
        CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED, CERT_QUERY_CONTENT_TYPE_FLAGS,
        CERT_QUERY_ENCODING_TYPE, CERT_QUERY_FORMAT_FLAG_BINARY, CERT_QUERY_OBJECT_BLOB,
        CERT_QUERY_OBJECT_FILE, CERT_QUERY_OBJECT_TYPE, CERT_SHA1_HASH_PROP_ID, CMSG_CONTENT_PARAM,
        CMSG_SIGNER_COUNT_PARAM, CMSG_SIGNER_INFO, CMSG_SIGNER_INFO_PARAM, CRYPT_ATTRIBUTES,
        CRYPT_INTEGER_BLOB, HCERTSTORE, PKCS7_SIGNER_INFO, PKCS_7_ASN_ENCODING, X509_ASN_ENCODING,
    };
    use windows::Win32::Security::WinTrust::{
        WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0,
        WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE, WTD_REVOKE_NONE,
        WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    };

    /// Countersignature (RFC 3161 timestamp token) attribute.
    const OID_RFC3161_TIMESTAMP: &[u8] = b"1.3.6.1.4.1.311.3.3.1";
    /// Legacy Authenticode countersignature attribute.
    const OID_COUNTERSIGNATURE: &[u8] = b"1.2.840.113549.1.9.6";
    /// PKCS#9 signingTime authenticated attribute.
    const OID_SIGNING_TIME: &[u8] = b"1.2.840.113549.1.9.5";
    /// Nested (dual) Authenticode signature attribute.
    const OID_NESTED_SIGNATURE: &[u8] = b"1.3.6.1.4.1.311.2.4.1";

    /// Milliseconds between 1601-01-01 (FILETIME epoch) and 1970-01-01.
    const FILETIME_UNIX_EPOCH_MS: f64 = 11_644_473_600_000.0;

    pub(super) fn inspect(path: &Path) -> CodeSignatureInfo {
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let (status, status_message) = verify_trust(&wide);
        let signed = !matches!(
            status,
            SignatureStatus::Unsigned | SignatureStatus::Unsupported
        );

        let mut signers = Vec::new();
        if let Some(pkcs7) = Pkcs7::query(
            CERT_QUERY_OBJECT_FILE,
            wide.as_ptr() as *const c_void,
            CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
        ) {
            collect_signers(&pkcs7, 0, &mut signers);
        }

        CodeSignatureInfo {
            supported: status != SignatureStatus::Unsupported,
            signed,
            status,
            status_message,
            signers,
            identifier: None,
            team_id: None,
            hardened_runtime: None,
        }
    }

    /// Runs WinVerifyTrust in offline mode and maps the HRESULT to a status.
    fn verify_trust(wide: &[u16]) -> (SignatureStatus, Option<String>) {
        let mut file_info = WINTRUST_FILE_INFO {
            cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
            pcwszFilePath: PCWSTR(wide.as_ptr()),
            hFile: HANDLE(null_mut()),
            pgKnownSubject: null_mut(),
        };
        let mut data = WINTRUST_DATA {
            cbStruct: size_of::<WINTRUST_DATA>() as u32,
            dwUIChoice: WTD_UI_NONE,
            fdwRevocationChecks: WTD_REVOKE_NONE,
            dwUnionChoice: WTD_CHOICE_FILE,
            Anonymous: WINTRUST_DATA_0 {
                pFile: &mut file_info as *mut WINTRUST_FILE_INFO,
            },
            dwStateAction: WTD_STATEACTION_VERIFY,
            dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL,
            ..Default::default()
        };
        let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        // INVALID_HANDLE_VALUE, as documented for WinVerifyTrust. UI is disabled,
        // so the handle is never used.
        let hwnd = HWND(-1isize as *mut c_void);

        // SAFETY: `data`, `file_info`, `wide` and `action` are live locals that
        // outlive both calls. `data.hWVTStateData` is written by the VERIFY call
        // and released by the CLOSE call below, which runs unconditionally.
        let hr = unsafe {
            WinVerifyTrust(
                hwnd,
                &mut action,
                &mut data as *mut WINTRUST_DATA as *mut c_void,
            )
        };
        let verdict = classify_trust_result(hr);

        data.dwStateAction = WTD_STATEACTION_CLOSE;
        // SAFETY: same live locals as the VERIFY call. CLOSE only releases the
        // state handle that VERIFY created, so its return value is not needed.
        unsafe {
            WinVerifyTrust(
                hwnd,
                &mut action,
                &mut data as *mut WINTRUST_DATA as *mut c_void,
            )
        };
        verdict
    }

    fn classify_trust_result(hr: i32) -> (SignatureStatus, Option<String>) {
        if hr == 0 {
            return (SignatureStatus::Valid, None);
        }
        let code = HRESULT(hr);
        let status = if code == TRUST_E_NOSIGNATURE || code == TRUST_E_SUBJECT_FORM_UNKNOWN {
            SignatureStatus::Unsigned
        } else if code == TRUST_E_PROVIDER_UNKNOWN {
            SignatureStatus::Unsupported
        } else if code == CERT_E_EXPIRED {
            SignatureStatus::Expired
        } else if code == CERT_E_REVOKED {
            SignatureStatus::Revoked
        } else if code == CERT_E_UNTRUSTEDROOT
            || code == CERT_E_CHAINING
            || code == TRUST_E_EXPLICIT_DISTRUST
        {
            SignatureStatus::Untrusted
        } else if code == TRUST_E_BAD_DIGEST || code == CRYPT_E_BAD_MSG {
            SignatureStatus::Invalid
        } else {
            SignatureStatus::Error
        };
        let message = match status {
            SignatureStatus::Unsigned => "The file has no embedded signature.".to_string(),
            SignatureStatus::Unsupported => {
                "Windows does not check signatures for this file type.".to_string()
            }
            SignatureStatus::Expired => "The signing certificate has expired.".to_string(),
            SignatureStatus::Revoked => "The signing certificate has been revoked.".to_string(),
            SignatureStatus::Untrusted => {
                "The signing certificate does not chain to a trusted root.".to_string()
            }
            SignatureStatus::Invalid => {
                "The signature does not match the file contents.".to_string()
            }
            _ => format!("WinVerifyTrust failed with HRESULT 0x{:08X}.", hr as u32),
        };
        (status, Some(message))
    }

    /// An open PKCS#7 message and the certificate store it carries.
    struct Pkcs7 {
        store: HCERTSTORE,
        msg: *mut c_void,
    }

    impl Pkcs7 {
        /// Opens the embedded PKCS#7 signature of a file, or a standalone
        /// PKCS#7 blob when `object_type` is `CERT_QUERY_OBJECT_BLOB`.
        fn query(
            object_type: CERT_QUERY_OBJECT_TYPE,
            object: *const c_void,
            content_flags: CERT_QUERY_CONTENT_TYPE_FLAGS,
        ) -> Option<Self> {
            let mut store = HCERTSTORE(null_mut());
            let mut msg: *mut c_void = null_mut();
            // SAFETY: `object` is the NUL-terminated wide path or the blob that
            // the caller keeps alive for this call. The out-params are valid
            // locals. CryptQueryObject leaves them NULL on failure, and the
            // guard below closes whatever it did return.
            let result = unsafe {
                CryptQueryObject(
                    object_type,
                    object,
                    content_flags,
                    CERT_QUERY_FORMAT_FLAG_BINARY,
                    0,
                    None,
                    None,
                    None,
                    Some(&mut store as *mut HCERTSTORE),
                    Some(&mut msg as *mut *mut c_void),
                    None,
                )
            };
            let owned = Pkcs7 { store, msg };
            result.ok().map(|_| owned)
        }

        fn from_blob(data: &[u8]) -> Option<Self> {
            let blob = CRYPT_INTEGER_BLOB {
                cbData: u32::try_from(data.len()).ok()?,
                pbData: data.as_ptr() as *mut u8,
            };
            // A standalone blob reports plain PKCS7_SIGNED. The EMBED flag is only
            // reported for signatures stored inside a file.
            Self::query(
                CERT_QUERY_OBJECT_BLOB,
                &blob as *const CRYPT_INTEGER_BLOB as *const c_void,
                CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED,
            )
        }
    }

    impl Drop for Pkcs7 {
        fn drop(&mut self) {
            // SAFETY: both handles came from CryptQueryObject and are released
            // exactly once, here. Null handles are skipped. Certificate contexts
            // are always freed before the owning Pkcs7 drops.
            unsafe {
                if !self.msg.is_null() {
                    let _ = CryptMsgClose(Some(self.msg as *const c_void));
                }
                if !self.store.0.is_null() {
                    let _ = CertCloseStore(self.store, 0);
                }
            }
        }
    }

    /// A referenced CERT_CONTEXT, freed on drop.
    struct CertContext(*const CERT_CONTEXT);

    impl CertContext {
        fn find(store: HCERTSTORE, info: &CERT_INFO) -> Option<Self> {
            // SAFETY: `store` is open for the lifetime of its Pkcs7 owner.
            // CERT_FIND_SUBJECT_CERT reads only Issuer and SerialNumber from
            // `info`, which the caller keeps alive for this call.
            let ctx = unsafe {
                CertFindCertificateInStore(
                    store,
                    CERT_QUERY_ENCODING_TYPE(X509_ASN_ENCODING.0 | PKCS_7_ASN_ENCODING.0),
                    0,
                    CERT_FIND_SUBJECT_CERT,
                    Some(info as *const CERT_INFO as *const c_void),
                    None,
                )
            };
            (!ctx.is_null()).then_some(CertContext(ctx))
        }
    }

    impl Drop for CertContext {
        fn drop(&mut self) {
            // SAFETY: the context was returned by CertFindCertificateInStore and
            // is freed exactly once, here.
            unsafe {
                let _ = CertFreeCertificateContext(Some(self.0));
            }
        }
    }

    /// Walks every signer in a PKCS#7 message. Nested (dual) signatures are
    /// read one level deep and appended after the primary signers.
    fn collect_signers(pkcs7: &Pkcs7, depth: u32, out: &mut Vec<CodeSigner>) {
        let Some(count_bytes) = crypt_msg_param(pkcs7.msg, CMSG_SIGNER_COUNT_PARAM, 0) else {
            return;
        };
        let count_bytes = count_bytes.bytes();
        if count_bytes.len() < 4 {
            return;
        }
        let count = u32::from_ne_bytes([
            count_bytes[0],
            count_bytes[1],
            count_bytes[2],
            count_bytes[3],
        ]);

        let mut nested: Vec<Vec<u8>> = Vec::new();
        for index in 0..count {
            let Some(buf) = crypt_msg_param(pkcs7.msg, CMSG_SIGNER_INFO_PARAM, index) else {
                continue;
            };
            // SAFETY: CryptMsgGetParam wrote a CMSG_SIGNER_INFO into `buf`, which is
            // 8-byte aligned and stays alive for this iteration. Its pointers
            // reference memory inside the same buffer.
            let info = unsafe { &*(buf.as_ptr() as *const CMSG_SIGNER_INFO) };
            if let Some(signer) = describe_signer(pkcs7, info) {
                out.push(signer);
            }
            if depth == 0 {
                nested.extend(attr_values(&info.UnauthAttrs, OID_NESTED_SIGNATURE));
            }
        }
        for blob in nested {
            if let Some(inner) = Pkcs7::from_blob(&blob) {
                collect_signers(&inner, depth + 1, out);
            }
        }
    }

    fn describe_signer(pkcs7: &Pkcs7, info: &CMSG_SIGNER_INFO) -> Option<CodeSigner> {
        let lookup = CERT_INFO {
            Issuer: info.Issuer,
            SerialNumber: info.SerialNumber,
            ..Default::default()
        };
        let cert = CertContext::find(pkcs7.store, &lookup)?;
        let ctx = cert.0;

        // SAFETY: `ctx` is a live context owned by `cert`. Its pCertInfo points
        // at the decoded certificate, which lives as long as the context.
        let cert_info_ptr = unsafe { (*ctx).pCertInfo };
        if cert_info_ptr.is_null() {
            return None;
        }
        // SAFETY: the pointer was checked for null above and refers to the same
        // live certificate info as the context.
        let cert_info = unsafe { &*cert_info_ptr };

        let name = cert_name(ctx, 0)?;
        let issuer = cert_name(ctx, CERT_NAME_ISSUER_FLAG);

        Some(CodeSigner {
            name,
            issuer,
            digest_algorithm: digest_name(&info.HashAlgorithm.pszObjId),
            timestamp: signer_timestamp(info),
            serial_number: serial_hex(&cert_info.SerialNumber),
            thumbprint: thumbprint(ctx),
            valid_from: Some(filetime_ms(cert_info.NotBefore)),
            valid_to: Some(filetime_ms(cert_info.NotAfter)),
        })
    }

    fn cert_name(ctx: *const CERT_CONTEXT, flags: u32) -> Option<String> {
        // SAFETY: `ctx` is live. A NULL buffer asks for the length, including the
        // terminator.
        let len =
            unsafe { CertGetNameStringW(ctx, CERT_NAME_SIMPLE_DISPLAY_TYPE, flags, None, None) };
        if len <= 1 {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        // SAFETY: `buf` holds `len` UTF-16 units, the length the first call reported.
        let written = unsafe {
            CertGetNameStringW(
                ctx,
                CERT_NAME_SIMPLE_DISPLAY_TYPE,
                flags,
                None,
                Some(buf.as_mut_slice()),
            )
        };
        if written <= 1 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..written as usize - 1]))
    }

    fn thumbprint(ctx: *const CERT_CONTEXT) -> Option<String> {
        let mut hash = [0u8; 20];
        let mut len = hash.len() as u32;
        // SAFETY: `hash` is 20 writable bytes and `len` is its capacity.
        unsafe {
            CertGetCertificateContextProperty(
                ctx,
                CERT_SHA1_HASH_PROP_ID,
                Some(hash.as_mut_ptr() as *mut c_void),
                &mut len,
            )
        }
        .ok()?;
        let len = (len as usize).min(hash.len());
        Some(hex::encode_upper(&hash[..len]))
    }

    /// CryptoAPI stores serial numbers little-endian. Display them big-endian.
    fn serial_hex(blob: &CRYPT_INTEGER_BLOB) -> Option<String> {
        if blob.cbData == 0 || blob.pbData.is_null() {
            return None;
        }
        // SAFETY: CryptoAPI guarantees `pbData` holds `cbData` bytes while the
        // certificate context is alive.
        let bytes = unsafe { slice::from_raw_parts(blob.pbData, blob.cbData as usize) };
        let reversed: Vec<u8> = bytes.iter().rev().copied().collect();
        Some(hex::encode_upper(reversed))
    }

    fn digest_name(oid: &windows::core::PSTR) -> Option<String> {
        let oid = pstr_to_string(oid)?;
        let name = match oid.as_str() {
            "2.16.840.1.101.3.4.2.1" => "sha256".to_string(),
            "2.16.840.1.101.3.4.2.2" => "sha384".to_string(),
            "2.16.840.1.101.3.4.2.3" => "sha512".to_string(),
            "1.3.14.3.2.26" => "sha1".to_string(),
            "1.2.840.113549.2.5" => "md5".to_string(),
            // Unknown algorithms are reported by OID rather than dropped.
            _ => oid,
        };
        Some(name)
    }

    fn pstr_to_string(value: &windows::core::PSTR) -> Option<String> {
        if value.0.is_null() {
            return None;
        }
        // SAFETY: CryptoAPI OIDs are NUL-terminated ASCII strings that live as
        // long as the decoded message they came from.
        let cstr = unsafe { CStr::from_ptr(value.0 as *const c_char) };
        Some(cstr.to_string_lossy().into_owned())
    }

    fn filetime_ms(ft: FILETIME) -> f64 {
        let ticks = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
        ticks as f64 / 10_000.0 - FILETIME_UNIX_EPOCH_MS
    }

    /// Reads a Crypt32 message parameter into an aligned buffer. Returns None on failure.
    fn crypt_msg_param(msg: *const c_void, param: u32, index: u32) -> Option<AlignedBytes> {
        let mut len = 0u32;
        // SAFETY: a NULL data pointer asks only for the required size. `len` is
        // a valid out-param. `msg` is an open message owned by the caller.
        unsafe { CryptMsgGetParam(msg, param, index, None, &mut len) }.ok()?;
        let mut buf = AlignedBytes::with_len(len as usize);
        // SAFETY: `buf` has at least `len` writable, 8-byte aligned bytes, and
        // `len` is the capacity on input.
        unsafe { CryptMsgGetParam(msg, param, index, Some(buf.as_mut_ptr()), &mut len) }.ok()?;
        buf.len = (len as usize).min(buf.len);
        Some(buf)
    }

    /// Returns the raw DER value blobs of every attribute with the given OID.
    fn attr_values(attrs: &CRYPT_ATTRIBUTES, oid: &[u8]) -> Vec<Vec<u8>> {
        let mut found = Vec::new();
        if attrs.cAttr == 0 || attrs.rgAttr.is_null() {
            return found;
        }
        // SAFETY: rgAttr points at cAttr entries inside the decoded signer info.
        let list = unsafe { slice::from_raw_parts(attrs.rgAttr, attrs.cAttr as usize) };
        for attr in list {
            let Some(name) = pstr_to_string(&attr.pszObjId) else {
                continue;
            };
            if name.as_bytes() != oid {
                continue;
            }
            if attr.cValue == 0 || attr.rgValue.is_null() {
                continue;
            }
            // SAFETY: rgValue points at cValue CRYPT_INTEGER_BLOB entries inside the
            // decoded signer info.
            let values = unsafe { slice::from_raw_parts(attr.rgValue, attr.cValue as usize) };
            for value in values {
                if value.cbData == 0 || value.pbData.is_null() {
                    continue;
                }
                // SAFETY: each blob points at `cbData` bytes of the decoded message.
                let bytes = unsafe { slice::from_raw_parts(value.pbData, value.cbData as usize) };
                found.push(bytes.to_vec());
            }
        }
        found
    }

    fn signer_timestamp(info: &CMSG_SIGNER_INFO) -> Option<f64> {
        for token in attr_values(&info.UnauthAttrs, OID_RFC3161_TIMESTAMP) {
            if let Some(ms) = rfc3161_gen_time(&token) {
                return Some(ms);
            }
        }
        for counter in attr_values(&info.UnauthAttrs, OID_COUNTERSIGNATURE) {
            if let Some(ms) = countersignature_time(&counter) {
                return Some(ms);
            }
        }
        None
    }

    /// RFC 3161 token: a PKCS#7 SignedData whose content is a TSTInfo.
    fn rfc3161_gen_time(token: &[u8]) -> Option<f64> {
        let pkcs7 = Pkcs7::from_blob(token)?;
        let content = crypt_msg_param(pkcs7.msg, CMSG_CONTENT_PARAM, 0)?;
        tst_info_gen_time(content.bytes())
    }

    /// TSTInfo ::= SEQUENCE { version, policy, messageImprint, serialNumber, genTime, ... }
    fn tst_info_gen_time(der: &[u8]) -> Option<f64> {
        let (tag, body, _) = der_element(der)?;
        if tag != 0x30 {
            return None;
        }
        let mut rest = body;
        for _ in 0..4 {
            let (_, _, next) = der_element(rest)?;
            rest = next;
        }
        let (tag, value, _) = der_element(rest)?;
        if tag != 0x18 {
            return None;
        }
        generalized_time_ms(value)
    }

    /// Legacy countersignature: an encoded SignerInfo. Its authenticated signingTime is the stamp.
    fn countersignature_time(encoded: &[u8]) -> Option<f64> {
        let mut len = 0u32;
        // SAFETY: a NULL output asks only for the decoded size. `len` is a valid out-param.
        unsafe {
            CryptDecodeObjectEx(
                PKCS_7_ASN_ENCODING,
                PKCS7_SIGNER_INFO,
                encoded,
                0,
                None,
                None,
                &mut len,
            )
        }
        .ok()?;
        let mut buf = AlignedBytes::with_len(len as usize);
        // SAFETY: `buf` holds `len` writable, 8-byte aligned bytes, and `len`
        // is its capacity. The decoded CMSG_SIGNER_INFO points into `buf`.
        unsafe {
            CryptDecodeObjectEx(
                PKCS_7_ASN_ENCODING,
                PKCS7_SIGNER_INFO,
                encoded,
                0,
                None,
                Some(buf.as_mut_ptr()),
                &mut len,
            )
        }
        .ok()?;
        // SAFETY: CryptDecodeObjectEx wrote a CMSG_SIGNER_INFO into the aligned
        // buffer, which stays alive for this function.
        let info = unsafe { &*(buf.as_ptr() as *const CMSG_SIGNER_INFO) };
        attr_values(&info.AuthAttrs, OID_SIGNING_TIME)
            .first()
            .and_then(|value| utc_time_ms(value))
    }

    fn utc_time_ms(der: &[u8]) -> Option<f64> {
        let (tag, value, _) = der_element(der)?;
        match tag {
            0x17 => utc_time_string_ms(value),
            0x18 => generalized_time_ms(value),
            _ => None,
        }
    }

    fn generalized_time_ms(value: &[u8]) -> Option<f64> {
        let text = std::str::from_utf8(value).ok()?;
        let body = text.strip_suffix('Z')?;
        let whole = body.split('.').next()?;
        if whole.len() != 14 || !whole.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        time_fields_ms(whole)
    }

    fn utc_time_string_ms(value: &[u8]) -> Option<f64> {
        let text = std::str::from_utf8(value).ok()?;
        let body = text.strip_suffix('Z')?;
        if body.len() != 12 || !body.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        // RFC 5280: two-digit years 50-99 are 1950-1999, 00-49 are 2000-2049.
        let yy: u32 = body[0..2].parse().ok()?;
        let century = if yy < 50 { "20" } else { "19" };
        time_fields_ms(&format!("{century}{body}"))
    }

    /// Parses YYYYMMDDHHMMSS (14 ASCII digits) as UTC into Unix milliseconds.
    fn time_fields_ms(digits: &str) -> Option<f64> {
        let field = |start: usize, end: usize| -> Option<u32> { digits[start..end].parse().ok() };
        let year = field(0, 4)? as i32;
        let month = field(4, 6)?;
        let day = field(6, 8)?;
        let hour = field(8, 10)?;
        let minute = field(10, 12)?;
        let second = field(12, 14)?;
        let date = chrono::NaiveDate::from_ymd_opt(year, month, day)?;
        let time = date.and_hms_opt(hour, minute, second)?;
        Some(time.and_utc().timestamp_millis() as f64)
    }

    /// Reads one DER TLV. Returns (tag, content, remainder).
    fn der_element(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
        let (&tag, rest) = input.split_first()?;
        let (&first, rest) = rest.split_first()?;
        let (len, rest) = if first & 0x80 == 0 {
            (first as usize, rest)
        } else {
            let count = (first & 0x7f) as usize;
            if count == 0 || count > size_of::<usize>() || rest.len() < count {
                return None;
            }
            let len = rest[..count]
                .iter()
                .fold(0usize, |acc, byte| (acc << 8) | *byte as usize);
            (len, &rest[count..])
        };
        if rest.len() < len {
            return None;
        }
        Some((tag, &rest[..len], &rest[len..]))
    }
}

#[cfg(target_os = "macos")]
mod codesign {
    use super::{CodeSignatureInfo, CodeSigner, SignatureStatus};
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::date::CFDate;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::{CFString, CFStringRef};
    use core_foundation::url::CFURL;
    use security_framework_sys::base::SecCertificateRef;
    use security_framework_sys::certificate::SecCertificateCopySubjectSummary;
    use security_framework_sys::code_signing::{
        SecStaticCodeCheckValidity, SecStaticCodeCreateWithPath, SecStaticCodeRef,
    };
    use std::ffi::c_void;
    use std::path::Path;
    use std::ptr::null_mut;

    /// errSecCSUnsigned: "code object is not signed at all".
    const ERR_SEC_CS_UNSIGNED: i32 = -67062;
    /// kSecCSSigningInformation, from CSCommon.h.
    const CS_SIGNING_INFORMATION: u32 = 1 << 1;
    /// kSecCodeSignatureRuntime: hardened runtime bit in the code directory flags.
    const CS_RUNTIME_FLAG: i64 = 0x10000;
    /// Seconds between the CFAbsoluteTime epoch (2001-01-01) and 1970-01-01.
    const CF_ABSOLUTE_TIME_UNIX_OFFSET: f64 = 978_307_200.0;

    #[allow(non_upper_case_globals, non_snake_case)]
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        static kSecCodeInfoIdentifier: CFStringRef;
        static kSecCodeInfoTeamIdentifier: CFStringRef;
        static kSecCodeInfoFlags: CFStringRef;
        static kSecCodeInfoCertificates: CFStringRef;
        static kSecCodeInfoTime: CFStringRef;

        fn SecCodeCopySigningInformation(
            code: SecStaticCodeRef,
            flags: u32,
            information: *mut CFDictionaryRef,
        ) -> i32;
    }

    fn is_bundle_dir(path: &Path) -> bool {
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .is_some_and(|ext| {
                matches!(
                    ext.as_str(),
                    "app" | "framework" | "bundle" | "appex" | "kext"
                )
            })
    }

    pub(super) fn inspect(path: &Path) -> CodeSignatureInfo {
        let is_dir = path.is_dir();
        if is_dir && !is_bundle_dir(path) {
            return CodeSignatureInfo::unsupported(
                "Only app bundles, frameworks, plug-ins and kernel extensions carry code signatures on macOS.",
            );
        }
        let Some(url) = CFURL::from_path(path, is_dir) else {
            return CodeSignatureInfo::unsupported("macOS could not build a URL for this item.");
        };

        let mut code: SecStaticCodeRef = null_mut();
        // SAFETY: `url` is a live CFURL for this call, and `code` is a valid out-pointer.
        let status =
            unsafe { SecStaticCodeCreateWithPath(url.as_concrete_TypeRef(), 0, &mut code) };
        if status != 0 || code.is_null() {
            return CodeSignatureInfo::unsupported(&format!(
                "macOS could not read this item as code (OSStatus {status})."
            ));
        }
        let raw = code;
        // SAFETY: SecStaticCodeCreateWithPath returned a +1 reference that this
        // guard releases exactly once.
        let _code_guard = unsafe { CFType::wrap_under_create_rule(raw as *const c_void) };

        // SAFETY: `raw` is a valid SecStaticCodeRef kept alive by `_code_guard`. A
        // NULL requirement checks signature validity only.
        let validity = unsafe { SecStaticCodeCheckValidity(raw, 0, null_mut()) };
        if validity == ERR_SEC_CS_UNSIGNED {
            return CodeSignatureInfo {
                supported: true,
                signed: false,
                status: SignatureStatus::Unsigned,
                status_message: Some("The item has no code signature.".to_string()),
                signers: Vec::new(),
                identifier: None,
                team_id: None,
                hardened_runtime: None,
            };
        }
        if validity != 0 {
            return CodeSignatureInfo {
                supported: true,
                signed: true,
                status: SignatureStatus::Invalid,
                status_message: Some(format!(
                    "The code signature failed validation (OSStatus {validity})."
                )),
                signers: Vec::new(),
                identifier: None,
                team_id: None,
                hardened_runtime: None,
            };
        }

        let mut info: CFDictionaryRef = std::ptr::null();
        // SAFETY: `raw` is valid, and `info` receives a +1 dictionary on success.
        let status =
            unsafe { SecCodeCopySigningInformation(raw, CS_SIGNING_INFORMATION, &mut info) };
        if status != 0 || info.is_null() {
            return CodeSignatureInfo {
                supported: true,
                signed: true,
                status: SignatureStatus::Error,
                status_message: Some(format!(
                    "macOS could not read the signing information (OSStatus {status})."
                )),
                signers: Vec::new(),
                identifier: None,
                team_id: None,
                hardened_runtime: None,
            };
        }
        // SAFETY: the Copy rule gave us ownership of `info`, released exactly once here.
        let info = unsafe { CFDictionary::<CFType, CFType>::wrap_under_create_rule(info) };

        // SAFETY: reading the framework's exported CFString key constants.
        let (identifier_key, team_key, flags_key, certs_key, time_key) = unsafe {
            (
                kSecCodeInfoIdentifier,
                kSecCodeInfoTeamIdentifier,
                kSecCodeInfoFlags,
                kSecCodeInfoCertificates,
                kSecCodeInfoTime,
            )
        };

        let identifier = value(&info, identifier_key)
            .and_then(|v| v.downcast::<CFString>())
            .map(|s| s.to_string());
        let team_id = value(&info, team_key)
            .and_then(|v| v.downcast::<CFString>())
            .map(|s| s.to_string());
        let hardened_runtime = value(&info, flags_key)
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_i64())
            .map(|flags| flags & CS_RUNTIME_FLAG != 0);
        let signing_time_ms = value(&info, time_key)
            .and_then(|v| v.downcast::<CFDate>())
            .map(|d| (d.abs_time() + CF_ABSOLUTE_TIME_UNIX_OFFSET) * 1000.0);

        // Certificate chain order: leaf first, then its issuer.
        let mut signers = Vec::new();
        if let Some(certs) =
            value(&info, certs_key).and_then(|v| v.downcast::<CFArray<*const c_void>>())
        {
            let leaf = certs.get(0).map(|c| *c);
            let issuer = certs.get(1).map(|c| *c);
            if let Some(leaf) = leaf {
                if let Some(name) = cert_summary(leaf) {
                    signers.push(CodeSigner {
                        name,
                        issuer: issuer.and_then(cert_summary),
                        timestamp: signing_time_ms,
                        ..Default::default()
                    });
                }
            }
        }

        CodeSignatureInfo {
            supported: true,
            signed: true,
            status: SignatureStatus::Valid,
            status_message: None,
            signers,
            identifier,
            team_id,
            hardened_runtime,
        }
    }

    /// Looks up a key in the signing dictionary and returns an owned, retained value.
    fn value(info: &CFDictionary<CFType, CFType>, key: CFStringRef) -> Option<CFType> {
        let found = info.find(key as *const c_void)?;
        // SAFETY: `found` borrows a value that the dictionary owns. get_rule
        // retains it, so the returned wrapper releases only its own reference.
        Some(unsafe { CFType::wrap_under_get_rule((*found).as_CFTypeRef()) })
    }

    fn cert_summary(cert: *const c_void) -> Option<String> {
        // SAFETY: `cert` is a SecCertificateRef borrowed from the signing
        // dictionary, which outlives this call. The return value is +1 or NULL.
        let summary = unsafe { SecCertificateCopySubjectSummary(cert as SecCertificateRef) };
        if summary.is_null() {
            return None;
        }
        // SAFETY: the Create rule gives us ownership of a non-null CFString,
        // released exactly once by the wrapper.
        Some(unsafe { CFString::wrap_under_create_rule(summary) }.to_string())
    }
}

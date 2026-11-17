//! Thin, project-owned WASM binding over `vodozemac` 0.11.2 Olm (P2-02, DEC-018).
//!
//! Security boundary (`DEC-018`, `FR-SEC-001`..`FR-SEC-004`, `FR-SEC-006`):
//! - Exposes only the small account/session surface needed for 1:1 Olm messaging.
//! - Private identity, sender, one-time, fallback, and ratchet keys remain inside
//!   WASM memory handles and are NEVER exported in raw form to JavaScript.
//! - Account and session persistence crosses the boundary only as encrypted
//!   `vodozemac` pickles keyed with a 32-byte key supplied by the caller.
//! - Randomness is supplied by the host CSPRNG (`crypto.getRandomValues`) and
//!   checked against degenerate/all-zero output before use.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::slice;

use serde_json::json;
use vodozemac::olm::{
    Account, AccountPickle, IdentityKeys, InboundCreationResult, OlmMessage, Session,
    SessionConfig, SessionPickle,
};
use vodozemac::{Curve25519PublicKey, KeyId};

#[link(wasm_import_module = "env")]
extern "C" {
    fn host_fill_random(ptr: *mut u8, len: usize) -> i32;
}

#[no_mangle]
pub unsafe extern "Rust" fn __getrandom_v03_custom(
    dest: *mut u8,
    len: usize,
) -> Result<(), getrandom::Error> {
    if len == 0 {
        return Ok(());
    }
    if dest.is_null() {
        return Err(getrandom::Error::new_custom(1));
    }
    let rc = unsafe { host_fill_random(dest, len) };
    if rc != 0 {
        return Err(getrandom::Error::new_custom(2));
    }
    let bytes = unsafe { slice::from_raw_parts(dest, len) };
    // Reject degenerate all-identical entropy buffers on key-sized requests (FR-SEC-004).
    if len >= 16 {
        let first = bytes[0];
        if bytes.iter().all(|&b| b == first) {
            return Err(getrandom::Error::new_custom(3));
        }
    }
    Ok(())
}

fn verify_csprng_ready() -> Result<(), &'static str> {
    let mut probe = [0u8; 32];
    getrandom::fill(&mut probe)
        .map_err(|_| "CSPRNG failure or degenerate randomness detected (FR-SEC-004).")
}

struct WasmState {
    next_handle: u32,
    accounts: BTreeMap<u32, Account>,
    sessions: BTreeMap<u32, Session>,
    last_result: Vec<u8>,
}

impl WasmState {
    fn new() -> Self {
        Self {
            next_handle: 1,
            accounts: BTreeMap::new(),
            sessions: BTreeMap::new(),
            last_result: Vec::new(),
        }
    }

    fn alloc_handle(&mut self) -> u32 {
        let h = self.next_handle;
        self.next_handle = self.next_handle.wrapping_add(1).max(1);
        h
    }
}

thread_local! {
    static STATE: RefCell<WasmState> = RefCell::new(WasmState::new());
}

fn write_ok(value: serde_json::Value) -> i32 {
    let serialized = serde_json::to_vec(&json!({
        "ok": true,
        "data": value,
    }))
    .unwrap_or_else(|_| b"{\"ok\":false,\"code\":\"INTERNAL\",\"message\":\"serialize failed\"}".to_vec());
    STATE.with(|s| {
        s.borrow_mut().last_result = serialized;
    });
    0
}

fn write_err(code: &str, message: &str) -> i32 {
    let serialized = serde_json::to_vec(&json!({
        "ok": false,
        "code": code,
        "message": message,
    }))
    .unwrap_or_else(|_| b"{\"ok\":false,\"code\":\"INTERNAL\",\"message\":\"error\"}".to_vec());
    STATE.with(|s| {
        s.borrow_mut().last_result = serialized;
    });
    -1
}

unsafe fn read_bytes<'a>(ptr: *const u8, len: usize) -> Result<&'a [u8], &'static str> {
    if len == 0 {
        return Ok(&[]);
    }
    if ptr.is_null() {
        return Err("Null pointer passed to WASM boundary.");
    }
    Ok(unsafe { slice::from_raw_parts(ptr, len) })
}

unsafe fn read_str<'a>(ptr: *const u8, len: usize) -> Result<&'a str, &'static str> {
    let bytes = unsafe { read_bytes(ptr, len)? };
    std::str::from_utf8(bytes).map_err(|_| "Invalid UTF-8 string passed to WASM boundary.")
}

unsafe fn read_key_32(ptr: *const u8, len: usize) -> Result<[u8; 32], &'static str> {
    let bytes = unsafe { read_bytes(ptr, len)? };
    if bytes.len() != 32 {
        return Err("Pickle encryption key must be exactly 32 bytes.");
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(bytes);
    Ok(out)
}

#[no_mangle]
pub extern "C" fn wasm_alloc(len: usize) -> *mut u8 {
    if len == 0 || len > 1024 * 1024 {
        return std::ptr::null_mut();
    }
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[no_mangle]
pub unsafe extern "C" fn wasm_dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 || len > 1024 * 1024 {
        return;
    }
    unsafe {
        let mut buf = Vec::from_raw_parts(ptr, 0, len);
        buf.fill(0);
        drop(buf);
    }
}

#[no_mangle]
pub extern "C" fn wasm_result_ptr() -> *const u8 {
    STATE.with(|s| s.borrow().last_result.as_ptr())
}

#[no_mangle]
pub extern "C" fn wasm_result_len() -> usize {
    STATE.with(|s| s.borrow().last_result.len())
}

#[no_mangle]
pub extern "C" fn olm_library_info() -> i32 {
    write_ok(json!({
        "library": "vodozemac",
        "version": "0.11.2",
        "protocolVersion": "olm-vodozemac-v1"
    }))
}

fn account_summary(handle: u32, account: &Account) -> serde_json::Value {
    let IdentityKeys {
        ed25519,
        curve25519,
    } = account.identity_keys();
    json!({
        "accountHandle": handle,
        "identityKey": ed25519.to_base64(),
        "senderKey": curve25519.to_base64(),
        "maxOneTimeKeys": account.max_number_of_one_time_keys(),
    })
}

fn format_key_map(keys: HashMap<KeyId, Curve25519PublicKey>) -> Vec<serde_json::Value> {
    let mut entries: Vec<(String, String)> = keys
        .into_iter()
        .map(|(key_id, pubkey)| (key_id.to_base64(), pubkey.to_base64()))
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
        .into_iter()
        .map(|(key_id, key)| {
            json!({
                "keyId": key_id,
                "key": key,
            })
        })
        .collect()
}

#[no_mangle]
pub extern "C" fn olm_account_new() -> i32 {
    if let Err(msg) = verify_csprng_ready() {
        return write_err("INSECURE_RANDOMNESS", msg);
    }
    let account = Account::new();
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let handle = st.alloc_handle();
        let summary = account_summary(handle, &account);
        st.accounts.insert(handle, account);
        drop(st);
        write_ok(summary)
    })
}

#[no_mangle]
pub extern "C" fn olm_account_free(handle: u32) -> i32 {
    let removed = STATE.with(|s| s.borrow_mut().accounts.remove(&handle).is_some());
    if removed {
        write_ok(json!({ "freed": true }))
    } else {
        write_err("MISSING_KEY_MATERIAL", "Olm account handle is not initialized.")
    }
}

#[no_mangle]
pub extern "C" fn olm_account_generate_one_time_keys(handle: u32, count: u32) -> i32 {
    if count == 0 || count > 100 {
        return write_err("INVALID_ENVELOPE", "One-time key count must be between 1 and 100.");
    }
    if let Err(msg) = verify_csprng_ready() {
        return write_err("INSECURE_RANDOMNESS", msg);
    }
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let Some(account) = st.accounts.get_mut(&handle) else {
            drop(st);
            return write_err("MISSING_KEY_MATERIAL", "Olm account handle is not initialized.");
        };
        account.generate_one_time_keys(count as usize);
        let keys = format_key_map(account.one_time_keys());
        drop(st);
        write_ok(json!({ "oneTimeKeys": keys }))
    })
}

#[no_mangle]
pub extern "C" fn olm_account_one_time_keys(handle: u32) -> i32 {
    STATE.with(|s| {
        let st = s.borrow();
        let Some(account) = st.accounts.get(&handle) else {
            drop(st);
            return write_err("MISSING_KEY_MATERIAL", "Olm account handle is not initialized.");
        };
        let keys = format_key_map(account.one_time_keys());
        drop(st);
        write_ok(json!({ "oneTimeKeys": keys }))
    })
}

#[no_mangle]
pub extern "C" fn olm_account_generate_fallback_key(handle: u32) -> i32 {
    if let Err(msg) = verify_csprng_ready() {
        return write_err("INSECURE_RANDOMNESS", msg);
    }
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let Some(account) = st.accounts.get_mut(&handle) else {
            drop(st);
            return write_err("MISSING_KEY_MATERIAL", "Olm account handle is not initialized.");
        };
        account.generate_fallback_key();
        let mut fallback = format_key_map(account.fallback_key());
        drop(st);
        if let Some(first) = fallback.pop() {
            write_ok(json!({ "fallbackKey": first }))
        } else {
            write_err("MISSING_KEY_MATERIAL", "Failed to generate Olm fallback key.")
        }
    })
}

#[no_mangle]
pub extern "C" fn olm_account_mark_keys_as_published(handle: u32) -> i32 {
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let Some(account) = st.accounts.get_mut(&handle) else {
            drop(st);
            return write_err("MISSING_KEY_MATERIAL", "Olm account handle is not initialized.");
        };
        account.mark_keys_as_published();
        drop(st);
        write_ok(json!({ "published": true }))
    })
}

#[no_mangle]
pub unsafe extern "C" fn olm_account_pickle(
    handle: u32,
    key_ptr: *const u8,
    key_len: usize,
) -> i32 {
    let key = match unsafe { read_key_32(key_ptr, key_len) } {
        Ok(k) => k,
        Err(msg) => return write_err("PICKLE_DECRYPTION_FAILED", msg),
    };
    STATE.with(|s| {
        let st = s.borrow();
        let Some(account) = st.accounts.get(&handle) else {
            drop(st);
            return write_err("MISSING_KEY_MATERIAL", "Olm account handle is not initialized.");
        };
        let encrypted = account.pickle().encrypt(&key);
        drop(st);
        write_ok(json!({ "pickle": encrypted }))
    })
}

#[no_mangle]
pub unsafe extern "C" fn olm_account_from_pickle(
    pickle_ptr: *const u8,
    pickle_len: usize,
    key_ptr: *const u8,
    key_len: usize,
) -> i32 {
    let pickle_str = match unsafe { read_str(pickle_ptr, pickle_len) } {
        Ok(s) => s,
        Err(msg) => return write_err("PICKLE_DECRYPTION_FAILED", msg),
    };
    let key = match unsafe { read_key_32(key_ptr, key_len) } {
        Ok(k) => k,
        Err(msg) => return write_err("PICKLE_DECRYPTION_FAILED", msg),
    };
    let unpickled = match AccountPickle::from_encrypted(pickle_str, &key) {
        Ok(p) => Account::from_pickle(p),
        Err(_) => {
            return write_err(
                "PICKLE_DECRYPTION_FAILED",
                "Failed to unpickle Olm account with supplied key.",
            )
        }
    };
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let handle = st.alloc_handle();
        let summary = account_summary(handle, &unpickled);
        st.accounts.insert(handle, unpickled);
        drop(st);
        write_ok(summary)
    })
}

#[no_mangle]
pub unsafe extern "C" fn olm_create_outbound_session(
    account_handle: u32,
    peer_sender_key_ptr: *const u8,
    peer_sender_key_len: usize,
    peer_otk_ptr: *const u8,
    peer_otk_len: usize,
) -> i32 {
    let peer_sender_str = match unsafe { read_str(peer_sender_key_ptr, peer_sender_key_len) } {
        Ok(s) => s,
        Err(msg) => return write_err("PEER_KEY_MISMATCH", msg),
    };
    let peer_otk_str = match unsafe { read_str(peer_otk_ptr, peer_otk_len) } {
        Ok(s) => s,
        Err(msg) => return write_err("PEER_KEY_MISMATCH", msg),
    };
    let Ok(peer_sender_key) = Curve25519PublicKey::from_base64(peer_sender_str) else {
        return write_err("PEER_KEY_MISMATCH", "Invalid peer Curve25519 sender key.");
    };
    let Ok(peer_otk) = Curve25519PublicKey::from_base64(peer_otk_str) else {
        return write_err("PEER_KEY_MISMATCH", "Invalid peer Curve25519 prekey.");
    };
    if let Err(msg) = verify_csprng_ready() {
        return write_err("INSECURE_RANDOMNESS", msg);
    }

    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let Some(account) = st.accounts.get(&account_handle) else {
            drop(st);
            return write_err("MISSING_KEY_MATERIAL", "Olm account handle is not initialized.");
        };
        let session = match account.create_outbound_session(
            SessionConfig::version_1(),
            peer_sender_key,
            peer_otk,
        ) {
            Ok(s) => s,
            Err(_) => {
                drop(st);
                return write_err(
                    "INSECURE_RANDOMNESS",
                    "CSPRNG failure while creating outbound Olm session.",
                );
            }
        };
        let session_id = session.session_id();
        let session_handle = st.alloc_handle();
        st.sessions.insert(session_handle, session);
        drop(st);
        write_ok(json!({
            "sessionHandle": session_handle,
            "sessionId": session_id,
        }))
    })
}

#[no_mangle]
pub unsafe extern "C" fn olm_create_inbound_session(
    account_handle: u32,
    peer_sender_key_ptr: *const u8,
    peer_sender_key_len: usize,
    ciphertext_ptr: *const u8,
    ciphertext_len: usize,
) -> i32 {
    let peer_sender_str = match unsafe { read_str(peer_sender_key_ptr, peer_sender_key_len) } {
        Ok(s) => s,
        Err(msg) => return write_err("PEER_KEY_MISMATCH", msg),
    };
    let Ok(peer_sender_key) = Curve25519PublicKey::from_base64(peer_sender_str) else {
        return write_err("PEER_KEY_MISMATCH", "Invalid peer Curve25519 sender key.");
    };
    let ciphertext = match unsafe { read_bytes(ciphertext_ptr, ciphertext_len) } {
        Ok(b) => b,
        Err(msg) => return write_err("TAMPERED_ENVELOPE", msg),
    };
    let olm_message = match OlmMessage::from_parts(0, ciphertext) {
        Ok(OlmMessage::PreKey(prekey)) => prekey,
        _ => {
            return write_err(
                "TAMPERED_ENVELOPE",
                "Malformed or tampered Olm PreKey message frame.",
            )
        }
    };

    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let Some(account) = st.accounts.get_mut(&account_handle) else {
            drop(st);
            return write_err("MISSING_KEY_MATERIAL", "Olm account handle is not initialized.");
        };
        let created: InboundCreationResult = match account.create_inbound_session(
            SessionConfig::version_1(),
            peer_sender_key,
            &olm_message,
        ) {
            Ok(res) => res,
            Err(err) => {
                let msg = err.to_string();
                drop(st);
                if msg.to_lowercase().contains("one-time") || msg.to_lowercase().contains("key") {
                    return write_err(
                        "MISSING_KEY_MATERIAL",
                        "No matching one-time or fallback prekey for inbound PreKey message.",
                    );
                }
                return write_err(
                    "TAMPERED_ENVELOPE",
                    "Inbound PreKey message failed Olm authentication.",
                );
            }
        };
        let session_id = created.session.session_id();
        let session_handle = st.alloc_handle();
        st.sessions.insert(session_handle, created.session);
        drop(st);
        write_ok(json!({
            "sessionHandle": session_handle,
            "sessionId": session_id,
            "plaintextBytes": created.plaintext,
        }))
    })
}

#[no_mangle]
pub extern "C" fn olm_session_free(session_handle: u32) -> i32 {
    let removed = STATE.with(|s| s.borrow_mut().sessions.remove(&session_handle).is_some());
    if removed {
        write_ok(json!({ "freed": true }))
    } else {
        write_err("MISSING_KEY_MATERIAL", "Olm session handle is not initialized.")
    }
}

#[no_mangle]
pub unsafe extern "C" fn olm_session_encrypt(
    session_handle: u32,
    plaintext_ptr: *const u8,
    plaintext_len: usize,
) -> i32 {
    let plaintext = match unsafe { read_str(plaintext_ptr, plaintext_len) } {
        Ok(s) => s,
        Err(msg) => return write_err("INVALID_ENVELOPE", msg),
    };
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let Some(session) = st.sessions.get_mut(&session_handle) else {
            drop(st);
            return write_err("MISSING_KEY_MATERIAL", "Olm session handle is not initialized.");
        };
        let message = match session.encrypt(plaintext) {
            Ok(m) => m,
            Err(_) => {
                drop(st);
                return write_err(
                    "INSECURE_RANDOMNESS",
                    "CSPRNG failure while encrypting Olm message.",
                );
            }
        };
        let (message_type, ciphertext_bytes) = message.to_parts();
        let session_id = session.session_id();
        drop(st);
        write_ok(json!({
            "sessionId": session_id,
            "messageType": message_type,
            "ciphertextBytes": ciphertext_bytes,
        }))
    })
}

#[no_mangle]
pub unsafe extern "C" fn olm_session_decrypt(
    session_handle: u32,
    message_type: u32,
    ciphertext_ptr: *const u8,
    ciphertext_len: usize,
) -> i32 {
    let ciphertext = match unsafe { read_bytes(ciphertext_ptr, ciphertext_len) } {
        Ok(b) => b,
        Err(msg) => return write_err("TAMPERED_ENVELOPE", msg),
    };
    let olm_message = match OlmMessage::from_parts(message_type as usize, ciphertext) {
        Ok(m) => m,
        Err(_) => {
            return write_err(
                "TAMPERED_ENVELOPE",
                "Malformed or truncated Olm ciphertext frame.",
            )
        }
    };
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let Some(session) = st.sessions.get_mut(&session_handle) else {
            drop(st);
            return write_err("MISSING_KEY_MATERIAL", "Olm session handle is not initialized.");
        };
        match session.decrypt(&olm_message) {
            Ok(plaintext_bytes) => {
                let session_id = session.session_id();
                drop(st);
                write_ok(json!({
                    "sessionId": session_id,
                    "plaintextBytes": plaintext_bytes,
                }))
            }
            Err(_) => {
                drop(st);
                write_err(
                    "TAMPERED_ENVELOPE",
                    "Olm message authentication or ratchet verification failed.",
                )
            }
        }
    })
}

#[no_mangle]
pub unsafe extern "C" fn olm_session_pickle(
    session_handle: u32,
    key_ptr: *const u8,
    key_len: usize,
) -> i32 {
    let key = match unsafe { read_key_32(key_ptr, key_len) } {
        Ok(k) => k,
        Err(msg) => return write_err("PICKLE_DECRYPTION_FAILED", msg),
    };
    STATE.with(|s| {
        let st = s.borrow();
        let Some(session) = st.sessions.get(&session_handle) else {
            drop(st);
            return write_err("MISSING_KEY_MATERIAL", "Olm session handle is not initialized.");
        };
        let session_id = session.session_id();
        let encrypted = session.pickle().encrypt(&key);
        drop(st);
        write_ok(json!({
            "sessionId": session_id,
            "pickle": encrypted,
        }))
    })
}

#[no_mangle]
pub unsafe extern "C" fn olm_session_from_pickle(
    pickle_ptr: *const u8,
    pickle_len: usize,
    key_ptr: *const u8,
    key_len: usize,
) -> i32 {
    let pickle_str = match unsafe { read_str(pickle_ptr, pickle_len) } {
        Ok(s) => s,
        Err(msg) => return write_err("PICKLE_DECRYPTION_FAILED", msg),
    };
    let key = match unsafe { read_key_32(key_ptr, key_len) } {
        Ok(k) => k,
        Err(msg) => return write_err("PICKLE_DECRYPTION_FAILED", msg),
    };
    let unpickled = match SessionPickle::from_encrypted(pickle_str, &key) {
        Ok(p) => Session::from_pickle(p),
        Err(_) => {
            return write_err(
                "PICKLE_DECRYPTION_FAILED",
                "Failed to unpickle Olm session with supplied key.",
            )
        }
    };
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let session_id = unpickled.session_id();
        let has_received = unpickled.has_received_message();
        let handle = st.alloc_handle();
        st.sessions.insert(handle, unpickled);
        drop(st);
        write_ok(json!({
            "sessionHandle": handle,
            "sessionId": session_id,
            "hasReceivedMessage": has_received,
        }))
    })
}

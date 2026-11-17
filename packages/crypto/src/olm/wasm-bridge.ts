import { base64UrlEncode } from "../device/encoding.js";
import { OlmCryptoError, type OlmErrorCode } from "./errors.js";
import {
  OLM_MESSAGE_TYPE_NORMAL,
  OLM_MESSAGE_TYPE_PREKEY,
  type OlmMessageType,
} from "./envelope.js";
import { getCompiledOlmWasmBytes } from "./wasm-binary.js";

/**
 * Thin TypeScript bridge over the project-owned `vodozemac` 0.11.2 WASM binding
 * (`packages/crypto/wasm/`, P2-02, DEC-018).
 *
 * Security invariants:
 * - Private keys remain inside WASM linear memory and never cross into JS (`FR-SEC-002`).
 * - Randomness is supplied by `crypto.getRandomValues` (or a test-supplied CSPRNG)
 *   and checked against missing/all-constant entropy (`FR-SEC-004`).
 * - Account and session persistence crosses the boundary only as encrypted
 *   `vodozemac` pickles keyed with a 32-byte key (`FR-SEC-006`).
 */

export type RandomSource = (target: Uint8Array) => Uint8Array;

export interface OlmWasmBridgeOptions {
  wasmBytes?: Uint8Array;
  randomSource?: RandomSource;
}

export interface WasmLibraryInfo {
  library: "vodozemac";
  version: string;
  protocolVersion: "olm-vodozemac-v1";
}

export interface WasmAccountSummary {
  accountHandle: number;
  identityKey: string;
  senderKey: string;
  maxOneTimeKeys: number;
}

export interface WasmPublicKeyEntry {
  keyId: string;
  key: string;
}

export interface WasmOutboundSessionSummary {
  sessionHandle: number;
  sessionId: string;
}

export interface WasmInboundSessionSummary {
  sessionHandle: number;
  sessionId: string;
  plaintext: string;
}

export interface WasmEncryptOutput {
  sessionId: string;
  messageType: OlmMessageType;
  ciphertext: string;
}

export interface WasmDecryptOutput {
  sessionId: string;
  plaintext: string;
}

export interface WasmSessionFromPickleSummary {
  sessionHandle: number;
  sessionId: string;
  hasReceivedMessage: boolean;
}

interface RawWasmExports {
  memory: WebAssembly.Memory;
  wasm_alloc: (len: number) => number;
  wasm_dealloc: (ptr: number, len: number) => void;
  wasm_result_ptr: () => number;
  wasm_result_len: () => number;
  olm_library_info: () => number;
  olm_account_new: () => number;
  olm_account_free: (handle: number) => number;
  olm_account_generate_one_time_keys: (handle: number, count: number) => number;
  olm_account_one_time_keys: (handle: number) => number;
  olm_account_generate_fallback_key: (handle: number) => number;
  olm_account_mark_keys_as_published: (handle: number) => number;
  olm_account_pickle: (handle: number, keyPtr: number, keyLen: number) => number;
  olm_account_from_pickle: (
    picklePtr: number,
    pickleLen: number,
    keyPtr: number,
    keyLen: number,
  ) => number;
  olm_create_outbound_session: (
    accountHandle: number,
    peerSenderPtr: number,
    peerSenderLen: number,
    peerOtkPtr: number,
    peerOtkLen: number,
  ) => number;
  olm_create_inbound_session: (
    accountHandle: number,
    peerSenderPtr: number,
    peerSenderLen: number,
    ciphertextPtr: number,
    ciphertextLen: number,
  ) => number;
  olm_session_free: (sessionHandle: number) => number;
  olm_session_encrypt: (
    sessionHandle: number,
    plaintextPtr: number,
    plaintextLen: number,
  ) => number;
  olm_session_decrypt: (
    sessionHandle: number,
    messageType: number,
    ciphertextPtr: number,
    ciphertextLen: number,
  ) => number;
  olm_session_pickle: (sessionHandle: number, keyPtr: number, keyLen: number) => number;
  olm_session_from_pickle: (
    picklePtr: number,
    pickleLen: number,
    keyPtr: number,
    keyLen: number,
  ) => number;
}

type WasmEnvelopeResponse<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

function defaultRandomSource(target: Uint8Array): Uint8Array {
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new OlmCryptoError(
      "INSECURE_RANDOMNESS",
      "Web Crypto CSPRNG (crypto.getRandomValues) is unavailable.",
    );
  }
  return globalThis.crypto.getRandomValues(target);
}

function isConstantBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16) return false;
  const first = bytes[0];
  for (let i = 1; i < bytes.byteLength; i += 1) {
    if (bytes[i] !== first) return false;
  }
  return true;
}

function toBase64UrlKey(standardBase64: string): string {
  return standardBase64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toOneTimeKeyId(rawKeyId: string): string {
  const clean = toBase64UrlKey(rawKeyId);
  return clean.startsWith("otk_") ? clean : `otk_${clean}`;
}

function toFallbackKeyId(rawKeyId: string): string {
  const clean = toBase64UrlKey(rawKeyId);
  return clean.startsWith("fbk_") ? clean : `fbk_${clean}`;
}

function toStandardUnpaddedBase64Key(base64UrlOrStd: string): string {
  return base64UrlOrStd.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
}

function mapWasmErrorCode(code: string): OlmErrorCode {
  switch (code) {
    case "INSECURE_RANDOMNESS":
    case "MISSING_KEY_MATERIAL":
    case "UNSUPPORTED_PROTOCOL_VERSION":
    case "INVALID_ENVELOPE":
    case "PAYLOAD_TOO_LARGE":
    case "FORBIDDEN_FIELD":
    case "PEER_KEY_MISMATCH":
    case "PEER_KEY_CHANGE_BLOCKED":
    case "TAMPERED_ENVELOPE":
    case "REPLAYED_OR_DUPLICATE_MESSAGE":
    case "SESSION_ROLLBACK_DETECTED":
    case "PICKLE_DECRYPTION_FAILED":
      return code;
    default:
      return "WASM_UNAVAILABLE";
  }
}

export class OlmWasmBridge {
  private constructor(private readonly exports: RawWasmExports) {}

  static async create(options: OlmWasmBridgeOptions = {}): Promise<OlmWasmBridge> {
    if (typeof globalThis.WebAssembly === "undefined") {
      throw new OlmCryptoError("WASM_UNAVAILABLE", "WebAssembly runtime is unavailable.");
    }
    const randomSource = options.randomSource ?? defaultRandomSource;
    const wasmBytes = options.wasmBytes ?? getCompiledOlmWasmBytes();
    if (!wasmBytes || wasmBytes.byteLength < 8) {
      throw new OlmCryptoError("WASM_UNAVAILABLE", "Olm WASM binary is missing or invalid.");
    }

    let instanceMemory: WebAssembly.Memory | null = null;
    const imports: WebAssembly.Imports = {
      env: {
        host_fill_random: (ptr: number, len: number): number => {
          try {
            if (!instanceMemory || ptr <= 0 || len < 0) return -1;
            if (len === 0) return 0;
            const temp = new Uint8Array(len);
            randomSource(temp);
            if (isConstantBytes(temp)) {
              return -2;
            }
            const view = new Uint8Array(instanceMemory.buffer, ptr, len);
            view.set(temp);
            temp.fill(0);
            return 0;
          } catch {
            return -1;
          }
        },
      },
    };

    try {
      const instantiated = await WebAssembly.instantiate(
        wasmBytes as Uint8Array<ArrayBuffer>,
        imports,
      );
      const rawExports = instantiated.instance.exports as unknown as RawWasmExports;
      instanceMemory = rawExports.memory;
      return new OlmWasmBridge(rawExports);
    } catch (error) {
      if (error instanceof OlmCryptoError) throw error;
      throw new OlmCryptoError(
        "WASM_UNAVAILABLE",
        "Failed to instantiate vodozemac Olm WASM module.",
      );
    }
  }

  private withAllocatedBytes<T>(bytes: Uint8Array, fn: (ptr: number, len: number) => T): T {
    if (bytes.byteLength === 0) {
      return fn(0, 0);
    }
    const ptr = this.exports.wasm_alloc(bytes.byteLength);
    if (ptr === 0) {
      throw new OlmCryptoError("WASM_UNAVAILABLE", "WASM memory allocation failed.");
    }
    try {
      const view = new Uint8Array(this.exports.memory.buffer, ptr, bytes.byteLength);
      view.set(bytes);
      return fn(ptr, bytes.byteLength);
    } finally {
      this.exports.wasm_dealloc(ptr, bytes.byteLength);
    }
  }

  private withAllocatedString<T>(value: string, fn: (ptr: number, len: number) => T): T {
    const encoded = new TextEncoder().encode(value);
    return this.withAllocatedBytes(encoded, fn);
  }

  private readLastResult<T>(rc: number): T {
    const ptr = this.exports.wasm_result_ptr();
    const len = this.exports.wasm_result_len();
    if (ptr === 0 || len === 0) {
      throw new OlmCryptoError("WASM_UNAVAILABLE", "Empty response from Olm WASM module.");
    }
    const bytes = new Uint8Array(this.exports.memory.buffer, ptr, len);
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text) as WasmEnvelopeResponse<T>;
    if (rc !== 0 || !parsed.ok) {
      const errCode = !parsed.ok ? mapWasmErrorCode(parsed.code) : "WASM_UNAVAILABLE";
      const errMsg = !parsed.ok ? parsed.message : "Olm WASM call failed.";
      throw new OlmCryptoError(errCode, errMsg);
    }
    return parsed.data;
  }

  libraryInfo(): WasmLibraryInfo {
    const rc = this.exports.olm_library_info();
    return this.readLastResult<WasmLibraryInfo>(rc);
  }

  createAccount(): WasmAccountSummary {
    const rc = this.exports.olm_account_new();
    const raw = this.readLastResult<WasmAccountSummary>(rc);
    return {
      ...raw,
      identityKey: toBase64UrlKey(raw.identityKey),
      senderKey: toBase64UrlKey(raw.senderKey),
    };
  }

  freeAccount(accountHandle: number): void {
    const rc = this.exports.olm_account_free(accountHandle);
    this.readLastResult<{ freed: boolean }>(rc);
  }

  generateOneTimeKeys(accountHandle: number, count: number): WasmPublicKeyEntry[] {
    const rc = this.exports.olm_account_generate_one_time_keys(accountHandle, count);
    return this.readLastResult<{ oneTimeKeys: WasmPublicKeyEntry[] }>(rc).oneTimeKeys.map((k) => ({
      keyId: toOneTimeKeyId(k.keyId),
      key: toBase64UrlKey(k.key),
    }));
  }

  getOneTimeKeys(accountHandle: number): WasmPublicKeyEntry[] {
    const rc = this.exports.olm_account_one_time_keys(accountHandle);
    return this.readLastResult<{ oneTimeKeys: WasmPublicKeyEntry[] }>(rc).oneTimeKeys.map((k) => ({
      keyId: toOneTimeKeyId(k.keyId),
      key: toBase64UrlKey(k.key),
    }));
  }

  generateFallbackKey(accountHandle: number): WasmPublicKeyEntry {
    const rc = this.exports.olm_account_generate_fallback_key(accountHandle);
    const k = this.readLastResult<{ fallbackKey: WasmPublicKeyEntry }>(rc).fallbackKey;
    return {
      keyId: toFallbackKeyId(k.keyId),
      key: toBase64UrlKey(k.key),
    };
  }

  markKeysAsPublished(accountHandle: number): void {
    const rc = this.exports.olm_account_mark_keys_as_published(accountHandle);
    this.readLastResult<{ published: boolean }>(rc);
  }

  pickleAccount(accountHandle: number, pickleKey32: Uint8Array): string {
    return this.withAllocatedBytes(pickleKey32, (keyPtr, keyLen) => {
      const rc = this.exports.olm_account_pickle(accountHandle, keyPtr, keyLen);
      return this.readLastResult<{ pickle: string }>(rc).pickle;
    });
  }

  unpickleAccount(pickle: string, pickleKey32: Uint8Array): WasmAccountSummary {
    return this.withAllocatedString(pickle, (picklePtr, pickleLen) =>
      this.withAllocatedBytes(pickleKey32, (keyPtr, keyLen) => {
        const rc = this.exports.olm_account_from_pickle(picklePtr, pickleLen, keyPtr, keyLen);
        const raw = this.readLastResult<WasmAccountSummary>(rc);
        return {
          ...raw,
          identityKey: toBase64UrlKey(raw.identityKey),
          senderKey: toBase64UrlKey(raw.senderKey),
        };
      }),
    );
  }

  createOutboundSession(
    accountHandle: number,
    peerSenderKey: string,
    peerOneTimeOrFallbackKey: string,
  ): WasmOutboundSessionSummary {
    return this.withAllocatedString(
      toStandardUnpaddedBase64Key(peerSenderKey),
      (senderPtr, senderLen) =>
        this.withAllocatedString(
          toStandardUnpaddedBase64Key(peerOneTimeOrFallbackKey),
          (otkPtr, otkLen) => {
            const rc = this.exports.olm_create_outbound_session(
              accountHandle,
              senderPtr,
              senderLen,
              otkPtr,
              otkLen,
            );
            return this.readLastResult<WasmOutboundSessionSummary>(rc);
          },
        ),
    );
  }

  createInboundSession(
    accountHandle: number,
    peerSenderKey: string,
    preKeyCiphertextBytes: Uint8Array,
  ): WasmInboundSessionSummary {
    return this.withAllocatedString(
      toStandardUnpaddedBase64Key(peerSenderKey),
      (senderPtr, senderLen) =>
        this.withAllocatedBytes(preKeyCiphertextBytes, (ctPtr, ctLen) => {
          const rc = this.exports.olm_create_inbound_session(
            accountHandle,
            senderPtr,
            senderLen,
            ctPtr,
            ctLen,
          );
          const raw = this.readLastResult<{
            sessionHandle: number;
            sessionId: string;
            plaintextBytes: number[];
          }>(rc);
          const plaintext = new TextDecoder("utf-8", { fatal: true }).decode(
            Uint8Array.from(raw.plaintextBytes),
          );
          return {
            sessionHandle: raw.sessionHandle,
            sessionId: raw.sessionId,
            plaintext,
          };
        }),
    );
  }

  freeSession(sessionHandle: number): void {
    const rc = this.exports.olm_session_free(sessionHandle);
    this.readLastResult<{ freed: boolean }>(rc);
  }

  encrypt(sessionHandle: number, plaintext: string): WasmEncryptOutput {
    return this.withAllocatedString(plaintext, (ptPtr, ptLen) => {
      const rc = this.exports.olm_session_encrypt(sessionHandle, ptPtr, ptLen);
      const raw = this.readLastResult<{
        sessionId: string;
        messageType: number;
        ciphertextBytes: number[];
      }>(rc);
      const messageType: OlmMessageType =
        raw.messageType === OLM_MESSAGE_TYPE_PREKEY
          ? OLM_MESSAGE_TYPE_PREKEY
          : OLM_MESSAGE_TYPE_NORMAL;
      return {
        sessionId: raw.sessionId,
        messageType,
        ciphertext: base64UrlEncode(Uint8Array.from(raw.ciphertextBytes)),
      };
    });
  }

  decrypt(
    sessionHandle: number,
    messageType: OlmMessageType,
    ciphertextBytes: Uint8Array,
  ): WasmDecryptOutput {
    return this.withAllocatedBytes(ciphertextBytes, (ctPtr, ctLen) => {
      const rc = this.exports.olm_session_decrypt(sessionHandle, messageType, ctPtr, ctLen);
      const raw = this.readLastResult<{
        sessionId: string;
        plaintextBytes: number[];
      }>(rc);
      const plaintext = new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(raw.plaintextBytes),
      );
      return {
        sessionId: raw.sessionId,
        plaintext,
      };
    });
  }

  pickleSession(
    sessionHandle: number,
    pickleKey32: Uint8Array,
  ): { sessionId: string; pickle: string } {
    return this.withAllocatedBytes(pickleKey32, (keyPtr, keyLen) => {
      const rc = this.exports.olm_session_pickle(sessionHandle, keyPtr, keyLen);
      return this.readLastResult<{ sessionId: string; pickle: string }>(rc);
    });
  }

  unpickleSession(pickle: string, pickleKey32: Uint8Array): WasmSessionFromPickleSummary {
    return this.withAllocatedString(pickle, (picklePtr, pickleLen) =>
      this.withAllocatedBytes(pickleKey32, (keyPtr, keyLen) => {
        const rc = this.exports.olm_session_from_pickle(picklePtr, pickleLen, keyPtr, keyLen);
        return this.readLastResult<WasmSessionFromPickleSummary>(rc);
      }),
    );
  }
}

export {
  OLM_ERROR_CODES,
  OlmCryptoError,
  failureStateForCode,
  isOlmCryptoError,
  olmFailure,
  type OlmErrorCode,
  type OlmFailureState,
  type OlmOperationFailure,
  type OlmResult,
} from "./errors.js";

export {
  MAX_ENCRYPTED_ENVELOPE_BYTES,
  MAX_PLAINTEXT_CODE_POINTS,
  MIN_OLM_CIPHERTEXT_BYTES,
  OLM_ENVELOPE_FORBIDDEN_FIELDS,
  OLM_ENVELOPE_SCHEMA_VERSION,
  OLM_MESSAGE_TYPE_NORMAL,
  OLM_MESSAGE_TYPE_PREKEY,
  OLM_PROTOCOL_VERSION,
  assertSupportedProtocolVersion,
  assertValidPlaintext,
  countUnicodeCodePoints,
  decodeOlmEncryptedEnvelope,
  encodeOlmEncryptedEnvelope,
  findEnvelopeForbiddenField,
  validateOlmEnvelopePayload,
  type OlmEncryptedEnvelope,
  type OlmEnvelopePayload,
  type OlmMessageType,
  type OlmProtocolVersion,
} from "./envelope.js";

export {
  OlmWasmBridge,
  type OlmWasmBridgeOptions,
  type RandomSource,
  type WasmAccountSummary,
  type WasmDecryptOutput,
  type WasmEncryptOutput,
  type WasmInboundSessionSummary,
  type WasmLibraryInfo,
  type WasmOutboundSessionSummary,
  type WasmPublicKeyEntry,
  type WasmSessionFromPickleSummary,
} from "./wasm-bridge.js";

export {
  InProcessSingleWriterLock,
  OLM_DEVICE_ALGORITHM,
  OLM_MAX_CONSECUTIVE_DECRYPT_FAILURES,
  OLM_SESSION_MAX_AGE_MS,
  OLM_SESSION_MAX_MESSAGES,
  OlmAccountDevice,
  assertStorageKeyNonExtractable,
  generateNonExtractableStorageKey,
  type CreateOlmAccountDeviceOptions,
  type OlmDecryptContext,
  type OlmDecryptedMessage,
  type OlmPeerTarget,
  type OlmSessionMetadata,
  type SealedOlmStateBundle,
  type SingleWriterLock,
} from "./session.js";

export { OLM_WASM_SHA256, getCompiledOlmWasmBytes } from "./wasm-binary.js";
export { base64UrlDecode, base64UrlEncode } from "../device/encoding.js";

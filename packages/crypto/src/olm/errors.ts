/**
 * Explicit fail-closed error and state definitions for the Olm/vodozemac
 * E2EE library integration (P2-02, DEC-018, FR-CHAT-014, FR-SEC-028, NFR-REC-002).
 *
 * Every encryption or decryption failure produces a deterministic code and
 * explicit failure state. Plaintext fallback is strictly absent.
 */

export const OLM_ERROR_CODES = [
  "WASM_UNAVAILABLE",
  "INSECURE_RANDOMNESS",
  "MISSING_KEY_MATERIAL",
  "UNSUPPORTED_PROTOCOL_VERSION",
  "INVALID_ENVELOPE",
  "PAYLOAD_TOO_LARGE",
  "FORBIDDEN_FIELD",
  "PEER_KEY_MISMATCH",
  "PEER_KEY_CHANGE_BLOCKED",
  "TAMPERED_ENVELOPE",
  "REPLAYED_OR_DUPLICATE_MESSAGE",
  "SESSION_ROLLBACK_DETECTED",
  "PICKLE_DECRYPTION_FAILED",
  "LOCK_UNAVAILABLE",
] as const;

export type OlmErrorCode = (typeof OLM_ERROR_CODES)[number];

/**
 * Explicit user/application-visible decryption failure states (`FR-CHAT-014`, `NFR-REC-002`).
 * Never maps to an empty string or a false delivered/read state.
 */
export type OlmFailureState =
  | "missing-key"
  | "tampered-envelope"
  | "unsupported-version"
  | "replayed-message"
  | "session-rollback"
  | "peer-key-blocked"
  | "invalid-payload"
  | "crypto-unavailable";

export function failureStateForCode(code: OlmErrorCode): OlmFailureState {
  switch (code) {
    case "MISSING_KEY_MATERIAL":
    case "PICKLE_DECRYPTION_FAILED":
      return "missing-key";
    case "TAMPERED_ENVELOPE":
      return "tampered-envelope";
    case "UNSUPPORTED_PROTOCOL_VERSION":
      return "unsupported-version";
    case "REPLAYED_OR_DUPLICATE_MESSAGE":
      return "replayed-message";
    case "SESSION_ROLLBACK_DETECTED":
      return "session-rollback";
    case "PEER_KEY_MISMATCH":
    case "PEER_KEY_CHANGE_BLOCKED":
      return "peer-key-blocked";
    case "INVALID_ENVELOPE":
    case "PAYLOAD_TOO_LARGE":
    case "FORBIDDEN_FIELD":
      return "invalid-payload";
    case "WASM_UNAVAILABLE":
    case "INSECURE_RANDOMNESS":
    case "LOCK_UNAVAILABLE":
      return "crypto-unavailable";
  }
}

export class OlmCryptoError extends Error {
  readonly code: OlmErrorCode;
  readonly state: OlmFailureState;
  readonly retryable: boolean;

  constructor(code: OlmErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "OlmCryptoError";
    this.code = code;
    this.state = failureStateForCode(code);
    this.retryable = retryable;
  }
}

export function isOlmCryptoError(value: unknown): value is OlmCryptoError {
  return value instanceof OlmCryptoError;
}

export interface OlmOperationFailure {
  ok: false;
  code: OlmErrorCode;
  state: OlmFailureState;
  message: string;
  retryable: boolean;
}

export type OlmResult<T> = { ok: true; value: T } | OlmOperationFailure;

export function olmFailure(error: unknown): OlmOperationFailure {
  if (error instanceof OlmCryptoError) {
    return {
      ok: false,
      code: error.code,
      state: error.state,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    ok: false,
    code: "WASM_UNAVAILABLE",
    state: "crypto-unavailable",
    message: "Cryptographic operation failed closed.",
    retryable: false,
  };
}

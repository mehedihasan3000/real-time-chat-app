import { base64UrlDecode } from "../device/encoding.js";
import {
  MAX_ENCRYPTED_ENVELOPE_BYTES,
  OLM_ENVELOPE_SCHEMA_VERSION,
  OLM_PROTOCOL_VERSION,
  findEnvelopeForbiddenField,
  validateOlmEnvelopePayload,
  type OlmEncryptedEnvelope,
  type OlmMessageType,
  type OlmProtocolVersion,
} from "../olm/envelope.js";
import {
  OlmCryptoError,
  failureStateForCode,
  olmFailure,
  type OlmErrorCode,
  type OlmFailureState,
} from "../olm/errors.js";
import type { OlmAccountDevice, OlmDecryptContext } from "../olm/session.js";

/**
 * Cryptographic receive/decrypt envelope boundary (`P2-06`, `DEC-018`,
 * `FR-CHAT-013`, `FR-CHAT-014`, `NFR-REC-002`, `FR-SEC-001`, `FR-SEC-028`).
 *
 * Guarantees:
 * - Strict version check (`olm-vodozemac-v1`); unknown/downgraded versions fail closed.
 * - Outer server metadata (`senderDeviceId`) is bound against the inner Olm envelope header.
 * - Zero Unicode mutation: decrypted UTF-8 plaintext is returned verbatim (no normalization
 *   or lossy sanitization) so Bengali combining sequences, emoji, and mixed scripts round-trip
 *   intact (`FR-I18N-004`, `TC-CHAT-008`). Inert rendering is enforced by the UI layer.
 * - Zero plaintext fallback: missing keys, tampered ciphertexts, unsupported versions,
 *   replays, rollbacks, and peer key blocks return an explicit failure record that preserves
 *   the message identity (`messageId`, `seq`, `committedAt`) and marks receipt eligibility
 *   strictly `false` (`FR-CHAT-014`, `NFR-REC-002`).
 */

export interface ReceivedEncryptedMessageInput {
  schemaVersion: number;
  messageId: string;
  conversationId: string;
  seq: number;
  senderUserId: string;
  senderDeviceId: string;
  clientMessageId?: string;
  protocolVersion: string;
  encryptedEnvelope: string;
  committedAt: string;
}

export interface DecryptedReceivedMessage {
  ok: true;
  status: "decrypted";
  messageId: string;
  conversationId: string;
  seq: number;
  senderUserId: string;
  senderDeviceId: string;
  clientMessageId?: string;
  committedAt: string;
  protocolVersion: OlmProtocolVersion;
  /** Exact UTF-8 decrypted text (untrusted display input; must be rendered inertly). */
  plaintext: string;
  sessionId: string;
  messageIndex: number;
  messageType: OlmMessageType;
  /** True only after verified decryption (`FR-CHAT-009`, `DEC-020` §7.1). */
  eligibleForDeliveryReceipt: true;
  /** True only after verified decryption; display focus & user opt-in still gate emission (`FR-CHAT-010`). */
  eligibleForReadReceipt: true;
}

export interface FailedReceivedMessage {
  ok: false;
  status: "failed";
  messageId: string;
  conversationId: string;
  seq: number;
  senderUserId: string;
  senderDeviceId: string;
  clientMessageId?: string;
  committedAt: string;
  protocolVersion: string;
  code: OlmErrorCode;
  failureState: OlmFailureState;
  message: string;
  recoverable: boolean;
  /** Undecryptable or integrity-invalid messages must never emit delivered receipts (`FR-CHAT-014`). */
  eligibleForDeliveryReceipt: false;
  /** Undecryptable or integrity-invalid messages must never emit read receipts (`FR-CHAT-014`). */
  eligibleForReadReceipt: false;
}

export type ReceivedMessageDecryptResult = DecryptedReceivedMessage | FailedReceivedMessage;

export type DecryptCapableDevice = Pick<OlmAccountDevice, "deviceId" | "decryptEnvelope">;

export function isRecoverableFailureState(state: OlmFailureState): boolean {
  return state === "missing-key" || state === "peer-key-blocked" || state === "crypto-unavailable";
}

function makeFailure(
  input: ReceivedEncryptedMessageInput,
  code: OlmErrorCode,
  message: string,
): FailedReceivedMessage {
  const failureState = failureStateForCode(code);
  return {
    ok: false,
    status: "failed",
    messageId: input.messageId,
    conversationId: input.conversationId,
    seq: input.seq,
    senderUserId: input.senderUserId,
    senderDeviceId: input.senderDeviceId,
    ...(input.clientMessageId !== undefined ? { clientMessageId: input.clientMessageId } : {}),
    committedAt: input.committedAt,
    protocolVersion: input.protocolVersion,
    code,
    failureState,
    message,
    recoverable: isRecoverableFailureState(failureState),
    eligibleForDeliveryReceipt: false,
    eligibleForReadReceipt: false,
  };
}

/**
 * Inspect the unencrypted outer envelope header to extract `recipientDeviceId`
 * for routing or eligibility checks without accessing private keys or plaintext.
 * Returns `null` if the envelope is malformed or exceeds 16 KiB.
 */
export function extractEnvelopeRecipientDeviceId(encryptedEnvelope: string): string | null {
  if (typeof encryptedEnvelope !== "string" || encryptedEnvelope.length === 0) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(encryptedEnvelope);
  } catch {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ENCRYPTED_ENVELOPE_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const validated = validateOlmEnvelopePayload(parsed);
  if (!validated.ok) return null;
  return validated.value.recipientDeviceId;
}

/**
 * Receive and decrypt an encrypted wire message record using the local active
 * `OlmAccountDevice` (`P2-06`, `FR-CHAT-013`, `FR-CHAT-014`, `NFR-REC-002`).
 */
export async function decryptReceivedEnvelope(
  device: DecryptCapableDevice | null | undefined,
  input: ReceivedEncryptedMessageInput,
  context: OlmDecryptContext = {},
): Promise<ReceivedMessageDecryptResult> {
  const forbidden = findEnvelopeForbiddenField(input);
  if (forbidden) {
    return makeFailure(
      input,
      "FORBIDDEN_FIELD",
      `Forbidden field "${forbidden}" present on received encrypted message record.`,
    );
  }

  if (input.schemaVersion !== OLM_ENVELOPE_SCHEMA_VERSION) {
    return makeFailure(
      input,
      "UNSUPPORTED_PROTOCOL_VERSION",
      `Unsupported message schemaVersion: ${String(input.schemaVersion)}.`,
    );
  }

  if (input.protocolVersion !== OLM_PROTOCOL_VERSION) {
    return makeFailure(
      input,
      "UNSUPPORTED_PROTOCOL_VERSION",
      `Unsupported or downgraded E2EE protocol version: ${String(input.protocolVersion)}.`,
    );
  }

  if (typeof input.encryptedEnvelope !== "string" || input.encryptedEnvelope.length === 0) {
    return makeFailure(input, "TAMPERED_ENVELOPE", "Encrypted envelope bytes are missing.");
  }

  let decodedBytes: Uint8Array;
  try {
    decodedBytes = base64UrlDecode(input.encryptedEnvelope);
  } catch {
    return makeFailure(input, "TAMPERED_ENVELOPE", "Encrypted envelope is not valid base64url.");
  }

  if (decodedBytes.byteLength === 0) {
    return makeFailure(input, "TAMPERED_ENVELOPE", "Encrypted envelope is empty.");
  }
  if (decodedBytes.byteLength > MAX_ENCRYPTED_ENVELOPE_BYTES) {
    return makeFailure(
      input,
      "PAYLOAD_TOO_LARGE",
      `Decoded encrypted envelope (${decodedBytes.byteLength} bytes) exceeds 16 KiB limit.`,
    );
  }

  let parsedInner: unknown;
  try {
    parsedInner = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodedBytes));
  } catch {
    return makeFailure(
      input,
      "TAMPERED_ENVELOPE",
      "Encrypted envelope inner JSON payload is corrupted or truncated.",
    );
  }

  const innerResult = validateOlmEnvelopePayload(parsedInner);
  if (!innerResult.ok) {
    return makeFailure(input, innerResult.code, innerResult.message);
  }

  const inner = innerResult.value;
  if (inner.senderDeviceId !== input.senderDeviceId) {
    return makeFailure(
      input,
      "TAMPERED_ENVELOPE",
      "Outer senderDeviceId does not match authenticated inner Olm envelope header.",
    );
  }

  if (!device) {
    return makeFailure(
      input,
      "MISSING_KEY_MATERIAL",
      "No local active encryption device is available to decrypt this message.",
    );
  }

  const wire: OlmEncryptedEnvelope = {
    schemaVersion: OLM_ENVELOPE_SCHEMA_VERSION,
    protocolVersion: OLM_PROTOCOL_VERSION,
    senderDeviceId: inner.senderDeviceId,
    recipientDeviceId: inner.recipientDeviceId,
    sessionId: inner.sessionId,
    messageType: inner.messageType,
    encryptedEnvelope: input.encryptedEnvelope,
  };

  try {
    const decrypted = await device.decryptEnvelope(wire, {
      expectedRecipientDeviceId: context.expectedRecipientDeviceId ?? device.deviceId,
      peerUserId: context.peerUserId ?? input.senderUserId,
      expectedPeerIdentityKey: context.expectedPeerIdentityKey,
      expectedPeerSenderKey: context.expectedPeerSenderKey,
    });

    if (!decrypted.ok) {
      return makeFailure(input, decrypted.code, decrypted.message);
    }

    return {
      ok: true,
      status: "decrypted",
      messageId: input.messageId,
      conversationId: input.conversationId,
      seq: input.seq,
      senderUserId: input.senderUserId,
      senderDeviceId: input.senderDeviceId,
      ...(input.clientMessageId !== undefined ? { clientMessageId: input.clientMessageId } : {}),
      committedAt: input.committedAt,
      protocolVersion: OLM_PROTOCOL_VERSION,
      plaintext: decrypted.value.plaintext,
      sessionId: decrypted.value.sessionId,
      messageIndex: decrypted.value.messageIndex,
      messageType: decrypted.value.messageType,
      eligibleForDeliveryReceipt: true,
      eligibleForReadReceipt: true,
    };
  } catch (error) {
    const failure = olmFailure(
      error instanceof OlmCryptoError
        ? error
        : new OlmCryptoError("WASM_UNAVAILABLE", "Decryption failed closed."),
    );
    return makeFailure(input, failure.code, failure.message);
  }
}

import { isDeviceId, isPublicKey } from "@chat/contracts";
import { base64UrlDecode, base64UrlEncode } from "../device/encoding.js";
import { OlmCryptoError, olmFailure, type OlmResult } from "./errors.js";

/**
 * Approved Olm envelope contract and validator (P2-02, DEC-018, DEC-016, DATA-003, DATA-004).
 *
 * Provisional wire shape under Release-gated DEC-023. Enforces:
 * - Exact protocol version (`olm-vodozemac-v1`) with downgrade/unknown rejection
 * - 8,000 Unicode code-point plaintext compose bound (`DEC-016`)
 * - 16 KiB (16,384 bytes) decoded encrypted envelope bound (`DEC-016`)
 * - Strict field allowlists and absence of any plaintext or private-key field
 */

export const OLM_PROTOCOL_VERSION = "olm-vodozemac-v1" as const;
export type OlmProtocolVersion = typeof OLM_PROTOCOL_VERSION;

export const OLM_ENVELOPE_SCHEMA_VERSION = 1 as const;

/** DEC-016 client compose limit: 8,000 Unicode code points. */
export const MAX_PLAINTEXT_CODE_POINTS = 8_000;

/** DEC-016 encrypted envelope limit: 16 KiB decoded bytes. */
export const MAX_ENCRYPTED_ENVELOPE_BYTES = 16 * 1024;

/** Minimum plausible vodozemac Olm message length (header + MAC + block). */
export const MIN_OLM_CIPHERTEXT_BYTES = 24;

/**
 * Matrix/vodozemac Olm message types:
 * - `0`: PreKey message (establishes or re-keys an inbound session)
 * - `1`: Normal Double Ratchet message
 */
export const OLM_MESSAGE_TYPE_PREKEY = 0 as const;
export const OLM_MESSAGE_TYPE_NORMAL = 1 as const;
export type OlmMessageType = typeof OLM_MESSAGE_TYPE_PREKEY | typeof OLM_MESSAGE_TYPE_NORMAL;

/**
 * Forbidden field names that must never appear inside an Olm envelope or
 * serialized wire payload (`TC-SEC-001`, `FR-SEC-001`, `FR-SEC-002`).
 */
export const OLM_ENVELOPE_FORBIDDEN_FIELDS = [
  "plaintext",
  "text",
  "body",
  "content",
  "messageText",
  "fallbackPlaintext",
  "privateKey",
  "privateKeys",
  "secretKey",
  "seed",
  "pickleKey",
  "recoveryKey",
  "archive",
  "manifest",
] as const;

const FORBIDDEN_ENVELOPE_KEY_SET = new Set<string>(OLM_ENVELOPE_FORBIDDEN_FIELDS);

/**
 * Inner decoded Olm envelope structure serialized into the opaque base64url
 * `encryptedEnvelope` wire string (`DEC-021` §3.1, `DATA-003`–`DATA-004`).
 */
export interface OlmEnvelopePayload {
  schemaVersion: 1;
  protocolVersion: OlmProtocolVersion;
  senderDeviceId: string;
  recipientDeviceId: string;
  senderIdentityKey: string;
  senderCurve25519Key: string;
  sessionId: string;
  messageIndex: number;
  messageType: OlmMessageType;
  ciphertext: string;
}

/**
 * Canonical wire wrapper carrying the protocolVersion and base64url-encoded
 * opaque envelope bytes (`DEC-021` §3.1, `SRS` §17.3).
 */
export interface OlmEncryptedEnvelope {
  schemaVersion: 1;
  protocolVersion: OlmProtocolVersion;
  senderDeviceId: string;
  recipientDeviceId: string;
  sessionId: string;
  messageType: OlmMessageType;
  encryptedEnvelope: string;
}

const PAYLOAD_ALLOWED_FIELDS = new Set([
  "schemaVersion",
  "protocolVersion",
  "senderDeviceId",
  "recipientDeviceId",
  "senderIdentityKey",
  "senderCurve25519Key",
  "sessionId",
  "messageIndex",
  "messageType",
  "ciphertext",
]);

const WIRE_ALLOWED_FIELDS = new Set([
  "schemaVersion",
  "protocolVersion",
  "senderDeviceId",
  "recipientDeviceId",
  "sessionId",
  "messageType",
  "encryptedEnvelope",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function findEnvelopeForbiddenField(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): string | null {
  if (typeof value !== "object" || value === null) return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEnvelopeForbiddenField(item, seen);
      if (found) return found;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_ENVELOPE_KEY_SET.has(key)) return key;
    const found = findEnvelopeForbiddenField(record[key], seen);
    if (found) return found;
  }
  return null;
}

export function countUnicodeCodePoints(input: string): number {
  return Array.from(input).length;
}

/**
 * Validate plaintext before encryption (`DEC-016`, `FR-SEC-028`).
 * Rejects non-strings and strings exceeding 8,000 Unicode code points.
 */
export function assertValidPlaintext(plaintext: unknown): string {
  if (typeof plaintext !== "string") {
    throw new OlmCryptoError(
      "INVALID_ENVELOPE",
      "Message plaintext must be a string; plaintext fallback is prohibited.",
    );
  }
  const codePoints = countUnicodeCodePoints(plaintext);
  if (codePoints > MAX_PLAINTEXT_CODE_POINTS) {
    throw new OlmCryptoError(
      "PAYLOAD_TOO_LARGE",
      `Message exceeds the ${MAX_PLAINTEXT_CODE_POINTS} Unicode code-point compose limit.`,
    );
  }
  return plaintext;
}

/**
 * Validate `protocolVersion` strictly (`DATA-004`, `DEC-018`).
 * Rejects missing, unknown, legacy, or downgraded protocol versions (`olm-v0`, `plaintext`, `dev-webcrypto-v0`, etc.).
 */
export function assertSupportedProtocolVersion(version: unknown): OlmProtocolVersion {
  if (version !== OLM_PROTOCOL_VERSION) {
    throw new OlmCryptoError(
      "UNSUPPORTED_PROTOCOL_VERSION",
      `Unsupported or downgraded E2EE protocol version: ${String(version)}.`,
    );
  }
  return OLM_PROTOCOL_VERSION;
}

export function validateOlmEnvelopePayload(input: unknown): OlmResult<OlmEnvelopePayload> {
  try {
    if (!isPlainRecord(input)) {
      throw new OlmCryptoError("INVALID_ENVELOPE", "Olm envelope payload must be a JSON object.");
    }
    const forbidden = findEnvelopeForbiddenField(input);
    if (forbidden) {
      throw new OlmCryptoError("FORBIDDEN_FIELD", `Forbidden field in Olm envelope: ${forbidden}.`);
    }
    for (const key of Object.keys(input)) {
      if (!PAYLOAD_ALLOWED_FIELDS.has(key)) {
        throw new OlmCryptoError(
          "INVALID_ENVELOPE",
          `Unknown field in Olm envelope payload: ${key}.`,
        );
      }
    }
    if (input.schemaVersion !== OLM_ENVELOPE_SCHEMA_VERSION) {
      throw new OlmCryptoError(
        "UNSUPPORTED_PROTOCOL_VERSION",
        `Unsupported Olm envelope schemaVersion: ${String(input.schemaVersion)}.`,
      );
    }
    const protocolVersion = assertSupportedProtocolVersion(input.protocolVersion);

    if (!isDeviceId(input.senderDeviceId)) {
      throw new OlmCryptoError("INVALID_ENVELOPE", "Invalid senderDeviceId in Olm envelope.");
    }
    if (!isDeviceId(input.recipientDeviceId)) {
      throw new OlmCryptoError("INVALID_ENVELOPE", "Invalid recipientDeviceId in Olm envelope.");
    }
    if (!isPublicKey(input.senderIdentityKey)) {
      throw new OlmCryptoError("INVALID_ENVELOPE", "Invalid senderIdentityKey in Olm envelope.");
    }
    if (!isPublicKey(input.senderCurve25519Key)) {
      throw new OlmCryptoError("INVALID_ENVELOPE", "Invalid senderCurve25519Key in Olm envelope.");
    }
    if (
      typeof input.sessionId !== "string" ||
      input.sessionId.length < 8 ||
      input.sessionId.length > 128
    ) {
      throw new OlmCryptoError("INVALID_ENVELOPE", "Invalid sessionId in Olm envelope.");
    }
    if (
      typeof input.messageIndex !== "number" ||
      !Number.isInteger(input.messageIndex) ||
      input.messageIndex < 0
    ) {
      throw new OlmCryptoError("INVALID_ENVELOPE", "Invalid messageIndex in Olm envelope.");
    }
    if (
      input.messageType !== OLM_MESSAGE_TYPE_PREKEY &&
      input.messageType !== OLM_MESSAGE_TYPE_NORMAL
    ) {
      throw new OlmCryptoError("INVALID_ENVELOPE", "Invalid Olm messageType; expected 0 or 1.");
    }
    if (typeof input.ciphertext !== "string" || input.ciphertext.length === 0) {
      throw new OlmCryptoError("TAMPERED_ENVELOPE", "Missing Olm ciphertext bytes.");
    }
    let decodedCiphertext: Uint8Array;
    try {
      decodedCiphertext = base64UrlDecode(input.ciphertext);
    } catch {
      throw new OlmCryptoError("TAMPERED_ENVELOPE", "Malformed base64url Olm ciphertext.");
    }
    if (decodedCiphertext.byteLength < MIN_OLM_CIPHERTEXT_BYTES) {
      throw new OlmCryptoError(
        "TAMPERED_ENVELOPE",
        "Truncated Olm ciphertext below minimum valid frame size.",
      );
    }
    if (decodedCiphertext.byteLength > MAX_ENCRYPTED_ENVELOPE_BYTES) {
      throw new OlmCryptoError(
        "PAYLOAD_TOO_LARGE",
        `Decoded Olm ciphertext exceeds ${MAX_ENCRYPTED_ENVELOPE_BYTES} bytes.`,
      );
    }

    return {
      ok: true,
      value: {
        schemaVersion: OLM_ENVELOPE_SCHEMA_VERSION,
        protocolVersion,
        senderDeviceId: input.senderDeviceId,
        recipientDeviceId: input.recipientDeviceId,
        senderIdentityKey: input.senderIdentityKey,
        senderCurve25519Key: input.senderCurve25519Key,
        sessionId: input.sessionId,
        messageIndex: input.messageIndex,
        messageType: input.messageType,
        ciphertext: input.ciphertext,
      },
    };
  } catch (error) {
    return olmFailure(error);
  }
}

export function encodeOlmEncryptedEnvelope(payload: OlmEnvelopePayload): OlmEncryptedEnvelope {
  const validated = validateOlmEnvelopePayload(payload);
  if (!validated.ok) {
    throw new OlmCryptoError(validated.code, validated.message, validated.retryable);
  }
  const jsonBytes = new TextEncoder().encode(JSON.stringify(validated.value));
  if (jsonBytes.byteLength > MAX_ENCRYPTED_ENVELOPE_BYTES) {
    throw new OlmCryptoError(
      "PAYLOAD_TOO_LARGE",
      `Decoded Olm envelope (${jsonBytes.byteLength} bytes) exceeds the ${MAX_ENCRYPTED_ENVELOPE_BYTES}-byte limit.`,
    );
  }
  return {
    schemaVersion: OLM_ENVELOPE_SCHEMA_VERSION,
    protocolVersion: OLM_PROTOCOL_VERSION,
    senderDeviceId: validated.value.senderDeviceId,
    recipientDeviceId: validated.value.recipientDeviceId,
    sessionId: validated.value.sessionId,
    messageType: validated.value.messageType,
    encryptedEnvelope: base64UrlEncode(jsonBytes),
  };
}

export function decodeOlmEncryptedEnvelope(wire: unknown): OlmResult<OlmEnvelopePayload> {
  try {
    if (!isPlainRecord(wire)) {
      throw new OlmCryptoError("INVALID_ENVELOPE", "Encrypted envelope wrapper must be an object.");
    }
    const forbidden = findEnvelopeForbiddenField(wire);
    if (forbidden) {
      throw new OlmCryptoError(
        "FORBIDDEN_FIELD",
        `Forbidden field in encrypted envelope wrapper: ${forbidden}.`,
      );
    }
    for (const key of Object.keys(wire)) {
      if (!WIRE_ALLOWED_FIELDS.has(key)) {
        throw new OlmCryptoError(
          "INVALID_ENVELOPE",
          `Unknown field in encrypted envelope wrapper: ${key}.`,
        );
      }
    }
    if (wire.schemaVersion !== OLM_ENVELOPE_SCHEMA_VERSION) {
      throw new OlmCryptoError(
        "UNSUPPORTED_PROTOCOL_VERSION",
        `Unsupported envelope wrapper schemaVersion: ${String(wire.schemaVersion)}.`,
      );
    }
    assertSupportedProtocolVersion(wire.protocolVersion);

    if (typeof wire.encryptedEnvelope !== "string" || wire.encryptedEnvelope.length === 0) {
      throw new OlmCryptoError("INVALID_ENVELOPE", "encryptedEnvelope must be a non-empty string.");
    }
    let decodedBytes: Uint8Array;
    try {
      decodedBytes = base64UrlDecode(wire.encryptedEnvelope);
    } catch {
      throw new OlmCryptoError("TAMPERED_ENVELOPE", "encryptedEnvelope is not valid base64url.");
    }
    if (decodedBytes.byteLength > MAX_ENCRYPTED_ENVELOPE_BYTES) {
      throw new OlmCryptoError(
        "PAYLOAD_TOO_LARGE",
        `Decoded encryptedEnvelope (${decodedBytes.byteLength} bytes) exceeds 16 KiB limit.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodedBytes));
    } catch {
      throw new OlmCryptoError(
        "TAMPERED_ENVELOPE",
        "Encrypted envelope inner payload is corrupted or truncated.",
      );
    }

    const innerResult = validateOlmEnvelopePayload(parsed);
    if (!innerResult.ok) return innerResult;

    const inner = innerResult.value;
    if (
      wire.senderDeviceId !== inner.senderDeviceId ||
      wire.recipientDeviceId !== inner.recipientDeviceId ||
      wire.sessionId !== inner.sessionId ||
      wire.messageType !== inner.messageType
    ) {
      throw new OlmCryptoError(
        "TAMPERED_ENVELOPE",
        "Outer envelope metadata does not match inner authenticated Olm envelope header.",
      );
    }
    return { ok: true, value: inner };
  } catch (error) {
    return olmFailure(error);
  }
}

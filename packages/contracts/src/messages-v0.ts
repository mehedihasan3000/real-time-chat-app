/**
 * Encrypted message send pipeline contracts v0 (P2-04, FR-CHAT-002..004,
 * DATA-003..005, INT-005, FR-SEC-001, FR-SEC-014, FR-SEC-028; DEC-016,
 * DEC-018, DEC-021, DEC-023).
 *
 * Provisional under Release-gated DEC-023 (`protocolVersion allowlist`,
 * `payloadHash canonicalization`, `encryptedEnvelope bounds`):
 * - Only canonical HTTP `POST /api/v1/conversations/{id}/messages` commits.
 * - Client requests strictly allowlist `{ schemaVersion, clientMessageId,
 *   senderDeviceId, protocolVersion, encryptedEnvelope }`.
 * - Plaintext, private-key, sequence, hash, senderUserId, and timestamp fields
 *   are rejected before state mutation.
 * - `encryptedEnvelope` decodes to a <= 16 KiB UTF-8 JSON Olm payload matching
 *   the approved `"olm-vodozemac-v1"` structure (`packages/crypto/src/olm/`).
 */
import { isOpaqueId } from "./conversations-v0.js";
import { isDeviceId, isPublicKey } from "./device-keys-v0.js";
import {
  BODY_MAX_BYTES,
  ENVELOPE_MAX_BYTES,
  SCHEMA_VERSION,
  checkSchemaVersion,
  isRequestId,
  type ValidationResult,
} from "./v0.js";

export const MESSAGE_SCHEMA_VERSION = 1 as const;
export const MESSAGE_ALLOWED_PROTOCOL_VERSION = "olm-vodozemac-v1" as const;
export const MESSAGE_ALLOWED_PROTOCOL_VERSIONS = [MESSAGE_ALLOWED_PROTOCOL_VERSION] as const;

export type MessageProtocolVersion = (typeof MESSAGE_ALLOWED_PROTOCOL_VERSIONS)[number];

/** Compose & envelope bounds (DEC-016). */
export const MESSAGE_MAX_PLAINTEXT_CODE_POINTS = 8_000;
export const MESSAGE_MAX_ENVELOPE_BYTES = ENVELOPE_MAX_BYTES;
export const MESSAGE_MAX_BODY_BYTES = BODY_MAX_BYTES;
export const MESSAGE_MIN_CIPHERTEXT_BYTES = 24;

/** Per-user outbound message send rate limits (DEC-016 §5.2). */
export const MESSAGE_SEND_LIMIT_PER_MINUTE = 30;
export const MESSAGE_SEND_LIMIT_PER_HOUR = 300;
export const MESSAGE_SEND_LIMIT_PER_DAY = 1_000;

/** Fields prohibited in client send requests and inner envelopes (DATA-003, INT-002). */
export const MESSAGE_FORBIDDEN_FIELDS = [
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
  "preview",
  "summary",
  "translation",
] as const;

export const MESSAGE_CLIENT_FORBIDDEN_FIELDS = [
  ...MESSAGE_FORBIDDEN_FIELDS,
  "senderUserId",
  "seq",
  "payloadHash",
  "committedAt",
  "messageId",
  "id",
  "_id",
  "conversationId",
  "participantIds",
] as const;

const SEND_REQUEST_FIELDS = new Set([
  "schemaVersion",
  "clientMessageId",
  "senderDeviceId",
  "protocolVersion",
  "encryptedEnvelope",
]);

const INNER_ENVELOPE_FIELDS = new Set([
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

const MESSAGE_ACK_FIELDS = new Set([
  "messageId",
  "conversationId",
  "seq",
  "senderUserId",
  "senderDeviceId",
  "clientMessageId",
  "protocolVersion",
  "committedAt",
  "schemaVersion",
]);

const SEND_RESPONSE_FIELDS = new Set(["message", "idempotent"]);
const MESSAGE_NEW_FIELDS = new Set([
  "schemaVersion",
  "messageId",
  "conversationId",
  "seq",
  "senderUserId",
  "senderDeviceId",
  "clientMessageId",
  "protocolVersion",
  "encryptedEnvelope",
  "committedAt",
]);
const FORBIDDEN_ANYWHERE_SET = new Set<string>(MESSAGE_FORBIDDEN_FIELDS);

export interface MessageSendInput {
  schemaVersion: 1;
  clientMessageId: string;
  senderDeviceId: string;
  protocolVersion: MessageProtocolVersion;
  encryptedEnvelope: string;
}

export interface DecodedMessageEnvelopeMetadata {
  senderDeviceId: string;
  recipientDeviceId: string;
  sessionId: string;
  messageType: 0 | 1;
  messageIndex: number;
  envelopeBytes: number;
}

export interface ValidatedMessageSend {
  request: MessageSendInput;
  envelope: DecodedMessageEnvelopeMetadata;
}

export interface MessageAckSummary {
  messageId: string;
  conversationId: string;
  seq: number;
  senderUserId: string;
  senderDeviceId: string;
  clientMessageId: string;
  protocolVersion: MessageProtocolVersion;
  committedAt: string;
  schemaVersion: 1;
}

export interface MessageSendResponse {
  message: MessageAckSummary;
  idempotent: boolean;
}

/**
 * Live Socket.IO `/v1` `message:new` event payload (`P2-06`, `FR-CHAT-005`,
 * `DATA-003`–`DATA-004`, `SRS` §5.3). Carries only opaque ciphertext and
 * server-authoritative routing/order metadata — never plaintext, private keys,
 * or `payloadHash`.
 */
export interface MessageNewEvent {
  schemaVersion: 1;
  messageId: string;
  conversationId: string;
  seq: number;
  senderUserId: string;
  senderDeviceId: string;
  clientMessageId: string;
  protocolVersion: string;
  encryptedEnvelope: string;
  committedAt: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOnlyAllowedKeys(record: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function invalid<T = never>(message: string): ValidationResult<T> {
  return { ok: false, code: "INVALID_REQUEST", message, retryable: false };
}

function unsupported<T = never>(message: string): ValidationResult<T> {
  return { ok: false, code: "UNSUPPORTED_SCHEMA_VERSION", message, retryable: false };
}

function payloadTooLarge<T = never>(message: string): ValidationResult<T> {
  return { ok: false, code: "PAYLOAD_TOO_LARGE", message, retryable: false };
}

function containsForbiddenKey(
  value: unknown,
  forbiddenSet: Set<string>,
  seen: WeakSet<object> = new WeakSet(),
): string | null {
  if (typeof value !== "object" || value === null) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = containsForbiddenKey(item, forbiddenSet, seen);
      if (hit) return hit;
    }
    return null;
  }
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (forbiddenSet.has(key)) return key;
    const hit = containsForbiddenKey(rec[key], forbiddenSet, seen);
    if (hit) return hit;
  }
  return null;
}

function decodeBase64UrlBytes(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const withPad = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    const binary = globalThis.atob(withPad);
    if (binary.length === 0) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Validate `POST /api/v1/conversations/:id/messages` body under strict `P2-04`
 * (`DEC-016`, `DEC-018`, `DEC-021`, `DEC-023`) rules.
 */
export function validateMessageSendRequest(input: unknown): ValidationResult<ValidatedMessageSend> {
  if (!isPlainRecord(input)) {
    return invalid("Request body must be a JSON object.");
  }

  const forbiddenTopLevel = containsForbiddenKey(
    input,
    new Set<string>(MESSAGE_CLIENT_FORBIDDEN_FIELDS),
  );
  if (forbiddenTopLevel) {
    return invalid(`Field "${forbiddenTopLevel}" is not permitted in message send requests.`);
  }

  const versionCheck = checkSchemaVersion(input.schemaVersion);
  if (!versionCheck.ok) {
    return unsupported(`Unsupported schemaVersion. Expected ${SCHEMA_VERSION}.`);
  }

  if (!hasOnlyAllowedKeys(input, SEND_REQUEST_FIELDS)) {
    return invalid("Message submission contains unsupported request fields.");
  }

  if (!isRequestId(input.clientMessageId)) {
    return invalid("clientMessageId must be a valid UUID.");
  }

  if (!isDeviceId(input.senderDeviceId)) {
    return invalid("senderDeviceId must be a valid device identifier.");
  }

  if (typeof input.protocolVersion !== "string" || input.protocolVersion.length === 0) {
    return invalid("protocolVersion is required.");
  }
  if (input.protocolVersion !== MESSAGE_ALLOWED_PROTOCOL_VERSION) {
    return unsupported(
      `Unsupported protocolVersion. Expected ${MESSAGE_ALLOWED_PROTOCOL_VERSION}.`,
    );
  }

  if (typeof input.encryptedEnvelope !== "string" || input.encryptedEnvelope.length === 0) {
    return invalid("encryptedEnvelope is required.");
  }

  // Reject oversized base64url inputs deterministically before allocation/JSON parse.
  if (input.encryptedEnvelope.length > Math.ceil((MESSAGE_MAX_ENVELOPE_BYTES * 4) / 3) + 4) {
    return payloadTooLarge("encryptedEnvelope exceeds 16 KiB.");
  }

  const envelopeBytes = decodeBase64UrlBytes(input.encryptedEnvelope);
  if (!envelopeBytes) {
    return invalid("encryptedEnvelope must be valid non-empty base64url.");
  }
  if (envelopeBytes.byteLength > MESSAGE_MAX_ENVELOPE_BYTES) {
    return payloadTooLarge("encryptedEnvelope exceeds 16 KiB.");
  }

  let parsedEnvelope: unknown;
  try {
    parsedEnvelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelopeBytes));
  } catch {
    return invalid("encryptedEnvelope must encode a valid UTF-8 Olm JSON envelope.");
  }

  if (!isPlainRecord(parsedEnvelope)) {
    return invalid("Inner Olm envelope must be a JSON object.");
  }

  const forbiddenInner = containsForbiddenKey(parsedEnvelope, FORBIDDEN_ANYWHERE_SET);
  if (forbiddenInner) {
    return invalid(
      `Forbidden field "${forbiddenInner}" is not permitted inside encryptedEnvelope.`,
    );
  }

  if (!hasOnlyAllowedKeys(parsedEnvelope, INNER_ENVELOPE_FIELDS)) {
    return invalid("Inner Olm envelope contains unknown fields.");
  }

  if (parsedEnvelope.schemaVersion !== MESSAGE_SCHEMA_VERSION) {
    return unsupported("Unsupported inner envelope schemaVersion.");
  }
  if (parsedEnvelope.protocolVersion !== MESSAGE_ALLOWED_PROTOCOL_VERSION) {
    return unsupported("Unsupported inner envelope protocolVersion.");
  }
  if (parsedEnvelope.senderDeviceId !== input.senderDeviceId) {
    return invalid("Inner envelope senderDeviceId must match senderDeviceId.");
  }
  if (!isDeviceId(parsedEnvelope.recipientDeviceId)) {
    return invalid("Inner envelope recipientDeviceId is invalid.");
  }
  if (!isPublicKey(parsedEnvelope.senderIdentityKey)) {
    return invalid("Inner envelope senderIdentityKey is invalid.");
  }
  if (!isPublicKey(parsedEnvelope.senderCurve25519Key)) {
    return invalid("Inner envelope senderCurve25519Key is invalid.");
  }
  if (
    typeof parsedEnvelope.sessionId !== "string" ||
    parsedEnvelope.sessionId.length < 8 ||
    parsedEnvelope.sessionId.length > 128
  ) {
    return invalid("Inner envelope sessionId is invalid.");
  }
  if (
    typeof parsedEnvelope.messageIndex !== "number" ||
    !Number.isInteger(parsedEnvelope.messageIndex) ||
    parsedEnvelope.messageIndex < 0
  ) {
    return invalid("Inner envelope messageIndex is invalid.");
  }
  if (parsedEnvelope.messageType !== 0 && parsedEnvelope.messageType !== 1) {
    return invalid("Inner envelope messageType must be 0 or 1.");
  }
  if (typeof parsedEnvelope.ciphertext !== "string") {
    return invalid("Inner envelope ciphertext is required.");
  }
  const ciphertextBytes = decodeBase64UrlBytes(parsedEnvelope.ciphertext);
  if (!ciphertextBytes || ciphertextBytes.byteLength < MESSAGE_MIN_CIPHERTEXT_BYTES) {
    return invalid("Inner envelope ciphertext must be valid non-truncated base64url bytes.");
  }

  return {
    ok: true,
    value: {
      request: {
        schemaVersion: MESSAGE_SCHEMA_VERSION,
        clientMessageId: input.clientMessageId,
        senderDeviceId: input.senderDeviceId,
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        encryptedEnvelope: input.encryptedEnvelope,
      },
      envelope: {
        senderDeviceId: parsedEnvelope.senderDeviceId,
        recipientDeviceId: parsedEnvelope.recipientDeviceId,
        sessionId: parsedEnvelope.sessionId,
        messageType: parsedEnvelope.messageType,
        messageIndex: parsedEnvelope.messageIndex,
        envelopeBytes: envelopeBytes.byteLength,
      },
    },
  };
}

export function validateMessageAckSummary(input: unknown): ValidationResult<MessageAckSummary> {
  if (!isPlainRecord(input) || !hasOnlyAllowedKeys(input, MESSAGE_ACK_FIELDS)) {
    return invalid("Invalid message acknowledgment summary.");
  }
  if (containsForbiddenKey(input, FORBIDDEN_ANYWHERE_SET)) {
    return invalid("Forbidden field in message acknowledgment.");
  }
  if (input.schemaVersion !== MESSAGE_SCHEMA_VERSION) {
    return unsupported("Unsupported message schemaVersion.");
  }
  if (input.protocolVersion !== MESSAGE_ALLOWED_PROTOCOL_VERSION) {
    return unsupported("Unsupported message protocolVersion.");
  }
  if (!isOpaqueId(input.messageId)) return invalid("Invalid messageId.");
  if (!isOpaqueId(input.conversationId)) return invalid("Invalid conversationId.");
  if (typeof input.seq !== "number" || !Number.isInteger(input.seq) || input.seq < 1) {
    return invalid("Invalid message seq.");
  }
  if (!isOpaqueId(input.senderUserId)) return invalid("Invalid senderUserId.");
  if (!isDeviceId(input.senderDeviceId)) return invalid("Invalid senderDeviceId.");
  if (!isRequestId(input.clientMessageId)) return invalid("Invalid clientMessageId.");
  if (typeof input.committedAt !== "string" || Number.isNaN(Date.parse(input.committedAt))) {
    return invalid("Invalid committedAt timestamp.");
  }

  return {
    ok: true,
    value: {
      messageId: input.messageId,
      conversationId: input.conversationId,
      seq: input.seq,
      senderUserId: input.senderUserId,
      senderDeviceId: input.senderDeviceId,
      clientMessageId: input.clientMessageId,
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      committedAt: input.committedAt,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
    },
  };
}

export function validateMessageSendResponse(input: unknown): ValidationResult<MessageSendResponse> {
  if (!isPlainRecord(input) || !hasOnlyAllowedKeys(input, SEND_RESPONSE_FIELDS)) {
    return invalid("Invalid message send response.");
  }
  if (typeof input.idempotent !== "boolean") {
    return invalid("Invalid idempotent flag.");
  }
  const message = validateMessageAckSummary(input.message);
  if (!message.ok) return message;
  return {
    ok: true,
    value: {
      message: message.value,
      idempotent: input.idempotent,
    },
  };
}

/**
 * Validate a server→client `message:new` event payload (`P2-06`, `FR-CHAT-005`,
 * `NFR-REC-002`, `DATA-004`). Rejects forbidden plaintext/private-key fields,
 * unknown fields, invalid IDs/seq/timestamps, and oversized envelopes, while
 * allowing unrecognized `protocolVersion` or corrupted ciphertext bytes through
 * to client decryption so explicit `unsupported-version` / `tampered-envelope`
 * placeholders remain identifiable (`FR-CHAT-014`).
 */
export function validateMessageNewEvent(input: unknown): ValidationResult<MessageNewEvent> {
  if (!isPlainRecord(input)) {
    return invalid("message:new payload must be an object.");
  }
  const forbidden = containsForbiddenKey(input, FORBIDDEN_ANYWHERE_SET);
  if (forbidden) {
    return invalid(`Forbidden field "${forbidden}" is not permitted in message:new events.`);
  }
  if (!hasOnlyAllowedKeys(input, MESSAGE_NEW_FIELDS)) {
    return invalid("message:new payload contains unknown fields.");
  }
  if (input.schemaVersion !== MESSAGE_SCHEMA_VERSION) {
    return unsupported("Unsupported message:new schemaVersion.");
  }
  if (!isOpaqueId(input.messageId)) return invalid("Invalid messageId.");
  if (!isOpaqueId(input.conversationId)) return invalid("Invalid conversationId.");
  if (typeof input.seq !== "number" || !Number.isInteger(input.seq) || input.seq < 1) {
    return invalid("Invalid message seq.");
  }
  if (!isOpaqueId(input.senderUserId)) return invalid("Invalid senderUserId.");
  if (!isDeviceId(input.senderDeviceId)) return invalid("Invalid senderDeviceId.");
  if (!isRequestId(input.clientMessageId)) return invalid("Invalid clientMessageId.");
  if (
    typeof input.protocolVersion !== "string" ||
    input.protocolVersion.length === 0 ||
    input.protocolVersion.length > 64 ||
    /\s/.test(input.protocolVersion)
  ) {
    return invalid("Invalid protocolVersion.");
  }
  if (typeof input.encryptedEnvelope !== "string" || input.encryptedEnvelope.length === 0) {
    return invalid("encryptedEnvelope is required.");
  }
  if (input.encryptedEnvelope.length > Math.ceil((MESSAGE_MAX_ENVELOPE_BYTES * 4) / 3) + 4) {
    return payloadTooLarge("encryptedEnvelope exceeds 16 KiB.");
  }
  if (typeof input.committedAt !== "string" || Number.isNaN(Date.parse(input.committedAt))) {
    return invalid("Invalid committedAt timestamp.");
  }

  return {
    ok: true,
    value: {
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      messageId: input.messageId,
      conversationId: input.conversationId,
      seq: input.seq,
      senderUserId: input.senderUserId,
      senderDeviceId: input.senderDeviceId,
      clientMessageId: input.clientMessageId,
      protocolVersion: input.protocolVersion,
      encryptedEnvelope: input.encryptedEnvelope,
      committedAt: input.committedAt,
    },
  };
}

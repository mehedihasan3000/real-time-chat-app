/**
 * Delivery/read receipts, read-sharing privacy preferences, and private unread
 * progress contracts v0 (P2-11, FR-CHAT-009..011, FR-HIST-004, FR-PRIV-003,
 * DATA-006, INT-001..002; DEC-008, DEC-015, DEC-020, DEC-021, DEC-023).
 *
 * Provisional under Release-gated DEC-023:
 * - Delivery receipts require recipient endpoint verification/decryption
 *   evidence (`delivered`); socket room broadcast alone never advances delivery.
 * - Read receipts (`read`) are strictly opt-in, default-off (`false`), and
 *   reciprocal: suppressed unless both sender and recipient have enabled read
 *   sharing and no bilateral block is active (`DEC-008`).
 * - Focused-conversation display debounce is normative at `500 ms`
 *   (`READ_RECEIPT_FOCUS_DEBOUNCE_MS`).
 * - Per-message receipt stage (`sent -> delivered -> read`) and per-user
 *   private `readThroughSeq` are strictly monotonic.
 * - Client requests never choose `userId`, `senderUserId`, `recipientUserId`,
 *   `deliveredAt`, `readAt`, or `unreadCount`; unknown/forbidden/operator keys
 *   fail closed with `400 INVALID_REQUEST`.
 */
import { isOpaqueId } from "./conversations-v0.js";
import { isDeviceId } from "./device-keys-v0.js";
import { checkSchemaVersion, type ValidationResult } from "./v0.js";

export const RECEIPT_SCHEMA_VERSION = 1 as const;

/** Approved normative stages for per-message sender visibility (DEC-020 §7.1). */
export const RECEIPT_STAGES = ["sent", "delivered", "read"] as const;
export type ReceiptStage = (typeof RECEIPT_STAGES)[number];

/** Receipt advancement events accepted from recipient endpoints. */
export const RECEIPT_SUBMIT_TYPES = ["delivered", "read"] as const;
export type ReceiptSubmitType = (typeof RECEIPT_SUBMIT_TYPES)[number];

/** Focus visibility debounce before emitting a read receipt (`FR-CHAT-010`). */
export const READ_RECEIPT_FOCUS_DEBOUNCE_MS = 500;

/** Default opt-in preference state (`FR-CHAT-010`, `DEC-020` §7.2). */
export const DEFAULT_READ_RECEIPTS_ENABLED = false;

export const RECEIPT_SUPPRESSED_REASONS = ["policy", "already_advanced"] as const;
export type ReceiptSuppressedReason = (typeof RECEIPT_SUPPRESSED_REASONS)[number];

/** Forbidden plaintext, cryptographic, presence, and block-disclosure keys. */
export const RECEIPT_FORBIDDEN_FIELDS = [
  "plaintext",
  "text",
  "body",
  "content",
  "encryptedEnvelope",
  "ciphertext",
  "privateKey",
  "recoveryKey",
  "secretKey",
  "presence",
  "lastSeen",
  "typing",
  "online",
  "email",
  "blockedByPeer",
  "isBlockedByPeer",
] as const;

const RECEIPT_FORBIDDEN_SET = new Set<string>(RECEIPT_FORBIDDEN_FIELDS);
const RECEIPT_STAGE_RANK: Record<ReceiptStage, 0 | 1 | 2> = {
  sent: 0,
  delivered: 1,
  read: 2,
};

const UPDATE_PREFS_FIELDS = new Set(["schemaVersion", "readReceiptsEnabled"]);
const SUBMIT_RECEIPT_FIELDS = new Set(["schemaVersion", "type", "deviceId"]);
const UPDATE_PROGRESS_FIELDS = new Set(["schemaVersion", "readThroughSeq"]);

const RECEIPT_VIEW_FIELDS = new Set([
  "schemaVersion",
  "messageId",
  "conversationId",
  "seq",
  "recipientUserId",
  "recipientDeviceId",
  "stage",
  "deliveredAt",
  "readAt",
  "updatedAt",
]);

const RECEIPT_EVENT_FIELDS = new Set([...RECEIPT_VIEW_FIELDS, "senderUserId"]);

const SUBMIT_RECEIPT_RESPONSE_FIELDS = new Set([
  "accepted",
  "suppressedReason",
  "stage",
  "recordedAt",
]);

const RECEIPT_LIST_RESPONSE_FIELDS = new Set(["items", "latestSeq"]);
const RECEIPT_DETAIL_RESPONSE_FIELDS = new Set(["receipt"]);

const READ_PROGRESS_VIEW_FIELDS = new Set([
  "schemaVersion",
  "conversationId",
  "userId",
  "readThroughSeq",
  "latestSeq",
  "unreadCount",
  "updatedAt",
]);

const READ_PROGRESS_RESPONSE_FIELDS = new Set(["progress"]);

const PREFERENCES_VIEW_FIELDS = new Set([
  "schemaVersion",
  "userId",
  "readReceiptsEnabled",
  "updatedAt",
]);

export interface ReceiptPreferencesView {
  schemaVersion: 1;
  userId: string;
  readReceiptsEnabled: boolean;
  updatedAt: string;
}

export interface UpdateReceiptPreferencesRequest {
  schemaVersion: 1;
  readReceiptsEnabled: boolean;
}

export interface SubmitMessageReceiptRequest {
  schemaVersion: 1;
  type: ReceiptSubmitType;
  deviceId: string;
}

export interface SubmitMessageReceiptResponse {
  accepted: boolean;
  suppressedReason: ReceiptSuppressedReason | null;
  stage: ReceiptSubmitType;
  recordedAt: string | null;
}

/**
 * Sender-only view of per-message delivery/read progression (`FR-CHAT-009`, `DATA-006`).
 * Uniquely keyed server-side by `(messageId, recipientUserId)`.
 */
export interface MessageReceiptView {
  schemaVersion: 1;
  messageId: string;
  conversationId: string;
  seq: number;
  recipientUserId: string;
  recipientDeviceId: string;
  stage: ReceiptStage;
  deliveredAt: string | null;
  readAt: string | null;
  updatedAt: string;
}

/** Realtime Socket.IO `"message:receipt"` event sent ONLY to `user:<senderUserId>`. */
export interface MessageReceiptEvent extends MessageReceiptView {
  senderUserId: string;
}

export interface ConversationReceiptListResponse {
  items: MessageReceiptView[];
  latestSeq: number;
}

export interface MessageReceiptDetailResponse {
  receipt: MessageReceiptView;
}

/** Private per-user read high-water mark & unread badge state (`FR-HIST-004`, `DATA-006`). */
export interface ReadProgressView {
  schemaVersion: 1;
  conversationId: string;
  userId: string;
  readThroughSeq: number;
  latestSeq: number;
  unreadCount: number;
  updatedAt: string;
}

export interface UpdateReadProgressRequest {
  schemaVersion: 1;
  readThroughSeq: number;
}

export interface ReadProgressResponse {
  progress: ReadProgressView;
}

export function receiptStageRank(stage: ReceiptStage): 0 | 1 | 2 {
  return RECEIPT_STAGE_RANK[stage];
}

export function isReceiptStage(value: unknown): value is ReceiptStage {
  return typeof value === "string" && value in RECEIPT_STAGE_RANK;
}

export function isReceiptSubmitType(value: unknown): value is ReceiptSubmitType {
  return value === "delivered" || value === "read";
}

/** Monotonic stage merge (`sent < delivered < read`); never regresses (`FR-CHAT-011`). */
export function mergeMonotonicReceiptStage(
  current: ReceiptStage,
  incoming: ReceiptStage,
): ReceiptStage {
  return RECEIPT_STAGE_RANK[incoming] > RECEIPT_STAGE_RANK[current] ? incoming : current;
}

/** Preserves confirmed receipt timestamps against duplicate or reordered arrivals (`FR-CHAT-011`). */
export function mergeMonotonicTimestamp(
  current: string | null,
  incoming: string | null,
): string | null {
  if (current !== null) return current;
  return incoming;
}

/** Monotonic private `readThroughSeq` advance clamped to an optional ceiling (`FR-HIST-004`). */
export function mergeMonotonicReadThroughSeq(
  currentSeq: number,
  candidateSeq: number,
  maxSeq?: number,
): number {
  const safeCurrent = Number.isSafeInteger(currentSeq) && currentSeq >= 0 ? currentSeq : 0;
  const safeCandidate = Number.isSafeInteger(candidateSeq) && candidateSeq >= 0 ? candidateSeq : 0;
  const merged = Math.max(safeCurrent, safeCandidate);
  if (maxSeq !== undefined && Number.isSafeInteger(maxSeq) && maxSeq >= 0) {
    return Math.min(merged, Math.max(safeCurrent, maxSeq));
  }
  return merged;
}

/** Safe baseline formula for `unreadCount` from non-negative integer seq values. */
export function computeUnreadCount(latestSeq: number, readThroughSeq: number): number {
  const safeLatest = Number.isSafeInteger(latestSeq) && latestSeq >= 0 ? latestSeq : 0;
  const safeRead = Number.isSafeInteger(readThroughSeq) && readThroughSeq >= 0 ? readThroughSeq : 0;
  return Math.max(0, safeLatest - safeRead);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOnlyAllowedKeys(record: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function invalidRequest<T = never>(message: string): ValidationResult<T> {
  return { ok: false, code: "INVALID_REQUEST", message, retryable: false };
}

function requireSchemaVersion<T = never>(value: unknown): ValidationResult<T> | null {
  const versionCheck = checkSchemaVersion(value);
  if (!versionCheck.ok) {
    return {
      ok: false,
      code: versionCheck.code,
      message: `Unsupported schemaVersion; expected ${RECEIPT_SCHEMA_VERSION}.`,
      retryable: false,
    };
  }
  return null;
}

function hasDisallowedKey(value: unknown, seen: WeakSet<object> = new WeakSet()): string | null {
  if (typeof value !== "object" || value === null) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = hasDisallowedKey(item, seen);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith("$") || RECEIPT_FORBIDDEN_SET.has(key)) {
      return key;
    }
    const nestedHit = hasDisallowedKey(nested, seen);
    if (nestedHit) return nestedHit;
  }
  return null;
}

function validateRecordShape<T = never>(
  input: unknown,
  allowedKeys: Set<string>,
  label: string,
  checkVersion = true,
): ValidationResult<T> | null {
  if (!isPlainRecord(input)) {
    return invalidRequest(`${label} must be an object.`);
  }
  if (hasDisallowedKey(input) || !hasOnlyAllowedKeys(input, allowedKeys)) {
    return invalidRequest(`Unsupported or disallowed field in ${label}.`);
  }
  if (checkVersion) {
    return requireSchemaVersion<T>(input.schemaVersion);
  }
  return null;
}

function isPositiveSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  return !Number.isNaN(Date.parse(value));
}

function isNullableIsoTimestamp(value: unknown): value is string | null {
  return value === null || isIsoTimestamp(value);
}

export function validateUpdateReceiptPreferencesRequest(
  input: unknown,
): ValidationResult<UpdateReceiptPreferencesRequest> {
  const err = validateRecordShape<UpdateReceiptPreferencesRequest>(
    input,
    UPDATE_PREFS_FIELDS,
    "preferences update",
  );
  if (err) return err;
  const record = input as Record<string, unknown>;
  if (typeof record.readReceiptsEnabled !== "boolean") {
    return invalidRequest("readReceiptsEnabled must be a boolean.");
  }
  return {
    ok: true,
    value: {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      readReceiptsEnabled: record.readReceiptsEnabled,
    },
  };
}

export function validateReceiptPreferencesView(
  input: unknown,
): ValidationResult<ReceiptPreferencesView> {
  const err = validateRecordShape<ReceiptPreferencesView>(
    input,
    PREFERENCES_VIEW_FIELDS,
    "preferences response",
  );
  if (err) return err;
  const record = input as Record<string, unknown>;
  if (
    !isOpaqueId(record.userId) ||
    typeof record.readReceiptsEnabled !== "boolean" ||
    !isIsoTimestamp(record.updatedAt)
  ) {
    return invalidRequest("Preferences response contains invalid fields.");
  }
  return {
    ok: true,
    value: {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      userId: record.userId,
      readReceiptsEnabled: record.readReceiptsEnabled,
      updatedAt: record.updatedAt,
    },
  };
}

export function validateSubmitMessageReceiptRequest(
  input: unknown,
): ValidationResult<SubmitMessageReceiptRequest> {
  const err = validateRecordShape<SubmitMessageReceiptRequest>(
    input,
    SUBMIT_RECEIPT_FIELDS,
    "receipt submission",
  );
  if (err) return err;
  const record = input as Record<string, unknown>;
  if (!isReceiptSubmitType(record.type)) {
    return invalidRequest("Receipt type must be 'delivered' or 'read'.");
  }
  if (!isDeviceId(record.deviceId)) {
    return invalidRequest("Invalid recipient deviceId.");
  }
  return {
    ok: true,
    value: {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      type: record.type,
      deviceId: record.deviceId,
    },
  };
}

export function validateSubmitMessageReceiptResponse(
  input: unknown,
): ValidationResult<SubmitMessageReceiptResponse> {
  const err = validateRecordShape<SubmitMessageReceiptResponse>(
    input,
    SUBMIT_RECEIPT_RESPONSE_FIELDS,
    "receipt submission response",
    false,
  );
  if (err) return err;
  const record = input as Record<string, unknown>;
  if (typeof record.accepted !== "boolean" || !isReceiptSubmitType(record.stage)) {
    return invalidRequest("Receipt submission response has invalid accepted/stage fields.");
  }
  const reasonValid =
    record.suppressedReason === null ||
    record.suppressedReason === "policy" ||
    record.suppressedReason === "already_advanced";
  if (!reasonValid || !isNullableIsoTimestamp(record.recordedAt)) {
    return invalidRequest("Receipt submission response has invalid reason/timestamp fields.");
  }
  return {
    ok: true,
    value: {
      accepted: record.accepted,
      suppressedReason: record.suppressedReason as ReceiptSuppressedReason | null,
      stage: record.stage,
      recordedAt: record.recordedAt,
    },
  };
}

export function validateMessageReceiptView(input: unknown): ValidationResult<MessageReceiptView> {
  const err = validateRecordShape<MessageReceiptView>(
    input,
    RECEIPT_VIEW_FIELDS,
    "message receipt",
  );
  if (err) return err;
  const record = input as Record<string, unknown>;
  if (
    !isOpaqueId(record.messageId) ||
    !isOpaqueId(record.conversationId) ||
    !isPositiveSeq(record.seq) ||
    !isOpaqueId(record.recipientUserId) ||
    !isDeviceId(record.recipientDeviceId) ||
    !isReceiptStage(record.stage) ||
    !isNullableIsoTimestamp(record.deliveredAt) ||
    !isNullableIsoTimestamp(record.readAt) ||
    !isIsoTimestamp(record.updatedAt)
  ) {
    return invalidRequest("Message receipt contains invalid fields.");
  }
  return {
    ok: true,
    value: {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      messageId: record.messageId,
      conversationId: record.conversationId,
      seq: record.seq,
      recipientUserId: record.recipientUserId,
      recipientDeviceId: record.recipientDeviceId,
      stage: record.stage,
      deliveredAt: record.deliveredAt,
      readAt: record.readAt,
      updatedAt: record.updatedAt,
    },
  };
}

export function validateMessageReceiptEvent(input: unknown): ValidationResult<MessageReceiptEvent> {
  const err = validateRecordShape<MessageReceiptEvent>(
    input,
    RECEIPT_EVENT_FIELDS,
    "message receipt event",
    false,
  );
  if (err) return err;
  const record = input as Record<string, unknown>;
  if (!isOpaqueId(record.senderUserId)) {
    return invalidRequest("Message receipt event requires a valid senderUserId.");
  }
  const { senderUserId, ...rest } = record;
  const viewCheck = validateMessageReceiptView(rest);
  if (!viewCheck.ok) {
    return viewCheck;
  }
  return {
    ok: true,
    value: {
      ...viewCheck.value,
      senderUserId: senderUserId as string,
    },
  };
}

export function validateConversationReceiptListResponse(
  input: unknown,
): ValidationResult<ConversationReceiptListResponse> {
  const err = validateRecordShape<ConversationReceiptListResponse>(
    input,
    RECEIPT_LIST_RESPONSE_FIELDS,
    "receipt list response",
    false,
  );
  if (err) return err;
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.items) || !isNonNegativeSeq(record.latestSeq)) {
    return invalidRequest("Receipt list response must include valid items and latestSeq.");
  }
  const items: MessageReceiptView[] = [];
  for (const item of record.items) {
    const check = validateMessageReceiptView(item);
    if (!check.ok) return check;
    items.push(check.value);
  }
  return {
    ok: true,
    value: {
      items,
      latestSeq: record.latestSeq,
    },
  };
}

export function validateMessageReceiptDetailResponse(
  input: unknown,
): ValidationResult<MessageReceiptDetailResponse> {
  const err = validateRecordShape<MessageReceiptDetailResponse>(
    input,
    RECEIPT_DETAIL_RESPONSE_FIELDS,
    "receipt detail response",
    false,
  );
  if (err) return err;
  const record = input as Record<string, unknown>;
  const check = validateMessageReceiptView(record.receipt);
  if (!check.ok) return check;
  return {
    ok: true,
    value: {
      receipt: check.value,
    },
  };
}

export function validateUpdateReadProgressRequest(
  input: unknown,
): ValidationResult<UpdateReadProgressRequest> {
  const err = validateRecordShape<UpdateReadProgressRequest>(
    input,
    UPDATE_PROGRESS_FIELDS,
    "read progress update",
  );
  if (err) return err;
  const record = input as Record<string, unknown>;
  if (!isNonNegativeSeq(record.readThroughSeq)) {
    return invalidRequest("readThroughSeq must be a non-negative integer.");
  }
  return {
    ok: true,
    value: {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      readThroughSeq: record.readThroughSeq,
    },
  };
}

export function validateReadProgressView(input: unknown): ValidationResult<ReadProgressView> {
  const err = validateRecordShape<ReadProgressView>(
    input,
    READ_PROGRESS_VIEW_FIELDS,
    "read progress",
  );
  if (err) return err;
  const record = input as Record<string, unknown>;
  if (
    !isOpaqueId(record.conversationId) ||
    !isOpaqueId(record.userId) ||
    !isNonNegativeSeq(record.readThroughSeq) ||
    !isNonNegativeSeq(record.latestSeq) ||
    !isNonNegativeSeq(record.unreadCount) ||
    !isIsoTimestamp(record.updatedAt)
  ) {
    return invalidRequest("Read progress contains invalid fields.");
  }
  return {
    ok: true,
    value: {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      conversationId: record.conversationId,
      userId: record.userId,
      readThroughSeq: record.readThroughSeq,
      latestSeq: record.latestSeq,
      unreadCount: record.unreadCount,
      updatedAt: record.updatedAt,
    },
  };
}

export function validateReadProgressResponse(
  input: unknown,
): ValidationResult<ReadProgressResponse> {
  const err = validateRecordShape<ReadProgressResponse>(
    input,
    READ_PROGRESS_RESPONSE_FIELDS,
    "read progress response",
    false,
  );
  if (err) return err;
  const record = input as Record<string, unknown>;
  const check = validateReadProgressView(record.progress);
  if (!check.ok) return check;
  return {
    ok: true,
    value: {
      progress: check.value,
    },
  };
}

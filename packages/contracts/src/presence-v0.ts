/**
 * Volatile presence and typing contracts v0 (P2-12, FR-PRES-001..004,
 * INT-001..002; DEC-002, DEC-008, DEC-014..016, DEC-019..020, DEC-023).
 *
 * Provisional under Release-gated DEC-023:
 * - Presence states are strictly `"online" | "offline" | "unknown"` (`FR-PRES-001`).
 * - Presence leases expire after `60_000 ms` (`PRESENCE_LEASE_TTL_MS`).
 * - Typing indicators expire after `5_000 ms` (`TYPING_EXPIRY_MS`) and start
 *   signals are coalesced to at most 1 per `2_000 ms` (`TYPING_COALESCE_MS`).
 * - Activity sharing (`activitySharingEnabled`) is on by default (`true`) and
 *   user-disableable; bilateral blocks override activity sharing in both
 *   directions (`DEC-008`, `FR-PRES-004`).
 * - Neither presence nor typing is persisted as message/activity history, and
 *   no `lastSeen` timestamp or block state is ever stored or exposed (`DEC-015`).
 */
import { isOpaqueId } from "./conversations-v0.js";
import { checkSchemaVersion, type ValidationResult } from "./v0.js";

export const PRESENCE_SCHEMA_VERSION = 1 as const;

export const PRESENCE_STATES = ["online", "offline", "unknown"] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

/** Normative connection lease TTL (DEC-020 §6.3, FR-PRES-001). */
export const PRESENCE_LEASE_TTL_MS = 60_000;

/** Normative typing indicator expiry window (DEC-020 §6.3, FR-PRES-003). */
export const TYPING_EXPIRY_MS = 5_000;

/** Default activity-sharing preference state (DEC-020 §6.3, FR-PRES-004). */
export const DEFAULT_ACTIVITY_SHARING_ENABLED = true;

/** Forbidden history, timestamp, plaintext, crypto, and block-disclosure keys. */
export const PRESENCE_FORBIDDEN_FIELDS = [
  "lastSeen",
  "lastSeenAt",
  "lastActiveAt",
  "lastOnlineAt",
  "history",
  "presenceHistory",
  "plaintext",
  "text",
  "body",
  "content",
  "message",
  "encryptedEnvelope",
  "ciphertext",
  "privateKey",
  "recoveryKey",
  "secretKey",
  "email",
  "blockedByPeer",
  "isBlockedByPeer",
] as const;

const PRESENCE_FORBIDDEN_SET = new Set<string>(PRESENCE_FORBIDDEN_FIELDS);
const PRESENCE_STATE_SET = new Set<string>(PRESENCE_STATES);

const UPDATE_ACTIVITY_PREFS_FIELDS = new Set(["schemaVersion", "activitySharingEnabled"]);
const ACTIVITY_PREFS_VIEW_FIELDS = new Set([
  "schemaVersion",
  "userId",
  "activitySharingEnabled",
  "updatedAt",
]);
const CONVERSATION_PRESENCE_VIEW_FIELDS = new Set([
  "schemaVersion",
  "conversationId",
  "peerUserId",
  "status",
  "typing",
  "typingExpiresAt",
  "updatedAt",
]);
const CONVERSATION_PRESENCE_RESPONSE_FIELDS = new Set(["presence"]);
const TYPING_SIGNAL_REQUEST_FIELDS = new Set(["schemaVersion", "isTyping"]);
const TYPING_SIGNAL_RESULT_FIELDS = new Set([
  "schemaVersion",
  "conversationId",
  "userId",
  "isTyping",
  "accepted",
  "coalesced",
  "suppressed",
  "expiresAt",
  "updatedAt",
]);
const TYPING_SIGNAL_RESPONSE_FIELDS = new Set(["typing"]);
const PRESENCE_UPDATE_EVENT_FIELDS = new Set([
  "schemaVersion",
  "conversationId",
  "userId",
  "status",
  "updatedAt",
]);
const TYPING_UPDATE_EVENT_FIELDS = new Set([
  "schemaVersion",
  "conversationId",
  "userId",
  "isTyping",
  "expiresAt",
  "updatedAt",
]);

export interface ActivityPreferencesView {
  schemaVersion: 1;
  userId: string;
  activitySharingEnabled: boolean;
  updatedAt: string;
}

export interface UpdateActivityPreferencesRequest {
  schemaVersion: 1;
  activitySharingEnabled: boolean;
}

export interface ConversationPresenceView {
  schemaVersion: 1;
  conversationId: string;
  peerUserId: string;
  status: PresenceState;
  typing: boolean;
  typingExpiresAt: string | null;
  updatedAt: string;
}

export interface ConversationPresenceResponse {
  presence: ConversationPresenceView;
}

export interface TypingSignalRequest {
  schemaVersion: 1;
  isTyping: boolean;
}

export interface TypingSignalResultView {
  schemaVersion: 1;
  conversationId: string;
  userId: string;
  isTyping: boolean;
  accepted: boolean;
  coalesced: boolean;
  suppressed: boolean;
  expiresAt: string | null;
  updatedAt: string;
}

export interface TypingSignalResponse {
  typing: TypingSignalResultView;
}

export interface PresenceUpdateEvent {
  schemaVersion: 1;
  conversationId: string;
  userId: string;
  status: PresenceState;
  updatedAt: string;
}

export interface TypingUpdateEvent {
  schemaVersion: 1;
  conversationId: string;
  userId: string;
  isTyping: boolean;
  expiresAt: string | null;
  updatedAt: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasForbiddenPresenceKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasForbiddenPresenceKey(item));
  }
  if (typeof value !== "object" || value === null) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (PRESENCE_FORBIDDEN_SET.has(key) || key.startsWith("$")) {
      return true;
    }
    if (hasForbiddenPresenceKey(nested)) {
      return true;
    }
  }
  return false;
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && Number.isFinite(Date.parse(value));
}

function failInvalid<T>(message: string): ValidationResult<T> {
  return {
    ok: false,
    code: "INVALID_REQUEST",
    message,
    retryable: false,
  };
}

function requireSchemaVersion(record: Record<string, unknown>): ValidationResult<1> {
  const checked = checkSchemaVersion(record.schemaVersion);
  if (!checked.ok) {
    return {
      ok: false,
      code: checked.code,
      message: "Unsupported schema version.",
      retryable: false,
    };
  }
  return { ok: true, value: PRESENCE_SCHEMA_VERSION };
}

function checkAllowedKeys(record: Record<string, unknown>, allowed: Set<string>): string | null {
  if (hasForbiddenPresenceKey(record)) {
    return "Payload contains forbidden presence, history, key, or disclosure fields.";
  }
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      return `Unexpected field: ${key}`;
    }
  }
  return null;
}

export function isPresenceState(value: unknown): value is PresenceState {
  return typeof value === "string" && PRESENCE_STATE_SET.has(value);
}

export function validateUpdateActivityPreferencesRequest(
  value: unknown,
): ValidationResult<UpdateActivityPreferencesRequest> {
  if (!isPlainRecord(value)) return failInvalid("Request body must be a JSON object.");
  const keyError = checkAllowedKeys(value, UPDATE_ACTIVITY_PREFS_FIELDS);
  if (keyError) return failInvalid(keyError);
  const sv = requireSchemaVersion(value);
  if (!sv.ok) return sv;
  if (typeof value.activitySharingEnabled !== "boolean") {
    return failInvalid("activitySharingEnabled must be a boolean.");
  }
  return {
    ok: true,
    value: {
      schemaVersion: sv.value,
      activitySharingEnabled: value.activitySharingEnabled,
    },
  };
}

export function validateActivityPreferencesView(
  value: unknown,
): ValidationResult<ActivityPreferencesView> {
  if (!isPlainRecord(value)) return failInvalid("Activity preferences must be a JSON object.");
  const keyError = checkAllowedKeys(value, ACTIVITY_PREFS_VIEW_FIELDS);
  if (keyError) return failInvalid(keyError);
  const sv = requireSchemaVersion(value);
  if (!sv.ok) return sv;
  if (!isOpaqueId(value.userId)) return failInvalid("userId must be an opaque identifier.");
  if (typeof value.activitySharingEnabled !== "boolean") {
    return failInvalid("activitySharingEnabled must be a boolean.");
  }
  if (!isIsoDateString(value.updatedAt)) {
    return failInvalid("updatedAt must be a valid ISO timestamp.");
  }
  return {
    ok: true,
    value: {
      schemaVersion: sv.value,
      userId: value.userId,
      activitySharingEnabled: value.activitySharingEnabled,
      updatedAt: value.updatedAt,
    },
  };
}

export function validateConversationPresenceView(
  value: unknown,
): ValidationResult<ConversationPresenceView> {
  if (!isPlainRecord(value)) return failInvalid("Presence view must be a JSON object.");
  const keyError = checkAllowedKeys(value, CONVERSATION_PRESENCE_VIEW_FIELDS);
  if (keyError) return failInvalid(keyError);
  const sv = requireSchemaVersion(value);
  if (!sv.ok) return sv;
  if (!isOpaqueId(value.conversationId) || !isOpaqueId(value.peerUserId)) {
    return failInvalid("conversationId and peerUserId must be opaque identifiers.");
  }
  if (!isPresenceState(value.status)) {
    return failInvalid("status must be online, offline, or unknown.");
  }
  if (typeof value.typing !== "boolean") {
    return failInvalid("typing must be a boolean.");
  }
  if (value.typingExpiresAt !== null && !isIsoDateString(value.typingExpiresAt)) {
    return failInvalid("typingExpiresAt must be an ISO timestamp or null.");
  }
  if (!isIsoDateString(value.updatedAt)) {
    return failInvalid("updatedAt must be a valid ISO timestamp.");
  }
  if (value.status !== "online" && value.typing) {
    return failInvalid("typing cannot be true when presence status is not online.");
  }
  if (!value.typing && value.typingExpiresAt !== null) {
    return failInvalid("typingExpiresAt must be null when typing is false.");
  }
  if (value.typing && value.typingExpiresAt === null) {
    return failInvalid("typingExpiresAt is required when typing is true.");
  }
  return {
    ok: true,
    value: {
      schemaVersion: sv.value,
      conversationId: value.conversationId,
      peerUserId: value.peerUserId,
      status: value.status,
      typing: value.typing,
      typingExpiresAt: value.typingExpiresAt,
      updatedAt: value.updatedAt,
    },
  };
}

export function validateConversationPresenceResponse(
  value: unknown,
): ValidationResult<ConversationPresenceResponse> {
  if (!isPlainRecord(value)) return failInvalid("Presence response must be a JSON object.");
  const keyError = checkAllowedKeys(value, CONVERSATION_PRESENCE_RESPONSE_FIELDS);
  if (keyError) return failInvalid(keyError);
  const view = validateConversationPresenceView(value.presence);
  if (!view.ok) return view;
  return { ok: true, value: { presence: view.value } };
}

export function validateTypingSignalRequest(value: unknown): ValidationResult<TypingSignalRequest> {
  if (!isPlainRecord(value)) return failInvalid("Typing signal request must be a JSON object.");
  const keyError = checkAllowedKeys(value, TYPING_SIGNAL_REQUEST_FIELDS);
  if (keyError) return failInvalid(keyError);
  const sv = requireSchemaVersion(value);
  if (!sv.ok) return sv;
  if (typeof value.isTyping !== "boolean") {
    return failInvalid("isTyping must be a boolean.");
  }
  return {
    ok: true,
    value: {
      schemaVersion: sv.value,
      isTyping: value.isTyping,
    },
  };
}

export function validateTypingSignalResultView(
  value: unknown,
): ValidationResult<TypingSignalResultView> {
  if (!isPlainRecord(value)) return failInvalid("Typing signal result must be a JSON object.");
  const keyError = checkAllowedKeys(value, TYPING_SIGNAL_RESULT_FIELDS);
  if (keyError) return failInvalid(keyError);
  const sv = requireSchemaVersion(value);
  if (!sv.ok) return sv;
  if (!isOpaqueId(value.conversationId) || !isOpaqueId(value.userId)) {
    return failInvalid("conversationId and userId must be opaque identifiers.");
  }
  if (
    typeof value.isTyping !== "boolean" ||
    typeof value.accepted !== "boolean" ||
    typeof value.coalesced !== "boolean" ||
    typeof value.suppressed !== "boolean"
  ) {
    return failInvalid("isTyping, accepted, coalesced, and suppressed must be booleans.");
  }
  if (value.expiresAt !== null && !isIsoDateString(value.expiresAt)) {
    return failInvalid("expiresAt must be an ISO timestamp or null.");
  }
  if (!isIsoDateString(value.updatedAt)) {
    return failInvalid("updatedAt must be a valid ISO timestamp.");
  }
  return {
    ok: true,
    value: {
      schemaVersion: sv.value,
      conversationId: value.conversationId,
      userId: value.userId,
      isTyping: value.isTyping,
      accepted: value.accepted,
      coalesced: value.coalesced,
      suppressed: value.suppressed,
      expiresAt: value.expiresAt,
      updatedAt: value.updatedAt,
    },
  };
}

export function validateTypingSignalResponse(
  value: unknown,
): ValidationResult<TypingSignalResponse> {
  if (!isPlainRecord(value)) return failInvalid("Typing signal response must be a JSON object.");
  const keyError = checkAllowedKeys(value, TYPING_SIGNAL_RESPONSE_FIELDS);
  if (keyError) return failInvalid(keyError);
  const inner = validateTypingSignalResultView(value.typing);
  if (!inner.ok) return inner;
  return { ok: true, value: { typing: inner.value } };
}

export function validatePresenceUpdateEvent(value: unknown): ValidationResult<PresenceUpdateEvent> {
  if (!isPlainRecord(value)) return failInvalid("Presence update event must be a JSON object.");
  const keyError = checkAllowedKeys(value, PRESENCE_UPDATE_EVENT_FIELDS);
  if (keyError) return failInvalid(keyError);
  const sv = requireSchemaVersion(value);
  if (!sv.ok) return sv;
  if (!isOpaqueId(value.conversationId) || !isOpaqueId(value.userId)) {
    return failInvalid("conversationId and userId must be opaque identifiers.");
  }
  if (!isPresenceState(value.status)) {
    return failInvalid("status must be online, offline, or unknown.");
  }
  if (!isIsoDateString(value.updatedAt)) {
    return failInvalid("updatedAt must be a valid ISO timestamp.");
  }
  return {
    ok: true,
    value: {
      schemaVersion: sv.value,
      conversationId: value.conversationId,
      userId: value.userId,
      status: value.status,
      updatedAt: value.updatedAt,
    },
  };
}

export function validateTypingUpdateEvent(value: unknown): ValidationResult<TypingUpdateEvent> {
  if (!isPlainRecord(value)) return failInvalid("Typing update event must be a JSON object.");
  const keyError = checkAllowedKeys(value, TYPING_UPDATE_EVENT_FIELDS);
  if (keyError) return failInvalid(keyError);
  const sv = requireSchemaVersion(value);
  if (!sv.ok) return sv;
  if (!isOpaqueId(value.conversationId) || !isOpaqueId(value.userId)) {
    return failInvalid("conversationId and userId must be opaque identifiers.");
  }
  if (typeof value.isTyping !== "boolean") {
    return failInvalid("isTyping must be a boolean.");
  }
  if (value.expiresAt !== null && !isIsoDateString(value.expiresAt)) {
    return failInvalid("expiresAt must be an ISO timestamp or null.");
  }
  if (!value.isTyping && value.expiresAt !== null) {
    return failInvalid("expiresAt must be null when isTyping is false.");
  }
  if (value.isTyping && value.expiresAt === null) {
    return failInvalid("expiresAt is required when isTyping is true.");
  }
  if (!isIsoDateString(value.updatedAt)) {
    return failInvalid("updatedAt must be a valid ISO timestamp.");
  }
  return {
    ok: true,
    value: {
      schemaVersion: sv.value,
      conversationId: value.conversationId,
      userId: value.userId,
      isTyping: value.isTyping,
      expiresAt: value.expiresAt,
      updatedAt: value.updatedAt,
    },
  };
}

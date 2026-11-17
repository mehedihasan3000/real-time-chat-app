/**
 * Conversation create/list contracts v0 (P2-03, FR-CHAT-001, FR-HIST-001,
 * FR-PRIV-003, DATA-002; DEC-008, DEC-016, DEC-020, DEC-023).
 *
 * Provisional under Release-gated DEC-023:
 * - Exactly one immutable direct conversation per unordered participant pair.
 * - Exactly two distinct eligible participant user IDs (`participantIds.length === 2`).
 * - Client requests cannot specify `participantIds`, `userId`, `pairKey`, `lastSeq`,
 *   or block states.
 * - Blocked users attempting `POST /api/v1/conversations` receive generic
 *   `404 USER_UNAVAILABLE`; listings never disclose whether a peer blocked the viewer.
 */
import { checkSchemaVersion, validatePageLimit, type ValidationResult } from "./v0.js";

export const CONVERSATION_SCHEMA_VERSION = 1;

/** Approved rate limits for POST /api/v1/conversations (DEC-016). */
export const CONVERSATION_CREATE_LIMIT_PER_HOUR = 10;
export const CONVERSATION_CREATE_LIMIT_PER_DAY = 50;

/**
 * Strict opaque user identifier check. Disallows whitespace, control chars, `$`,
 * `/`, and `:` so server `pairKey` delimiters cannot collide.
 */
export const OPAQUE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

const CREATE_REQUEST_FIELDS = new Set(["schemaVersion", "peerUserId"]);
const LIST_QUERY_FIELDS = new Set(["before", "limit"]);
const PEER_SUMMARY_FIELDS = new Set(["userId", "username", "displayName", "avatar"]);
const CONVERSATION_SUMMARY_FIELDS = new Set([
  "id",
  "schemaVersion",
  "participantIds",
  "peer",
  "lastSeq",
  "createdAt",
  "lastActivityAt",
  "blockedByViewer",
]);
const CREATE_RESPONSE_FIELDS = new Set(["conversation", "created"]);
const DETAIL_RESPONSE_FIELDS = new Set(["conversation"]);
const LIST_RESPONSE_FIELDS = new Set(["items", "nextCursor", "hasMore"]);

/** Fields that must never be accepted from clients or returned in public payloads. */
export const CONVERSATION_FORBIDDEN_FIELDS = [
  "pairKey",
  "email",
  "presence",
  "lastSeen",
  "plaintext",
  "text",
  "body",
  "content",
  "ciphertext",
  "encryptedEnvelope",
  "privateKey",
  "recoveryKey",
  "blockedByPeer",
  "isBlockedByPeer",
] as const;

export interface CreateConversationRequest {
  schemaVersion: 1;
  peerUserId: string;
}

export interface ConversationPeerSummary {
  userId: string;
  username: string | null;
  displayName: string | null;
  avatar: null;
}

export interface ConversationSummary {
  id: string;
  schemaVersion: 1;
  participantIds: [string, string];
  peer: ConversationPeerSummary;
  lastSeq: number;
  createdAt: string;
  lastActivityAt: string;
  /** True only when the authenticated requester has an active block on this peer. */
  blockedByViewer: boolean;
}

export interface ConversationCreateResponse {
  conversation: ConversationSummary;
  created: boolean;
}

export interface ConversationDetailResponse {
  conversation: ConversationSummary;
}

export interface ConversationListResponse {
  items: ConversationSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ConversationListCursor {
  v: 1;
  lastActivityAt: string;
  id: string;
}

export interface ConversationListQuery {
  limit: number;
  before: ConversationListCursor | null;
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

function invalidCursor<T = never>(
  message = "Conversation cursor is invalid.",
): ValidationResult<T> {
  return { ok: false, code: "INVALID_CURSOR", message, retryable: false };
}

export function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_RE.test(value);
}

/**
 * Deterministic canonical participant pair helper (DEC-023 §9.1 / DATA-002).
 * Rejects self-pairs and invalid identifiers.
 */
export function canonicalConversationPair(
  userA: string,
  userB: string,
): { pairKey: string; participantIds: [string, string] } {
  if (!isOpaqueId(userA) || !isOpaqueId(userB) || userA === userB) {
    throw new Error("Conversation pair requires two distinct valid opaque user IDs.");
  }
  const participantIds: [string, string] = userA < userB ? [userA, userB] : [userB, userA];
  return {
    pairKey: `${participantIds[0]}:${participantIds[1]}`,
    participantIds,
  };
}

export function validateCreateConversationRequest(
  input: unknown,
): ValidationResult<CreateConversationRequest> {
  if (!isPlainRecord(input)) {
    return invalidRequest("Request body must be a JSON object.");
  }
  const versionCheck = checkSchemaVersion(input.schemaVersion);
  if (!versionCheck.ok) {
    return {
      ok: false,
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `Unsupported schemaVersion. Expected ${CONVERSATION_SCHEMA_VERSION}.`,
      retryable: false,
    };
  }
  if (!hasOnlyAllowedKeys(input, CREATE_REQUEST_FIELDS)) {
    return invalidRequest("Conversation creation accepts only schemaVersion and peerUserId.");
  }
  if (!isOpaqueId(input.peerUserId)) {
    return invalidRequest("peerUserId must be a valid user identifier.");
  }
  return {
    ok: true,
    value: {
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      peerUserId: input.peerUserId,
    },
  };
}

export function encodeConversationCursor(lastActivityAt: string, id: string): string {
  const json = JSON.stringify({ v: 1, lastActivityAt, id });
  return globalThis.btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeConversationCursor(
  raw: unknown,
): ValidationResult<ConversationListCursor | null> {
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) {
    return invalidCursor();
  }
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) {
    return invalidCursor();
  }
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const withPad = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    const json = globalThis.atob(withPad);
    const parsed: unknown = JSON.parse(json);
    if (!isPlainRecord(parsed)) return invalidCursor();
    if (!hasOnlyAllowedKeys(parsed, new Set(["v", "lastActivityAt", "id"]))) {
      return invalidCursor();
    }
    if (parsed.v !== 1) return invalidCursor();
    if (
      typeof parsed.lastActivityAt !== "string" ||
      Number.isNaN(Date.parse(parsed.lastActivityAt))
    ) {
      return invalidCursor();
    }
    if (!isOpaqueId(parsed.id)) return invalidCursor();
    return {
      ok: true,
      value: {
        v: 1,
        lastActivityAt: parsed.lastActivityAt,
        id: parsed.id,
      },
    };
  } catch {
    return invalidCursor();
  }
}

export function validateConversationListQuery(
  query: unknown,
): ValidationResult<ConversationListQuery> {
  if (!isPlainRecord(query)) {
    return invalidRequest("Invalid query parameters.");
  }
  if (!hasOnlyAllowedKeys(query, LIST_QUERY_FIELDS)) {
    return invalidRequest("Conversation listing supports only before and limit.");
  }
  const limit = validatePageLimit(query.limit);
  if (!limit.ok) return limit;
  const before = decodeConversationCursor(query.before);
  if (!before.ok) return before;
  return {
    ok: true,
    value: {
      limit: limit.value,
      before: before.value,
    },
  };
}

function validatePeerSummary(input: unknown): ValidationResult<ConversationPeerSummary> {
  if (!isPlainRecord(input) || !hasOnlyAllowedKeys(input, PEER_SUMMARY_FIELDS)) {
    return invalidRequest("Invalid conversation peer summary.");
  }
  if (!isOpaqueId(input.userId)) {
    return invalidRequest("Invalid peer userId.");
  }
  if (input.username !== null && typeof input.username !== "string") {
    return invalidRequest("Invalid peer username.");
  }
  if (input.displayName !== null && typeof input.displayName !== "string") {
    return invalidRequest("Invalid peer displayName.");
  }
  if (input.avatar !== null) {
    return invalidRequest("Invalid peer avatar.");
  }
  return {
    ok: true,
    value: {
      userId: input.userId,
      username: input.username,
      displayName: input.displayName,
      avatar: null,
    },
  };
}

export function validateConversationSummary(input: unknown): ValidationResult<ConversationSummary> {
  if (!isPlainRecord(input) || !hasOnlyAllowedKeys(input, CONVERSATION_SUMMARY_FIELDS)) {
    return invalidRequest("Invalid conversation summary.");
  }
  if (input.schemaVersion !== CONVERSATION_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `Unsupported schemaVersion. Expected ${CONVERSATION_SCHEMA_VERSION}.`,
      retryable: false,
    };
  }
  if (!isOpaqueId(input.id)) {
    return invalidRequest("Invalid conversation ID.");
  }
  if (
    !Array.isArray(input.participantIds) ||
    input.participantIds.length !== 2 ||
    !isOpaqueId(input.participantIds[0]) ||
    !isOpaqueId(input.participantIds[1]) ||
    input.participantIds[0] === input.participantIds[1]
  ) {
    return invalidRequest("Conversation must have exactly two distinct participants.");
  }
  const peer = validatePeerSummary(input.peer);
  if (!peer.ok) return peer;
  if (!input.participantIds.includes(peer.value.userId)) {
    return invalidRequest("Conversation peer must be a participant.");
  }
  if (typeof input.lastSeq !== "number" || !Number.isInteger(input.lastSeq) || input.lastSeq < 0) {
    return invalidRequest("Invalid lastSeq.");
  }
  if (
    typeof input.createdAt !== "string" ||
    Number.isNaN(Date.parse(input.createdAt)) ||
    typeof input.lastActivityAt !== "string" ||
    Number.isNaN(Date.parse(input.lastActivityAt))
  ) {
    return invalidRequest("Invalid conversation timestamps.");
  }
  if (typeof input.blockedByViewer !== "boolean") {
    return invalidRequest("Invalid blockedByViewer flag.");
  }
  return {
    ok: true,
    value: {
      id: input.id,
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      participantIds: [input.participantIds[0], input.participantIds[1]],
      peer: peer.value,
      lastSeq: input.lastSeq,
      createdAt: input.createdAt,
      lastActivityAt: input.lastActivityAt,
      blockedByViewer: input.blockedByViewer,
    },
  };
}

export function validateConversationCreateResponse(
  input: unknown,
): ValidationResult<ConversationCreateResponse> {
  if (!isPlainRecord(input) || !hasOnlyAllowedKeys(input, CREATE_RESPONSE_FIELDS)) {
    return invalidRequest("Invalid conversation create response.");
  }
  if (typeof input.created !== "boolean") {
    return invalidRequest("Invalid created flag.");
  }
  const conversation = validateConversationSummary(input.conversation);
  if (!conversation.ok) return conversation;
  return {
    ok: true,
    value: {
      conversation: conversation.value,
      created: input.created,
    },
  };
}

export function validateConversationDetailResponse(
  input: unknown,
): ValidationResult<ConversationDetailResponse> {
  if (!isPlainRecord(input) || !hasOnlyAllowedKeys(input, DETAIL_RESPONSE_FIELDS)) {
    return invalidRequest("Invalid conversation detail response.");
  }
  const conversation = validateConversationSummary(input.conversation);
  if (!conversation.ok) return conversation;
  return {
    ok: true,
    value: {
      conversation: conversation.value,
    },
  };
}

export function validateConversationListResponse(
  input: unknown,
): ValidationResult<ConversationListResponse> {
  if (!isPlainRecord(input) || !hasOnlyAllowedKeys(input, LIST_RESPONSE_FIELDS)) {
    return invalidRequest("Invalid conversation list response.");
  }
  if (!Array.isArray(input.items) || typeof input.hasMore !== "boolean") {
    return invalidRequest("Invalid conversation list fields.");
  }
  if (input.nextCursor !== null && typeof input.nextCursor !== "string") {
    return invalidRequest("Invalid conversation nextCursor.");
  }
  if (typeof input.nextCursor === "string") {
    const cursorCheck = decodeConversationCursor(input.nextCursor);
    if (!cursorCheck.ok) return cursorCheck;
  }
  const items: ConversationSummary[] = [];
  for (const rawItem of input.items) {
    const validated = validateConversationSummary(rawItem);
    if (!validated.ok) return validated;
    items.push(validated.value);
  }
  return {
    ok: true,
    value: {
      items,
      nextCursor: input.nextCursor,
      hasMore: input.hasMore,
    },
  };
}

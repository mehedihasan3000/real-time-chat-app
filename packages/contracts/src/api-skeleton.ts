/**
 * API skeleton contracts v0 (P1-08) — documented request/response shapes
 * and public-field allowlists for every skeleton route.
 *
 * Provisional under Release-gated DEC-023. Every route's `data` payload
 * contains ONLY the fields listed in `PUBLIC_FIELDS`; tests fail if a
 * route leaks an undocumented field. Placeholders return documented
 * empty/503 shapes and never mutate private stores.
 */
import type { HistoryPageResponse } from "./history-v0.js";
import type { ValidationResult } from "./v0.js";

/* ---------------------------------- Me ---------------------------------- */

export interface MeResponse {
  userId: string;
  emailVerified: boolean;
  role: "user" | "operator";
  sessionFresh: boolean;
}

/* -------------------------------- Discovery ------------------------------- */

export interface DiscoveryUser {
  userId: string;
  username: string;
  displayName: string;
  avatar: null;
}

export interface DiscoveryResponse {
  items: DiscoveryUser[];
}

const USERNAME_RE = /^[a-z][a-z0-9_]{2,23}$/;
const RESERVED = new Set(["admin", "support", "system"]);

/** Exact normalized username only (DEC-020). No prefix/email lookup. */
export function validateDiscoveryUsername(value: unknown): ValidationResult<string> {
  if (typeof value !== "string" || !USERNAME_RE.test(value) || RESERVED.has(value)) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Provide an exact normalized username.",
      retryable: false,
    };
  }
  return { ok: true, value };
}

/* ------------------------------ Conversations ---------------------------- */
// Conversation list/create/detail shapes live in `conversations-v0.ts` (P2-03);
// history pagination shapes live in `history-v0.ts` (P2-07). Keep `HistoryResponse`
// alias and documented `PUBLIC_FIELDS` allowlists here.

export type HistoryResponse = HistoryPageResponse;

/* ---------------------------------- Calls -------------------------------- */

export interface CallSummary {
  callId: string;
  participantIds: string[];
  state: string;
}

export interface CallListResponse {
  items: CallSummary[];
}

/* ------------------------------ Device keys ------------------------------ */
// Device directory shapes live in `device-keys-v0.ts` (P2-01); the skeleton
// only keeps the documented allowlists below.

/* ------------------------------- Key backup ------------------------------ */

export interface KeyBackupSummary {
  id: string;
}

export interface KeyBackupListResponse {
  items: KeyBackupSummary[];
}

/* --------------------------------- Blocks -------------------------------- */

export interface BlockSummary {
  blockedUserId: string;
}

export interface BlockListResponse {
  items: BlockSummary[];
}

/* -------------------------------- Reports -------------------------------- */

export const REPORT_REASONS = ["spam", "harassment", "impersonation", "illegal", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export function validateReportReason(value: unknown): ValidationResult<ReportReason> {
  if (typeof value !== "string" || !(REPORT_REASONS as readonly string[]).includes(value)) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "reason must be an approved report reason.",
      retryable: false,
    };
  }
  return { ok: true, value: value as ReportReason };
}

export interface ReportSummary {
  reportId: string;
  status: string;
}

export interface ReportListResponse {
  items: ReportSummary[];
}

/* ---------------------------------- AI ----------------------------------- */

export const AI_FEATURES = ["smart-reply", "translation", "summary"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/* -------------------------------- Health --------------------------------- */

export interface ReadyResponse {
  ready: boolean;
  service: "api";
}

/* ------------------------- Documented public fields ---------------------- */

/**
 * Per-route data allowlists. Handlers must project responses through these
 * keys; the skeleton tests assert no extra key is emitted (INT-001 / ERR-001).
 */
export const PUBLIC_FIELDS = {
  me: ["userId", "emailVerified", "role", "sessionFresh"],
  discovery: ["items"],
  discoveryUser: ["userId", "username", "displayName", "avatar"],
  conversationList: ["items", "nextCursor", "hasMore"],
  conversationSummary: [
    "id",
    "schemaVersion",
    "participantIds",
    "peer",
    "lastSeq",
    "createdAt",
    "lastActivityAt",
    "blockedByViewer",
  ],
  conversationCreate: ["conversation", "created"],
  conversationDetail: ["conversation"],
  conversationPeer: ["userId", "username", "displayName", "avatar"],
  history: ["items", "nextCursor", "hasMore", "latestSeq"],
  historyItem: [
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
  ],
  messageAck: [
    "messageId",
    "conversationId",
    "seq",
    "senderUserId",
    "senderDeviceId",
    "clientMessageId",
    "protocolVersion",
    "committedAt",
    "schemaVersion",
  ],
  messageNew: [
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
  ],
  messageSend: ["message", "idempotent"],
  messageReceipt: [
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
  ],
  messageReceiptEvent: [
    "schemaVersion",
    "messageId",
    "conversationId",
    "seq",
    "senderUserId",
    "recipientUserId",
    "recipientDeviceId",
    "stage",
    "deliveredAt",
    "readAt",
    "updatedAt",
  ],
  receiptSubmit: ["accepted", "suppressedReason", "stage", "recordedAt"],
  receiptList: ["items", "latestSeq"],
  readProgress: [
    "schemaVersion",
    "conversationId",
    "userId",
    "readThroughSeq",
    "latestSeq",
    "unreadCount",
    "updatedAt",
  ],
  receiptPreferences: ["schemaVersion", "userId", "readReceiptsEnabled", "updatedAt"],
  activityPreferences: ["schemaVersion", "userId", "activitySharingEnabled", "updatedAt"],
  conversationPresence: [
    "schemaVersion",
    "conversationId",
    "peerUserId",
    "status",
    "typing",
    "typingExpiresAt",
    "updatedAt",
  ],
  typingSignalResult: [
    "schemaVersion",
    "conversationId",
    "userId",
    "isTyping",
    "accepted",
    "coalesced",
    "suppressed",
    "expiresAt",
    "updatedAt",
  ],
  presenceUpdateEvent: ["schemaVersion", "conversationId", "userId", "status", "updatedAt"],
  typingUpdateEvent: [
    "schemaVersion",
    "conversationId",
    "userId",
    "isTyping",
    "expiresAt",
    "updatedAt",
  ],
  callList: ["items"],
  callSummary: ["callId", "participantIds", "state"],
  deviceList: ["items"],
  deviceSummary: [
    "deviceId",
    "isActive",
    "status",
    "algorithm",
    "createdAt",
    "updatedAt",
    "revokedAt",
    "replacedByDeviceId",
    "backupLinked",
  ],
  deviceKey: ["device", "backupLink"],
  deviceDirectory: ["userId", "device"],
  deviceEnrollment: ["device", "replacedDeviceId", "backupRequired"],
  deviceRevocation: ["deviceId", "status", "revokedAt", "replacedByDeviceId"],
  keyBackupLink: ["deviceId", "link"],
  keyBackupList: ["items"],
  keyBackupSummary: ["id"],
  blockList: ["items"],
  blockSummary: ["blockedUserId"],
  reportList: ["items"],
  reportSummary: ["reportId", "status"],
  ready: ["ready", "service"],
} as const;

/** Assert `data` contains only allowlisted keys (used by tests/docs). */
export function hasOnlyFields(data: unknown, allowed: readonly string[]): boolean {
  if (typeof data !== "object" || data === null) return false;
  return Object.keys(data).every((key) => allowed.includes(key));
}

export const PLACEHOLDER_MESSAGE =
  "This endpoint is a skeleton placeholder in P1-08 and does not yet mutate private data.";

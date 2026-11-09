/**
 * API skeleton contracts v0 (P1-08) — documented request/response shapes
 * and public-field allowlists for every skeleton route.
 *
 * Provisional under Release-gated DEC-023. Every route's `data` payload
 * contains ONLY the fields listed in `PUBLIC_FIELDS`; tests fail if a
 * route leaks an undocumented field. Placeholders return documented
 * empty/503 shapes and never mutate private stores.
 */
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

export interface ConversationSummary {
  id: string;
  participantIds: string[];
  lastSeq: number;
}

export interface ConversationListResponse {
  items: ConversationSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface HistoryResponse {
  items: Array<{
    id: string;
    seq: number;
    senderUserId: string;
    committedAt: string;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
}

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

export interface DeviceSummary {
  deviceId: string;
  isActive: boolean;
}

export interface DeviceListResponse {
  items: DeviceSummary[];
}

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
  conversationSummary: ["id", "participantIds", "lastSeq"],
  history: ["items", "nextCursor", "hasMore"],
  historyItem: ["id", "seq", "senderUserId", "committedAt"],
  callList: ["items"],
  callSummary: ["callId", "participantIds", "state"],
  deviceList: ["items"],
  deviceSummary: ["deviceId", "isActive"],
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

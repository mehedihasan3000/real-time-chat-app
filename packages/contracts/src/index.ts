/**
 * Shared, transport-agnostic contracts between the web client and the API.
 *
 * This package is intentionally minimal in the scaffold. Canonical message,
 * auth, and conversation contracts are gated by DEC-023 and land with the
 * tasks that implement them.
 */

export const contractsVersion = "0.1.0";

/**
 * The approved interface languages. Locale persistence is a profile preference
 * under DEC-023; the web preview currently stores only the non-sensitive
 * interface choice in browser localStorage.
 */
export const supportedLocales = ["en", "bn"] as const;

export type Locale = (typeof supportedLocales)[number];

export const defaultLocale: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (supportedLocales as readonly string[]).includes(value);
}

/**
 * Stable client-facing error codes from DEC-023 §8.3. The full error envelope
 * and its HTTP status mapping remain release-gated; clients must branch on
 * these codes and never display raw provider or database text.
 */
export const errorCodes = [
  "INVALID_REQUEST",
  "INVALID_CURSOR",
  "UNAUTHENTICATED",
  "SESSION_REVOKED",
  "FORBIDDEN",
  "NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "UNSUPPORTED_SCHEMA_VERSION",
  "CLIENT_UPGRADE_REQUIRED",
  "TEMPORARILY_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (errorCodes as readonly string[]).includes(value);
}

export interface HealthResponse {
  status: "ok";
  service: "api";
  contractsVersion: string;
}

export { dataCollections, pageBounds, releaseGatedFields, schemaVersion } from "./data-schema.js";

export {
  BODY_MAX_BYTES,
  ENVELOPE_MAX_BYTES,
  ERROR_HTTP_STATUS,
  PAGE_DEFAULT,
  PAGE_MAX,
  SCHEMA_VERSION,
  SOCKET_EVENTS,
  checkSchemaVersion,
  decodeCursor,
  encodeCursor,
  failureEnvelope,
  isRequestId,
  newRequestId,
  successEnvelope,
  validateHistoryQuery,
  validatePageLimit,
  validateSendMessageRequest,
  validateSocketPayload,
  type Cursor,
  type Envelope,
  type FailureEnvelope,
  type HistoryQuery,
  type PageBounds,
  type SocketEvent,
  type SocketPayload,
  type SuccessEnvelope,
  type ValidationResult,
} from "./v0.js";

export {
  FRESH_SESSION_SECONDS,
  JWT_LIFETIME_SECONDS,
  PASSWORD_MAX,
  PASSWORD_MIN,
  RECOVERY_ADMIN_BYPASS,
  RECOVERY_EMAIL_ONLY,
  RECOVERY_SMS_ENABLED,
  SESSION_ABSOLUTE_DAYS,
  SESSION_CACHE_SECONDS,
  SESSION_DEFAULT_DAYS,
  SESSION_REMEMBER_DAYS,
  exceedsAbsoluteCap,
  isFreshSession,
  validatePassword,
} from "./auth-v0.js";

export {
  AI_FEATURES,
  PLACEHOLDER_MESSAGE,
  PUBLIC_FIELDS,
  REPORT_REASONS,
  hasOnlyFields,
  validateDiscoveryUsername,
  validateReportReason,
  type AiFeature,
  type BlockListResponse,
  type BlockSummary,
  type CallListResponse,
  type CallSummary,
  type ConversationListResponse,
  type ConversationSummary,
  type DeviceListResponse,
  type DeviceSummary,
  type DiscoveryResponse,
  type DiscoveryUser,
  type HistoryResponse,
  type KeyBackupListResponse,
  type KeyBackupSummary,
  type MeResponse,
  type ReadyResponse,
  type ReportListResponse,
  type ReportReason,
  type ReportSummary,
} from "./api-skeleton.js";

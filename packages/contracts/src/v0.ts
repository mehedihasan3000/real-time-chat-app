/**
 * Shared contracts v0 (P1-05) — HTTP requests/responses, socket events,
 * error envelope, request IDs, versioning, pagination, idempotency,
 * validation. Provisional under Release-gated DEC-023.
 *
 * Plain TypeScript validators (no zod in this package) so web and API
 * share the exact same rules. No raw provider/database text is ever
 * returned; clients branch on `error.code` + `retryable` (DEC-023 §8.3).
 */

export const SCHEMA_VERSION = 1;

/** Encrypted envelope bound (DEC-016): 16 KiB after base64url decode. */
export const ENVELOPE_MAX_BYTES = 16 * 1024;
/** Body bound (DEC-016): 32 KiB JSON. */
export const BODY_MAX_BYTES = 32 * 1024;
/** Cursor bounds (DEC-023 §7): default 50, max 100. */
export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;

export type PageBounds = { default: number; max: number };

// ---------------------------------------------------------------------------
// Request IDs (server-generated, safe to display as support reference)
// ---------------------------------------------------------------------------

export function newRequestId(): string {
  // crypto.randomUUID() is available in Node 19+ and browsers.
  return globalThis.crypto.randomUUID();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// ---------------------------------------------------------------------------
// Error envelope (DEC-023 §8.2/§8.3)
// ---------------------------------------------------------------------------

export const ERROR_HTTP_STATUS = {
  INVALID_REQUEST: 400,
  INVALID_CURSOR: 400,
  UNAUTHENTICATED: 401,
  SESSION_REVOKED: 401,
  FORBIDDEN: 403,
  DEVICE_REVOKED: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  DEVICE_REPLACEMENT_REQUIRED: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  UNSUPPORTED_SCHEMA_VERSION: 422,
  CLIENT_UPGRADE_REQUIRED: 426,
  TEMPORARILY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;

export type Retryable = boolean;

export interface ContractError {
  code: ErrorCode;
  /** Safe, non-sensitive summary. Never includes ciphertext, tokens, or DB details. */
  message: string;
  retryable: Retryable;
}

export interface SuccessEnvelope<T> {
  ok: true;
  requestId: string;
  data: T;
}

export interface FailureEnvelope {
  ok: false;
  requestId: string;
  error: ContractError;
}

export type Envelope<T> = SuccessEnvelope<T> | FailureEnvelope;

export function successEnvelope<T>(data: T, requestId?: string): SuccessEnvelope<T> {
  return { ok: true, requestId: requestId ?? newRequestId(), data };
}

export function failureEnvelope(
  code: ErrorCode,
  message: string,
  retryable: boolean,
  requestId?: string,
): FailureEnvelope {
  return { ok: false, requestId: requestId ?? newRequestId(), error: { code, message, retryable } };
}

// ---------------------------------------------------------------------------
// Versioning (DEC-023 §8.1)
// ---------------------------------------------------------------------------

export type VersionCheck = { ok: true } | { ok: false; code: "UNSUPPORTED_SCHEMA_VERSION" };

export function checkSchemaVersion(value: unknown): VersionCheck {
  return value === SCHEMA_VERSION
    ? { ok: true }
    : { ok: false, code: "UNSUPPORTED_SCHEMA_VERSION" };
}

// ---------------------------------------------------------------------------
// Send-message request (DEC-023 §3.1)
// ---------------------------------------------------------------------------

export interface SendMessageRequest {
  schemaVersion: number;
  clientMessageId: string;
  senderDeviceId: string;
  protocolVersion: string;
  encryptedEnvelope: string;
}

export type ValidationResult<T> =
  { ok: true; value: T } | { ok: false; code: ErrorCode; message: string; retryable: boolean };

function base64UrlByteLength(value: string): number | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) return null;
  if (value.length === 0 || value.length % 4 === 1) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const withPad = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    // atob is global in Node 16+ and browsers; avoid Buffer (Node-only) in shared contracts.
    const binary = globalThis.atob(withPad);
    if (binary.length === 0) return null;
    return binary.length;
  } catch {
    return null;
  }
}

export function validateSendMessageRequest(input: unknown): ValidationResult<SendMessageRequest> {
  if (typeof input !== "object" || input === null) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Request body must be a JSON object.",
      retryable: false,
    };
  }
  const body = input as Record<string, unknown>;

  const versionCheck = checkSchemaVersion(body.schemaVersion);
  if (!versionCheck.ok) {
    return {
      ok: false,
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `Unsupported schemaVersion. Expected ${SCHEMA_VERSION}.`,
      retryable: false,
    };
  }

  if (!isRequestId(body.clientMessageId)) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "clientMessageId must be a UUID.",
      retryable: false,
    };
  }
  if (
    typeof body.senderDeviceId !== "string" ||
    body.senderDeviceId.length === 0 ||
    body.senderDeviceId.length > 128
  ) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "senderDeviceId is required.",
      retryable: false,
    };
  }
  if (
    typeof body.protocolVersion !== "string" ||
    body.protocolVersion.length === 0 ||
    body.protocolVersion.length > 32
  ) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "protocolVersion is required.",
      retryable: false,
    };
  }
  if (typeof body.encryptedEnvelope !== "string" || body.encryptedEnvelope.length === 0) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "encryptedEnvelope is required.",
      retryable: false,
    };
  }
  const envBytes = base64UrlByteLength(body.encryptedEnvelope);
  if (envBytes === null) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "encryptedEnvelope must be base64url.",
      retryable: false,
    };
  }
  if (envBytes > ENVELOPE_MAX_BYTES) {
    return {
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
      message: "encryptedEnvelope exceeds 16 KiB.",
      retryable: false,
    };
  }

  return {
    ok: true,
    value: {
      schemaVersion: SCHEMA_VERSION,
      clientMessageId: body.clientMessageId,
      senderDeviceId: body.senderDeviceId,
      protocolVersion: body.protocolVersion,
      encryptedEnvelope: body.encryptedEnvelope,
    },
  };
}

// ---------------------------------------------------------------------------
// Pagination + cursors (DEC-023 §7)
// ---------------------------------------------------------------------------

export function validatePageLimit(limit: unknown): ValidationResult<number> {
  if (limit === undefined) return { ok: true, value: PAGE_DEFAULT };
  const n = typeof limit === "string" ? Number(limit) : limit;
  if (typeof n !== "number" || !Number.isInteger(n)) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "limit must be an integer.",
      retryable: false,
    };
  }
  if (n < 1)
    return { ok: false, code: "INVALID_REQUEST", message: "limit must be >= 1.", retryable: false };
  if (n > PAGE_MAX)
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: `limit must be <= ${PAGE_MAX}.`,
      retryable: false,
    };
  return { ok: true, value: n };
}

export interface Cursor {
  v: 1;
  seq: number;
}

export function encodeCursor(seq: number): string {
  const json = JSON.stringify({ v: 1, seq });
  return globalThis.btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(raw: string | undefined): ValidationResult<Cursor | null> {
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, code: "INVALID_CURSOR", message: "Cursor is invalid.", retryable: false };
  }
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const withPad = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    const json = globalThis.atob(withPad);
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Record<string, unknown>).v !== 1 ||
      typeof (parsed as Record<string, unknown>).seq !== "number" ||
      !Number.isInteger((parsed as Record<string, unknown>).seq as number) ||
      ((parsed as Record<string, unknown>).seq as number) < 0
    ) {
      return { ok: false, code: "INVALID_CURSOR", message: "Cursor is invalid.", retryable: false };
    }
    return { ok: true, value: { v: 1, seq: (parsed as Record<string, unknown>).seq as number } };
  } catch {
    return { ok: false, code: "INVALID_CURSOR", message: "Cursor is invalid.", retryable: false };
  }
}

export interface HistoryQuery {
  limit: number;
  before: Cursor | null;
  after: Cursor | null;
}

export function validateHistoryQuery(
  query: Record<string, unknown>,
): ValidationResult<HistoryQuery> {
  const limit = validatePageLimit(query.limit);
  if (!limit.ok) return limit;
  const before = decodeCursor(query.before as string | undefined);
  if (!before.ok) return before;
  const after = decodeCursor(query.after as string | undefined);
  if (!after.ok) return after;
  if (before.value !== null && after.value !== null) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Provide either before or after, not both.",
      retryable: false,
    };
  }
  return { ok: true, value: { limit: limit.value, before: before.value, after: after.value } };
}

// ---------------------------------------------------------------------------
// Socket events (DEC-023: /v1 namespace; live events only, no second write path)
// ---------------------------------------------------------------------------

export const SOCKET_EVENTS = [
  "message:new",
  "message:receipt",
  "presence:update",
  "typing:update",
  "call:ringing",
  "call:connected",
  "call:ended",
  "block:created",
  "block:removed",
  "report:submitted",
  "report:disposition",
] as const;

export type SocketEvent = (typeof SOCKET_EVENTS)[number];

export interface SocketPayload<T = Record<string, unknown>> {
  schemaVersion: number;
  conversationId?: string;
  data: T;
}

export function validateSocketPayload(input: unknown): ValidationResult<SocketPayload> {
  if (typeof input !== "object" || input === null) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Socket payload must be an object.",
      retryable: false,
    };
  }
  const body = input as Record<string, unknown>;
  const versionCheck = checkSchemaVersion(body.schemaVersion);
  if (!versionCheck.ok) {
    return {
      ok: false,
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: "Unsupported schemaVersion.",
      retryable: false,
    };
  }
  if (typeof body.data !== "object" || body.data === null) {
    return { ok: false, code: "INVALID_REQUEST", message: "data is required.", retryable: false };
  }
  return {
    ok: true,
    value: {
      schemaVersion: SCHEMA_VERSION,
      conversationId: typeof body.conversationId === "string" ? body.conversationId : undefined,
      data: body.data as Record<string, unknown>,
    },
  };
}

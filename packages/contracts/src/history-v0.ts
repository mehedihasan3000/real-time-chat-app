/**
 * Encrypted conversation history & catch-up pagination contracts v0 (P2-07,
 * FR-CHAT-012, FR-HIST-002, INT-006, DATA-003..004, DATA-007; DEC-016, DEC-021,
 * DEC-023).
 *
 * Provisional under Release-gated DEC-023 (`cursor encoding`, `query/item schemas`,
 * `index/driver execution`):
 * - History queries are bounded at `PAGE_DEFAULT = 50` / `PAGE_MAX = 100`.
 * - Cursors are opaque base64url JSON scoped to the route `conversationId`
 *   (`{ v: 1, conversationId, seq }`); invalid, tampered, or foreign-conversation
 *   cursors fail with `400 INVALID_CURSOR` and offsets are never accepted.
 * - Items mirror `MessageNewEvent` (ciphertext + server order metadata only;
 *   never plaintext, private keys, or `payloadHash`).
 */
import { isOpaqueId } from "./conversations-v0.js";
import {
  MESSAGE_FORBIDDEN_FIELDS,
  validateMessageNewEvent,
  type MessageNewEvent,
} from "./messages-v0.js";
import { PAGE_DEFAULT, PAGE_MAX, validatePageLimit, type ValidationResult } from "./v0.js";

export const HISTORY_SCHEMA_VERSION = 1 as const;
export const HISTORY_CURSOR_VERSION = 1 as const;
export const HISTORY_PAGE_DEFAULT = PAGE_DEFAULT;
export const HISTORY_PAGE_MAX = PAGE_MAX;

const HISTORY_QUERY_FIELDS = new Set(["before", "after", "limit"]);
const HISTORY_CURSOR_FIELDS = new Set(["v", "conversationId", "seq"]);
const HISTORY_RESPONSE_FIELDS = new Set(["items", "nextCursor", "hasMore", "latestSeq"]);
const HISTORY_FORBIDDEN_FIELDS = new Set<string>([...MESSAGE_FORBIDDEN_FIELDS, "payloadHash"]);

export interface HistoryCursor {
  v: 1;
  conversationId: string;
  seq: number;
}

export type HistoryPaginationMode = "before" | "after";

export interface ConversationHistoryQuery {
  limit: number;
  before: HistoryCursor | null;
  after: HistoryCursor | null;
  mode: HistoryPaginationMode;
}

/** Ciphertext-only retained history record (`PUBLIC_FIELDS.historyItem`). */
export type HistoryMessageItem = MessageNewEvent;

export interface HistoryPageResponse {
  items: HistoryMessageItem[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Present as diagnostic metadata on catch-up (`after`) responses per DEC-021 §7.3. */
  latestSeq?: number;
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
  message = "Cursor is invalid or scoped to another conversation.",
): ValidationResult<T> {
  return { ok: false, code: "INVALID_CURSOR", message, retryable: false };
}

function hasForbiddenHistoryKey(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): string | null {
  if (typeof value !== "object" || value === null) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = hasForbiddenHistoryKey(item, seen);
      if (hit) return hit;
    }
    return null;
  }
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (HISTORY_FORBIDDEN_FIELDS.has(key)) return key;
    const hit = hasForbiddenHistoryKey(rec[key], seen);
    if (hit) return hit;
  }
  return null;
}

/**
 * Encode an opaque conversation-scoped history cursor (`DEC-021` §7.1).
 * Uses `globalThis.btoa` so browser and API bundles share identical logic.
 */
export function encodeHistoryCursor(conversationId: string, seq: number): string {
  if (!isOpaqueId(conversationId)) {
    throw new Error("History cursor requires a valid opaque conversationId.");
  }
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    throw new Error("History cursor seq must be a non-negative integer.");
  }
  const json = JSON.stringify({
    v: HISTORY_CURSOR_VERSION,
    conversationId,
    seq,
  });
  return globalThis.btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode an opaque conversation-scoped cursor and reject malformed, tampered,
 * unscoped, or foreign-conversation cursors with `INVALID_CURSOR` (`INT-006`,
 * `TC-HIST-001`, `DEC-021` §7.1).
 */
export function decodeHistoryCursor(
  raw: unknown,
  expectedConversationId: string,
): ValidationResult<HistoryCursor | null> {
  if (raw === undefined) return { ok: true, value: null };
  if (!isOpaqueId(expectedConversationId)) {
    return invalidRequest("Invalid conversation identifier.");
  }
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) {
    return invalidCursor();
  }
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(raw) || raw.length % 4 === 1) {
    return invalidCursor();
  }

  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const withPad = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    const json = globalThis.atob(withPad);
    const parsed: unknown = JSON.parse(json);
    if (!isPlainRecord(parsed) || !hasOnlyAllowedKeys(parsed, HISTORY_CURSOR_FIELDS)) {
      return invalidCursor();
    }
    if (parsed.v !== HISTORY_CURSOR_VERSION) {
      return invalidCursor();
    }
    if (!isOpaqueId(parsed.conversationId)) {
      return invalidCursor();
    }
    if (parsed.conversationId !== expectedConversationId) {
      return invalidCursor("Cursor does not belong to this conversation.");
    }
    if (typeof parsed.seq !== "number" || !Number.isSafeInteger(parsed.seq) || parsed.seq < 0) {
      return invalidCursor();
    }

    return {
      ok: true,
      value: {
        v: HISTORY_CURSOR_VERSION,
        conversationId: parsed.conversationId,
        seq: parsed.seq,
      },
    };
  } catch {
    return invalidCursor();
  }
}

/**
 * Decode catch-up `after` reference (`SRS` §5.2, `DEC-021` §7.3): accepts
 * either a canonical non-negative base-10 integer `lastAppliedSeq` string
 * (`"0"`, `"42"`) or a conversation-scoped opaque cursor from `nextCursor`.
 * Rejects negative numbers, floats, malformed strings, and foreign cursors
 * with `INVALID_CURSOR`.
 */
export function decodeHistoryAfterReference(
  raw: unknown,
  expectedConversationId: string,
): ValidationResult<HistoryCursor | null> {
  if (raw === undefined) return { ok: true, value: null };
  if (!isOpaqueId(expectedConversationId)) {
    return invalidRequest("Invalid conversation identifier.");
  }
  if (typeof raw === "string" && /^(0|[1-9][0-9]{0,15})$/.test(raw)) {
    const seq = Number(raw);
    if (!Number.isSafeInteger(seq) || seq < 0) {
      return invalidCursor();
    }
    return {
      ok: true,
      value: {
        v: HISTORY_CURSOR_VERSION,
        conversationId: expectedConversationId,
        seq,
      },
    };
  }
  return decodeHistoryCursor(raw, expectedConversationId);
}

/**
 * Validate query params for `GET /api/v1/conversations/:id/messages`
 * (`FR-HIST-002`, `INT-006`, `FR-SEC-014`, `TC-HIST-001`).
 */
export function validateConversationHistoryQuery(
  query: unknown,
  expectedConversationId: string,
): ValidationResult<ConversationHistoryQuery> {
  if (!isOpaqueId(expectedConversationId)) {
    return invalidRequest("Invalid conversation identifier.");
  }
  if (!isPlainRecord(query)) {
    return invalidRequest("Invalid history query parameters.");
  }
  if (!hasOnlyAllowedKeys(query, HISTORY_QUERY_FIELDS)) {
    return invalidRequest("History queries support only before, after, and limit.");
  }

  let rawLimit: unknown = query.limit;
  if (rawLimit !== undefined) {
    if (typeof rawLimit === "string") {
      if (!/^[0-9]{1,6}$/.test(rawLimit)) {
        return invalidRequest("limit must be a positive integer.");
      }
      rawLimit = Number(rawLimit);
    } else if (typeof rawLimit !== "number") {
      return invalidRequest("limit must be a positive integer.");
    }
  }

  const limit = validatePageLimit(rawLimit);
  if (!limit.ok) return limit;

  const before = decodeHistoryCursor(query.before, expectedConversationId);
  if (!before.ok) return before;

  const after = decodeHistoryAfterReference(query.after, expectedConversationId);
  if (!after.ok) return after;

  if (before.value !== null && after.value !== null) {
    return invalidRequest("Provide either before or after, not both.");
  }

  return {
    ok: true,
    value: {
      limit: limit.value,
      before: before.value,
      after: after.value,
      mode: after.value !== null ? "after" : "before",
    },
  };
}

export function validateHistoryMessageItem(
  input: unknown,
  expectedConversationId?: string,
): ValidationResult<HistoryMessageItem> {
  const validated = validateMessageNewEvent(input);
  if (!validated.ok) return validated;
  if (
    expectedConversationId !== undefined &&
    validated.value.conversationId !== expectedConversationId
  ) {
    return invalidRequest("History item does not belong to the requested conversation.");
  }
  return validated;
}

export function validateHistoryPageResponse(
  input: unknown,
  expectedConversationId?: string,
): ValidationResult<HistoryPageResponse> {
  if (!isPlainRecord(input) || !hasOnlyAllowedKeys(input, HISTORY_RESPONSE_FIELDS)) {
    return invalidRequest("Invalid history response shape.");
  }
  const forbidden = hasForbiddenHistoryKey(input);
  if (forbidden) {
    return invalidRequest(`Forbidden field "${forbidden}" is not permitted in history responses.`);
  }
  if (!Array.isArray(input.items) || input.items.length > HISTORY_PAGE_MAX) {
    return invalidRequest("History response items must be a bounded array.");
  }

  const items: HistoryMessageItem[] = [];
  const seenIds = new Set<string>();
  let prevSeq = 0;

  for (const rawItem of input.items) {
    const item = validateHistoryMessageItem(rawItem, expectedConversationId);
    if (!item.ok) return item;
    if (seenIds.has(item.value.messageId)) {
      return invalidRequest("History page contains duplicate messageId.");
    }
    if (item.value.seq <= prevSeq) {
      return invalidRequest("History page items must be ordered strictly ascending by seq.");
    }
    seenIds.add(item.value.messageId);
    prevSeq = item.value.seq;
    items.push(item.value);
  }

  if (typeof input.hasMore !== "boolean") {
    return invalidRequest("Invalid hasMore flag on history response.");
  }
  if (input.nextCursor !== null && typeof input.nextCursor !== "string") {
    return invalidRequest("Invalid nextCursor on history response.");
  }
  if (input.nextCursor !== null) {
    const scopeConv = expectedConversationId ?? items[0]?.conversationId;
    if (!scopeConv) {
      return invalidRequest("Empty history page cannot carry a nextCursor without scope.");
    }
    const cursorCheck = decodeHistoryCursor(input.nextCursor, scopeConv);
    if (!cursorCheck.ok) {
      return invalidRequest("History response returned an invalid nextCursor.");
    }
  }
  if (!input.hasMore && input.nextCursor !== null) {
    return invalidRequest("End-of-history page must have nextCursor: null.");
  }
  if (input.hasMore && items.length > 0 && input.nextCursor === null) {
    return invalidRequest("Paginated history page with hasMore must provide nextCursor.");
  }

  let latestSeq: number | undefined;
  if (input.latestSeq !== undefined) {
    if (
      typeof input.latestSeq !== "number" ||
      !Number.isSafeInteger(input.latestSeq) ||
      input.latestSeq < 0
    ) {
      return invalidRequest("Invalid latestSeq metadata.");
    }
    latestSeq = input.latestSeq;
  }

  return {
    ok: true,
    value: {
      items,
      nextCursor: input.nextCursor,
      hasMore: input.hasMore,
      ...(latestSeq !== undefined ? { latestSeq } : {}),
    },
  };
}

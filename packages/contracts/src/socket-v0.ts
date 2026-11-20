import { SCHEMA_VERSION, validateSocketPayload, type ValidationResult } from "./v0.js";

/**
 * Socket contracts v0 (P1-09, extended P2-08) — client→server event names,
 * room names, subscribe payload validation, reconnect backoff bounds, and
 * rate-limit bounds. Provisional under Release-gated DEC-023.
 *
 * Server→client live events remain `SOCKET_EVENTS` in `v0.ts`
 * (message:new, receipts, presence, typing, call, block, report).
 * These constants name the inbound events the foundation handles.
 */
export const SOCKET_NAMESPACE = "/v1";

/** Canonical SRS §5.3 subscription and catch-up event names (P2-08). */
export const SOCKET_SUBSCRIBE_EVENT = "conversation:subscribe" as const;
export const SOCKET_UNSUBSCRIBE_EVENT = "conversation:unsubscribe" as const;
export const SOCKET_SYNC_REQUEST_EVENT = "sync:request" as const;

/** Inbound (client→server) event names handled by the foundation. */
export const SOCKET_CLIENT_EVENTS = [
  "auth:refresh",
  SOCKET_SUBSCRIBE_EVENT,
  SOCKET_UNSUBSCRIBE_EVENT,
  "join",
  "leave",
  "typing",
  "typing:set",
  "receipt",
  "ping",
] as const;

export type SocketClientEvent = (typeof SOCKET_CLIENT_EVENTS)[number];

/** Server→client session lifecycle event (disconnect + reauth required). */
export const SOCKET_SESSION_EXPIRED = "session:expired" as const;

/** Server→client room error event for denied joins/events. */
export const SOCKET_ERROR = "error" as const;

/** Room naming (rooms are conversation-scoped; personal room holds delivery). */
export function conversationRoom(conversationId: string): string {
  return `conversation:${conversationId}`;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** Socket abuse bounds (DEC-016): 120 events/min/connection; typing 1/2s. */
export const SOCKET_EVENT_LIMIT_PER_MINUTE = 120;
export const TYPING_COALESCE_MS = 2000;
export const CONNECTION_LIMIT_PER_MINUTE = 10;

/**
 * Bounded reconnect backoff schedule (NFR-REL-003, DEC-010, DEC-021):
 * 1 / 2 / 4 / 8 / 16 / 30 s cap with ±20% jitter.
 */
export const RECONNECT_BACKOFF_SCHEDULE_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
export const RECONNECT_JITTER_RATIO = 0.2 as const;

/** Refresh interval hint: reauthenticate at most every 5 minutes (JWT max). */
export const REFRESH_MAX_INTERVAL_MS = 5 * 60 * 1000;

export interface ConversationSubscribePayload {
  schemaVersion: typeof SCHEMA_VERSION;
  conversationId: string;
  lastAppliedSeq?: number;
}

export interface ConversationSubscribeAck {
  conversationId: string;
  subscribed: true;
}

const SOCKET_CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Validate `conversation:subscribe` / `join` socket payloads (`INT-001`, `FR-HIST-003`).
 * Enforces `schemaVersion: 1`, a well-formed `conversationId`, optional non-negative
 * `lastAppliedSeq`, and rejects operator keys without trusting client cursors for auth.
 */
export function validateConversationSubscribePayload(
  input: unknown,
): ValidationResult<ConversationSubscribePayload> {
  const validated = validateSocketPayload(input);
  if (!validated.ok) return validated;

  const data = validated.value.data;
  if (Array.isArray(data)) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "data must be a JSON object.",
      retryable: false,
    };
  }
  for (const key of Object.keys(data)) {
    if (key.startsWith("$") || key.includes(".")) {
      return {
        ok: false,
        code: "INVALID_REQUEST",
        message: "Malformed subscribe metadata.",
        retryable: false,
      };
    }
  }

  const topId = validated.value.conversationId;
  const dataId = typeof data.conversationId === "string" ? data.conversationId : undefined;
  if (topId !== undefined && dataId !== undefined && topId !== dataId) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Conflicting conversationId values.",
      retryable: false,
    };
  }
  const conversationId = topId ?? dataId;
  if (!conversationId || !SOCKET_CONVERSATION_ID_RE.test(conversationId)) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "conversationId is required.",
      retryable: false,
    };
  }

  let lastAppliedSeq: number | undefined;
  if (data.lastAppliedSeq !== undefined) {
    if (
      typeof data.lastAppliedSeq !== "number" ||
      !Number.isSafeInteger(data.lastAppliedSeq) ||
      data.lastAppliedSeq < 0
    ) {
      return {
        ok: false,
        code: "INVALID_REQUEST",
        message: "lastAppliedSeq must be a non-negative integer.",
        retryable: false,
      };
    }
    lastAppliedSeq = data.lastAppliedSeq;
  }

  return {
    ok: true,
    value: {
      schemaVersion: SCHEMA_VERSION,
      conversationId,
      ...(lastAppliedSeq !== undefined ? { lastAppliedSeq } : {}),
    },
  };
}

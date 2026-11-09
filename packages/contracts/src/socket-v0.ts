/**
 * Socket contracts v0 (P1-09) — client→server event names, room names,
 * and rate-limit bounds. Provisional under Release-gated DEC-023.
 *
 * Server→client live events remain `SOCKET_EVENTS` in `v0.ts`
 * (message:new, receipts, presence, typing, call, block, report).
 * These constants name the inbound events the foundation handles.
 */
export const SOCKET_NAMESPACE = "/v1";

/** Inbound (client→server) event names handled by the foundation. */
export const SOCKET_CLIENT_EVENTS = [
  "auth:refresh",
  "join",
  "leave",
  "typing",
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

/** Refresh interval hint: reauthenticate at most every 5 minutes (JWT max). */
export const REFRESH_MAX_INTERVAL_MS = 5 * 60 * 1000;

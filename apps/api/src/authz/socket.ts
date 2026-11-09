import type { SOCKET_EVENTS } from "@chat/contracts";

import {
  guardSensitive,
  guardProtected,
  NOT_FOUND,
  SESSION_REVOKED,
  type AuthzResult,
} from "./checks.js";
import type { Principal } from "./principal.js";
import type {
  CallResource,
  ConversationResource,
  MessageResource,
  ReceiptResource,
  ResourceLookup,
} from "./resources.js";

/**
 * Socket event-level authorization (P1-07, INT-004).
 *
 * v0 contract for P1-09 (Socket.IO foundation, Not started): every
 * protected event rechecks resource authorization AND, for sensitive
 * events, current session validity. A formerly valid room never bypasses
 * later invalidation or membership checks. No live Socket.IO server is
 * started here (P1-09 owns transport); these helpers are the authorization
 * surface P1-09 will call on `join`/`on(event)`.
 *
 * Sensitive events (signaling, sends, receipts that advance state) use
 * guardSensitive (fresh session required). Read/subscription events use
 * guardProtected (verified principal). The residual read-only JWT window
 * (≤5 min) is bounded by P1-06 expiry + guards here; it is not extended.
 */

export type SocketEventName = (typeof SOCKET_EVENTS)[number];

export interface SocketAuthorizer {
  conversationLookup: ResourceLookup<ConversationResource>;
  messageLookup?: ResourceLookup<MessageResource>;
  receiptLookup?: ResourceLookup<ReceiptResource>;
  callLookup?: ResourceLookup<CallResource>;
}

/** Sensitive = must hold a fresh session at event time (DEC-019 §3.2). */
const SENSITIVE_EVENTS: ReadonlySet<SocketEventName> = new Set<SocketEventName>([
  "call:ringing",
  "call:connected",
  "call:ended",
  "message:receipt",
]);

function denyNotFound(): AuthzResult {
  return { ok: false, denial: NOT_FOUND };
}
function denyRevoked(): AuthzResult {
  return { ok: false, denial: SESSION_REVOKED };
}

function payloadId(payload: unknown, field: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Authorize joining a conversation-scoped room / subscribing to its events —
 * the stale-room case of TC-SEC-005. `conversationLookup` must return the
 * CURRENT record (not a cached membership snapshot).
 */
export async function authorizeSocketConversationJoin(
  principal: Principal | null,
  conversationId: string,
  authorizer: SocketAuthorizer,
): Promise<AuthzResult> {
  if (!principal) return denyRevoked();
  const gate = guardProtected(principal);
  if (!gate.ok) return gate;
  const conversation = await authorizer.conversationLookup(conversationId);
  if (!conversation) return denyNotFound();
  if (!conversation.participantIds.includes(principal.userId)) return denyNotFound();
  return { ok: true };
}

/**
 * Authorize one protected Socket.IO event at event time. `payload` uses the
 * shared envelope shape from `@chat/contracts` (`conversationId` plus
 * `data` with resource IDs); only server-resolved lookups authorize.
 */
export async function authorizeSocketEvent(
  principal: Principal | null,
  eventName: SocketEventName,
  payload: unknown,
  authorizer: SocketAuthorizer,
): Promise<AuthzResult> {
  if (!principal) return denyRevoked();
  // Sensitive events recheck current session freshness per INT-004.
  const gate = SENSITIVE_EVENTS.has(eventName)
    ? guardSensitive(principal)
    : guardProtected(principal);
  if (!gate.ok) return gate;

  const conversationId =
    payloadId(payload, "conversationId") ??
    payloadId(
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).data
        : null,
      "conversationId",
    );

  switch (eventName) {
    case "message:new":
    case "presence:update":
    case "typing:update": {
      if (!conversationId) return denyNotFound();
      return authorizeSocketConversationJoin(principal, conversationId, authorizer);
    }
    case "message:receipt": {
      const messageId = payloadId(
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>).data
          : null,
        "messageId",
      );
      // Receipts advance sender-visible state; re-resolve the receipt target.
      if (messageId && authorizer.receiptLookup) {
        const receipt = await authorizer.receiptLookup(messageId);
        if (!receipt) return denyNotFound();
        if (principal.userId !== receipt.senderUserId) return denyNotFound();
        return { ok: true };
      }
      if (!conversationId) return denyNotFound();
      return authorizeSocketConversationJoin(principal, conversationId, authorizer);
    }
    case "call:ringing":
    case "call:connected":
    case "call:ended": {
      const callId =
        payloadId(payload, "callId") ??
        payloadId(
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>).data
            : null,
          "callId",
        );
      if (!callId || !authorizer.callLookup) return denyNotFound();
      const call = await authorizer.callLookup(callId);
      if (!call) return denyNotFound();
      if (!call.participantIds.includes(principal.userId)) return denyNotFound();
      return { ok: true };
    }
    case "block:created":
    case "block:removed":
    case "report:submitted":
    case "report:disposition": {
      // Blocker/reporter-scoped server events: privacy-safe payloads carry
      // no cross-user resource IDs; verified principal is sufficient.
      return { ok: true };
    }
    default:
      return denyNotFound();
  }
}

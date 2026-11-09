import { ERROR_HTTP_STATUS, type ErrorCode } from "@chat/contracts";

import { isFreshPrincipal, isOperator, isVerifiedPrincipal, type Principal } from "./principal.js";
import type {
  BlockResource,
  CallResource,
  ConversationResource,
  DeviceResource,
  KeyBackupResource,
  MessageResource,
  ReceiptResource,
  ReportResource,
} from "./resources.js";

/**
 * Uniform denial behavior (P1-07, SRS §11.1 ERR-001).
 *
 * Private object-level denials are enumeration-safe: a nonparticipant
 * guessing any private ID receives the SAME 404 NOT_FOUND shape as for a
 * missing ID, without disclosing whether the resource exists. Auth/session
 * failures use 401; verified/fresh/role failures use 403 only when the
 * principal is otherwise permitted to know the resource exists (e.g. their
 * own resource), while cross-user private access stays 404.
 */
export interface Denial {
  code: ErrorCode;
  httpStatus: number;
  message: string;
  retryable: boolean;
}

export type AuthzResult = { ok: true } | { ok: false; denial: Denial };

export function denialFor(code: ErrorCode, message: string): Denial {
  return {
    code,
    httpStatus: ERROR_HTTP_STATUS[code],
    message,
    retryable: false,
  };
}

export const UNAUTHENTICATED: Denial = denialFor("UNAUTHENTICATED", "Authentication required.");
export const SESSION_REVOKED: Denial = denialFor("SESSION_REVOKED", "Session is no longer valid.");
export const NOT_FOUND: Denial = denialFor("NOT_FOUND", "Resource not found.");
export const UNVERIFIED: Denial = denialFor("FORBIDDEN", "Email verification required.");
export const STALE: Denial = denialFor("FORBIDDEN", "Recent authentication required.");
export const OPERATOR_ONLY: Denial = denialFor("FORBIDDEN", "Operator action required.");

function allow(): AuthzResult {
  return { ok: true };
}
function deny(denial: Denial): AuthzResult {
  return { ok: false, denial };
}

/** Gate: principal must be present and verified for protected features. */
export function guardProtected(principal: Principal | null): AuthzResult {
  if (!principal) return deny(SESSION_REVOKED);
  if (!isVerifiedPrincipal(principal)) return deny(UNVERIFIED);
  return allow();
}

/** Gate: sensitive actions additionally require a fresh session. */
export function guardSensitive(principal: Principal | null): AuthzResult {
  const protectedGate = guardProtected(principal);
  if (!protectedGate.ok) return protectedGate;
  if (!principal || !isFreshPrincipal(principal)) return deny(STALE);
  return allow();
}

/** Gate: operator-only actions (moderation dispositions). */
export function guardOperator(principal: Principal | null): AuthzResult {
  const protectedGate = guardProtected(principal);
  if (!protectedGate.ok) return protectedGate;
  if (!principal || !isOperator(principal)) return deny(OPERATOR_ONLY);
  return allow();
}

function isParticipant(principal: Principal, participantIds: readonly string[]): boolean {
  return participantIds.includes(principal.userId);
}

/**
 * Conversation: only a current participant may read/mutate. Missing or
 * nonparticipant both yield the same NOT_FOUND (enumeration-safe, INT-002).
 * Client-supplied `participantIds` are never consulted — pass the
 * server-resolved record (or null).
 */
export function canAccessConversation(
  principal: Principal | null,
  conversation: ConversationResource | null,
): AuthzResult {
  if (!principal) return deny(SESSION_REVOKED);
  const gate = guardProtected(principal);
  if (!gate.ok) return gate;
  if (!conversation) return deny(NOT_FOUND);
  if (!isParticipant(principal, conversation.participantIds)) return deny(NOT_FOUND);
  return allow();
}

/** Message: current conversation participant; sender identity is server-derived. */
export function canAccessMessage(
  principal: Principal | null,
  message: MessageResource | null,
  conversation: ConversationResource | null,
): AuthzResult {
  if (!principal) return deny(SESSION_REVOKED);
  const gate = guardProtected(principal);
  if (!gate.ok) return gate;
  if (!message || !conversation) return deny(NOT_FOUND);
  if (message.conversationId !== conversation.id) return deny(NOT_FOUND);
  if (!isParticipant(principal, conversation.participantIds)) return deny(NOT_FOUND);
  return allow();
}

/** Receipt: only the message sender may see delivery/read state (DEC-020). */
export function canAccessReceipt(
  principal: Principal | null,
  receipt: ReceiptResource | null,
): AuthzResult {
  if (!principal) return deny(SESSION_REVOKED);
  const gate = guardProtected(principal);
  if (!gate.ok) return gate;
  if (!receipt) return deny(NOT_FOUND);
  if (principal.userId !== receipt.senderUserId) return deny(NOT_FOUND);
  return allow();
}

/** Call: only a current call participant (FR-CALL-012 signaling scope). */
export function canAccessCall(principal: Principal | null, call: CallResource | null): AuthzResult {
  if (!principal) return deny(SESSION_REVOKED);
  const gate = guardProtected(principal);
  if (!gate.ok) return gate;
  if (!call) return deny(NOT_FOUND);
  if (!isParticipant(principal, call.participantIds)) return deny(NOT_FOUND);
  return allow();
}

/** Key backup: owner-only (DEC-003). Versioned/last-good copied inside owner. */
export function canAccessKeyBackup(
  principal: Principal | null,
  backup: KeyBackupResource | null,
): AuthzResult {
  if (!principal) return deny(SESSION_REVOKED);
  const gate = guardProtected(principal);
  if (!gate.ok) return gate;
  if (!backup) return deny(NOT_FOUND);
  if (principal.userId !== backup.ownerId) return deny(NOT_FOUND);
  return allow();
}

/** Device: owner-only (DEC-002 single-active-device; enrollment is sensitive). */
export function canAccessDevice(
  principal: Principal | null,
  device: DeviceResource | null,
): AuthzResult {
  if (!principal) return deny(SESSION_REVOKED);
  const gate = guardProtected(principal);
  if (!gate.ok) return gate;
  if (!device) return deny(NOT_FOUND);
  if (principal.userId !== device.ownerId) return deny(NOT_FOUND);
  return allow();
}

/**
 * Report visibility (DEC-008):
 * - Reporter may read their own report status.
 * - Reported user may NOT read the report (never reporter identity/content)
 *   — treated as NOT_FOUND; dispositions are surfaced separately.
 * - Anyone else: NOT_FOUND.
 */
export function canAccessReport(
  principal: Principal | null,
  report: ReportResource | null,
): AuthzResult {
  if (!principal) return deny(SESSION_REVOKED);
  const gate = guardProtected(principal);
  if (!gate.ok) return gate;
  if (!report) return deny(NOT_FOUND);
  if (principal.userId !== report.reporterUserId) return deny(NOT_FOUND);
  return allow();
}

/** Block list: private to the blocker; no cross-user disclosure. */
export function canAccessBlock(
  principal: Principal | null,
  block: BlockResource | null,
): AuthzResult {
  if (!principal) return deny(SESSION_REVOKED);
  const gate = guardProtected(principal);
  if (!gate.ok) return gate;
  if (!block) return deny(NOT_FOUND);
  if (principal.userId !== block.blockerUserId) return deny(NOT_FOUND);
  return allow();
}

/**
 * Resource descriptors for object-level authorization (P1-07).
 *
 * Every private resource carries its authority inline. The server resolves
 * these via storage lookups (injected in middleware/socket helpers); the
 * checks themselves never trust client-supplied ownership fields.
 */

/** One-to-one direct conversation (DEC-023 §9.1). */
export interface ConversationResource {
  id: string;
  /** Exactly two eligible participant user IDs; immutable for MVP. */
  participantIds: readonly string[];
}

/** Encrypted message bound to one conversation. */
export interface MessageResource {
  id: string;
  conversationId: string;
  senderUserId: string;
}

/** Per-message delivery/read receipt (DEC-020 §7). Only the sender sees it. */
export interface ReceiptResource {
  id: string;
  messageId: string;
  conversationId: string;
  senderUserId: string;
  recipientUserId: string;
}

/** Call record (DEC-022): two participants, participant-scoped reads. */
export interface CallResource {
  id: string;
  participantIds: readonly string[];
  callId: string;
}

/** Encrypted key backup (DEC-003): owner-only, opaque ciphertext. */
export interface KeyBackupResource {
  id: string;
  ownerId: string;
}

/** Device / public-key directory entry: owner-only. */
export interface DeviceResource {
  id: string;
  ownerId: string;
  deviceId: string;
}

/** Moderation report (DEC-008): reporter owns the submission; the reported
 * user never sees reporter identity or excerpts — only the action taken. */
export interface ReportResource {
  id: string;
  reporterUserId: string;
  reportedUserId: string;
}

/** Block record (DEC-008): private to the blocker. */
export interface BlockResource {
  id: string;
  blockerUserId: string;
  blockedUserId: string;
}

export type ResourceKind =
  "conversation" | "message" | "receipt" | "call" | "key_backup" | "device" | "report" | "block";

/** Lookup injected by the host (storage layer / tests). Return null when missing. */
export type ResourceLookup<T> = (id: string) => Promise<T | null> | T | null;

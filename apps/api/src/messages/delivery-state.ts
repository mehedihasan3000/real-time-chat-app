import type { ConversationRecord } from "../conversations/store.js";
import { extractStoredEnvelopeRecipientDeviceId, type MessageRecord } from "./store.js";

/**
 * Encrypted messages have no automatic server-side TTL expiry in v1.0;
 * retention is account-lifetime until explicit account deletion or approved
 * moderation/legal action (`DEC-015` §2–§3, `DATA-009`).
 */
export const MESSAGE_RETENTION_AUTO_EXPIRY_MS = null;

export type MessageDeliveryStage = "sent" | "delivered" | "read";

export interface MessageDeliveryRecord {
  messageId: string;
  conversationId: string;
  seq: number;
  senderUserId: string;
  senderDeviceId: string;
  recipientUserId: string;
  recipientDeviceId: string | null;
  stage: MessageDeliveryStage;
  committedAt: string;
  deliveredAt: string | null;
  readAt: string | null;
}

export interface RecordDeliveryEvidenceInput {
  messageId: string;
  actorUserId: string;
  actorDeviceId: string;
  decrypted: boolean;
  /** Optional current active device for `actorUserId`; mismatched devices are rejected (`FR-SEC-010`). */
  activeRecipientDeviceId?: string | null;
  now?: Date;
}

export interface RecordReadEvidenceInput extends RecordDeliveryEvidenceInput {
  displayedInFocusedConversation: boolean;
  recipientReadSharingEnabled: boolean;
  senderReadSharingEnabled?: boolean;
}

export type DeliveryEvidenceResult =
  | { ok: true; record: MessageDeliveryRecord; advanced: boolean; suppressedRead?: boolean }
  | {
      ok: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "DEVICE_REVOKED" | "DECRYPTION_REQUIRED";
      message: string;
    };

function cloneDeliveryRecord(record: MessageDeliveryRecord): MessageDeliveryRecord {
  return { ...record };
}

/**
 * Tracks offline-capable per-message delivery and read progression for committed
 * encrypted messages (`P2-10`, `FR-CHAT-006`, `FR-CHAT-009`–`011`, `DEC-020` §7,
 * `DEC-015` §3–§4, `DEC-021`).
 *
 * Security & privacy invariants:
 * - Committed messages start strictly at `stage: "sent"` even when the recipient is
 *   disconnected (`FR-CHAT-003`, `FR-CHAT-006`).
 * - Advancing to `"delivered"` requires explicit authorized recipient endpoint evidence
 *   that ciphertext was received and decrypted by the bound recipient device.
 * - Advancing to `"read"` is opt-in/default-off, reciprocal (`DEC-020` §7), and requires
 *   focused rendered display (never background fetch or undecryptable placeholders).
 * - Transitions are strictly monotonic and visible only to `senderUserId`.
 */
export class OfflineRecipientDeliveryTracker {
  private readonly byMessageId = new Map<string, MessageDeliveryRecord>();

  registerCommittedMessage(
    record: MessageRecord,
    conversation: Pick<ConversationRecord, "id" | "participantIds">,
  ): MessageDeliveryRecord {
    const existing = this.byMessageId.get(record.id);
    if (existing) {
      return cloneDeliveryRecord(existing);
    }

    const recipientUserId = conversation.participantIds.find((id) => id !== record.senderUserId);
    if (!recipientUserId || conversation.id !== record.conversationId) {
      throw new Error("Cannot register delivery state outside a two-participant conversation.");
    }

    const entry: MessageDeliveryRecord = {
      messageId: record.id,
      conversationId: record.conversationId,
      seq: record.seq,
      senderUserId: record.senderUserId,
      senderDeviceId: record.senderDeviceId,
      recipientUserId,
      recipientDeviceId: extractStoredEnvelopeRecipientDeviceId(record.encryptedEnvelope),
      stage: "sent",
      committedAt: record.committedAt,
      deliveredAt: null,
      readAt: null,
    };
    this.byMessageId.set(entry.messageId, entry);
    return cloneDeliveryRecord(entry);
  }

  recordDeliveryEvidence(input: RecordDeliveryEvidenceInput): DeliveryEvidenceResult {
    const entry = this.byMessageId.get(input.messageId);
    if (!entry) {
      return { ok: false, code: "NOT_FOUND", message: "Message not found." };
    }
    if (input.actorUserId !== entry.recipientUserId) {
      return {
        ok: false,
        code: "FORBIDDEN",
        message: "Only the authorized recipient can report delivery evidence.",
      };
    }
    if (!input.decrypted) {
      return {
        ok: false,
        code: "DECRYPTION_REQUIRED",
        message: "Delivery state requires validated recipient decryption evidence.",
      };
    }
    if (entry.recipientDeviceId && input.actorDeviceId !== entry.recipientDeviceId) {
      return {
        ok: false,
        code: "DEVICE_REVOKED",
        message: "Delivery evidence device does not match the envelope recipient device.",
      };
    }
    if (
      input.activeRecipientDeviceId !== undefined &&
      input.activeRecipientDeviceId !== input.actorDeviceId
    ) {
      return {
        ok: false,
        code: "DEVICE_REVOKED",
        message: "Recipient device is no longer active.",
      };
    }

    if (entry.stage === "sent") {
      entry.stage = "delivered";
      entry.deliveredAt = (input.now ?? new Date()).toISOString();
      return { ok: true, record: cloneDeliveryRecord(entry), advanced: true };
    }

    return { ok: true, record: cloneDeliveryRecord(entry), advanced: false };
  }

  recordReadEvidence(input: RecordReadEvidenceInput): DeliveryEvidenceResult {
    const delivery = this.recordDeliveryEvidence(input);
    if (!delivery.ok) {
      return delivery;
    }

    if (
      !input.displayedInFocusedConversation ||
      !input.recipientReadSharingEnabled ||
      input.senderReadSharingEnabled === false
    ) {
      return {
        ok: true,
        record: delivery.record,
        advanced: delivery.advanced,
        suppressedRead: true,
      };
    }

    const entry = this.byMessageId.get(input.messageId)!;
    if (entry.stage !== "read") {
      entry.stage = "read";
      entry.readAt = (input.now ?? new Date()).toISOString();
      return {
        ok: true,
        record: cloneDeliveryRecord(entry),
        advanced: true,
        suppressedRead: false,
      };
    }

    return {
      ok: true,
      record: cloneDeliveryRecord(entry),
      advanced: false,
      suppressedRead: false,
    };
  }

  getSenderView(messageId: string, requesterUserId: string): MessageDeliveryRecord | null {
    const entry = this.byMessageId.get(messageId);
    if (!entry || entry.senderUserId !== requesterUserId) {
      return null;
    }
    return cloneDeliveryRecord(entry);
  }

  listSenderConversationView(
    conversationId: string,
    requesterUserId: string,
  ): MessageDeliveryRecord[] {
    return [...this.byMessageId.values()]
      .filter(
        (entry) =>
          entry.conversationId === conversationId && entry.senderUserId === requesterUserId,
      )
      .sort((a, b) => a.seq - b.seq)
      .map(cloneDeliveryRecord);
  }

  isDelivered(messageId: string): boolean {
    const entry = this.byMessageId.get(messageId);
    return entry ? entry.stage === "delivered" || entry.stage === "read" : false;
  }

  removeMessage(messageId: string): void {
    this.byMessageId.delete(messageId);
  }
}

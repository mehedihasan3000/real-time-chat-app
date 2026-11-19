import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  type HistoryMessageItem,
} from "@chat/contracts";

import type { MessageRecord } from "../messages/store.js";

/**
 * Project an internal `MessageRecord` strictly onto `PUBLIC_FIELDS.historyItem`
 * (`P2-07`, `FR-HIST-002`, `DATA-003`–`DATA-004`).
 * Never exposes `payloadHash`, plaintext, or internal store fields.
 */
export function toHistoryMessageItem(record: MessageRecord): HistoryMessageItem {
  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    messageId: record.id,
    conversationId: record.conversationId,
    seq: record.seq,
    senderUserId: record.senderUserId,
    senderDeviceId: record.senderDeviceId,
    clientMessageId: record.clientMessageId,
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    encryptedEnvelope: record.encryptedEnvelope,
    committedAt: record.committedAt,
  };
}

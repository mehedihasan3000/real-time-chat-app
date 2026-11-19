import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  type MessageAckSummary,
} from "@chat/contracts";

import type { BlockStore } from "../blocks/store.js";
import type { ConversationRecord } from "../conversations/store.js";
import type { UserEligibilityLookup } from "../conversations/view.js";
import type { DeviceKeyStore } from "../keys/store.js";
import type { BlockPredicate } from "../profiles/store.js";
import type { MessageRecord } from "./store.js";

/**
 * Project an internal `MessageRecord` strictly onto `PUBLIC_FIELDS.messageAck`.
 * Never exposes `payloadHash`, plaintext, or encrypted envelope echoes on ack.
 */
export function toMessageAckSummary(record: MessageRecord): MessageAckSummary {
  return {
    messageId: record.id,
    conversationId: record.conversationId,
    seq: record.seq,
    senderUserId: record.senderUserId,
    senderDeviceId: record.senderDeviceId,
    clientMessageId: record.clientMessageId,
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    committedAt: record.committedAt,
    schemaVersion: MESSAGE_SCHEMA_VERSION,
  };
}

export interface MessageSendEligibilityDeps {
  deviceKeyStore: DeviceKeyStore;
  blockStore: BlockStore;
  isBlocked?: BlockPredicate;
  userEligibilityLookup?: UserEligibilityLookup;
}

export type MessageSendEligibilityOutcome =
  | { ok: true; peerUserId: string }
  | {
      ok: false;
      status: number;
      code: "NOT_FOUND" | "FORBIDDEN" | "DEVICE_REVOKED" | "BLOCKED" | "UNAVAILABLE";
      message: string;
    };

/**
 * Verify conversation membership, active Olm sender device ownership, account
 * eligibility, and bilateral blocking before committing a message
 * (`DEC-021` §4.2 step 1, `DEC-018`, `DEC-008` §3, `FR-PRIV-003`).
 */
export async function checkMessageSendEligibility(
  conversation: ConversationRecord | null,
  requesterUserId: string,
  senderDeviceId: string,
  deps: MessageSendEligibilityDeps,
): Promise<MessageSendEligibilityOutcome> {
  if (
    !conversation ||
    conversation.participantIds.length !== 2 ||
    !conversation.participantIds.includes(requesterUserId)
  ) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Resource not found." };
  }

  const peerUserId = conversation.participantIds.find((id) => id !== requesterUserId);
  if (!peerUserId) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Resource not found." };
  }

  const device = await deps.deviceKeyStore.getOwn(requesterUserId, senderDeviceId);
  if (!device) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "An active enrolled sender device is required to send messages.",
    };
  }
  if (device.status !== "active" || !device.isActive) {
    return {
      ok: false,
      status: 403,
      code: "DEVICE_REVOKED",
      message: "This device is revoked and cannot send messages.",
    };
  }
  if (device.algorithm !== MESSAGE_ALLOWED_PROTOCOL_VERSION) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Sender device must use an approved Olm protocol version.",
    };
  }

  // Check requester's own block list first so mutual blocks never create a peer oracle.
  const requesterBlockedPeer = await deps.blockStore.hasBlocked(requesterUserId, peerUserId);
  if (requesterBlockedPeer) {
    return {
      ok: false,
      status: 403,
      code: "BLOCKED",
      message: "You have blocked this user.",
    };
  }

  const requesterEligible = deps.userEligibilityLookup
    ? await deps.userEligibilityLookup(requesterUserId)
    : true;
  if (!requesterEligible) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Your account cannot send messages right now.",
    };
  }

  const peerBlockedRequester = deps.isBlocked
    ? await deps.isBlocked(requesterUserId, peerUserId)
    : await deps.blockStore.hasBlocked(peerUserId, requesterUserId);
  if (peerBlockedRequester) {
    return {
      ok: false,
      status: 403,
      code: "UNAVAILABLE",
      message: "This message cannot be delivered right now.",
    };
  }

  const peerEligible = deps.userEligibilityLookup
    ? await deps.userEligibilityLookup(peerUserId)
    : true;
  if (!peerEligible) {
    return {
      ok: false,
      status: 403,
      code: "UNAVAILABLE",
      message: "This message cannot be delivered right now.",
    };
  }

  return { ok: true, peerUserId };
}

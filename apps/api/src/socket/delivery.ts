import type { Server as SocketServer, Socket } from "socket.io";

import {
  SOCKET_NAMESPACE,
  conversationRoom,
  isDeviceId,
  successEnvelope,
  userRoom,
  type MessageNewEvent,
  type MessageReceiptEvent,
} from "@chat/contracts";

import { getSessionForSensitive, type SessionLookup } from "../auth/session.js";
import type { ConversationResource, Principal, ResourceLookup } from "../authz/index.js";
import type { BlockStore } from "../blocks/store.js";
import type { ConversationRecord } from "../conversations/store.js";
import type { DeviceKeyStore } from "../keys/store.js";
import type { MessageRecord } from "../messages/store.js";
import { toMessageNewEvent } from "../messages/view.js";
import type { BlockPredicate } from "../profiles/store.js";

/**
 * Member-scoped live Socket.IO `/v1` delivery for committed encrypted messages
 * (`P2-06`, `FR-CHAT-005`, `INT-004`, `FR-SEC-010`, `FR-PRIV-003`, `TC-CHAT-002`).
 *
 * Security invariants:
 * - Never emits before durable commit (`onMessageCommitted` fires only after `P2-04`
 *   majority-journaled commit succeeds).
 * - Never emits to unrelated sockets, unauthenticated sockets, unverified users,
 *   expired tokens, revoked sessions (`INT-004`), blocked pairs (`FR-PRIV-003`),
 *   or revoked recipient devices (`FR-SEC-010`).
 * - Emits only the allowlisted `MessageNewEvent` ciphertext envelope inside a
 *   standard `SuccessEnvelope` (`requestId` + `schemaVersion: 1`) — never plaintext
 *   or `payloadHash`.
 */
export interface LiveMessageDeliveryOptions {
  conversationLookup?: ResourceLookup<ConversationResource>;
  sessionLookup?: SessionLookup;
  deviceKeyStore?: DeviceKeyStore;
  blockStore?: BlockStore;
  isBlocked?: BlockPredicate;
  /** When true, deliver only to recipient sockets explicitly joined to `conversation:<id>`. */
  requireConversationRoom?: boolean;
  now?: () => Date;
}

export interface LiveMessageDeliveryResult {
  deliveredSocketCount: number;
  skippedSocketCount: number;
  blockedOrIneligible: boolean;
  event: MessageNewEvent | null;
}

interface DeliverySocketData {
  principal?: Principal;
  tokenExpiresAt?: number;
}

function readEnvelopeRecipientDeviceId(encryptedEnvelope: string): string | null {
  try {
    const padded = encryptedEnvelope.replace(/-/g, "+").replace(/_/g, "/");
    const withPad = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    const bytes = Buffer.from(withPad, "base64");
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (typeof parsed === "object" && parsed !== null && isDeviceId(parsed.recipientDeviceId)) {
      return parsed.recipientDeviceId;
    }
    return null;
  } catch {
    return null;
  }
}

export async function publishMessageNew(
  io: SocketServer,
  record: MessageRecord,
  conversation: ConversationRecord,
  options: LiveMessageDeliveryOptions = {},
): Promise<LiveMessageDeliveryResult> {
  const uniqueParticipants = Array.from(new Set(conversation.participantIds));
  if (
    uniqueParticipants.length !== 2 ||
    !uniqueParticipants.includes(record.senderUserId) ||
    conversation.id !== record.conversationId
  ) {
    return {
      deliveredSocketCount: 0,
      skippedSocketCount: 0,
      blockedOrIneligible: true,
      event: null,
    };
  }

  const recipientUserId = uniqueParticipants.find((id) => id !== record.senderUserId);
  if (!recipientUserId) {
    return {
      deliveredSocketCount: 0,
      skippedSocketCount: 0,
      blockedOrIneligible: true,
      event: null,
    };
  }

  // Event-time membership recheck (INT-004).
  if (options.conversationLookup) {
    const currentConversation = await options.conversationLookup(conversation.id);
    if (
      !currentConversation ||
      currentConversation.participantIds.length !== 2 ||
      !currentConversation.participantIds.includes(record.senderUserId) ||
      !currentConversation.participantIds.includes(recipientUserId)
    ) {
      return {
        deliveredSocketCount: 0,
        skippedSocketCount: 0,
        blockedOrIneligible: true,
        event: null,
      };
    }
  }

  // Defense-in-depth bilateral block check (FR-PRIV-003).
  if (options.isBlocked) {
    if (await options.isBlocked(record.senderUserId, recipientUserId)) {
      return {
        deliveredSocketCount: 0,
        skippedSocketCount: 0,
        blockedOrIneligible: true,
        event: null,
      };
    }
  } else if (options.blockStore) {
    if (await options.blockStore.isBlocked(record.senderUserId, recipientUserId)) {
      return {
        deliveredSocketCount: 0,
        skippedSocketCount: 0,
        blockedOrIneligible: true,
        event: null,
      };
    }
  }

  // Revoked recipient devices must not receive new eligible ciphertext (FR-SEC-010, DEC-002).
  if (options.deviceKeyStore) {
    const activeRecipientDevice = await options.deviceKeyStore.getActivePublicKeys(recipientUserId);
    if (!activeRecipientDevice) {
      return {
        deliveredSocketCount: 0,
        skippedSocketCount: 0,
        blockedOrIneligible: true,
        event: null,
      };
    }
    const targetDeviceId = readEnvelopeRecipientDeviceId(record.encryptedEnvelope);
    if (targetDeviceId && activeRecipientDevice.deviceId !== targetDeviceId) {
      return {
        deliveredSocketCount: 0,
        skippedSocketCount: 0,
        blockedOrIneligible: true,
        event: null,
      };
    }
  }

  const event = toMessageNewEvent(record);
  const now = options.now ?? (() => new Date());
  const nowMs = now().getTime();
  const namespace = io.of(SOCKET_NAMESPACE);
  const requiredRoom = conversationRoom(conversation.id);

  let deliveredSocketCount = 0;
  let skippedSocketCount = 0;

  for (const socket of namespace.sockets.values() as Iterable<Socket>) {
    const data = socket.data as DeliverySocketData;
    const principal = data.principal;
    if (!principal || principal.userId !== recipientUserId) {
      continue;
    }
    if (!principal.emailVerified) {
      skippedSocketCount += 1;
      continue;
    }
    if (typeof data.tokenExpiresAt === "number" && data.tokenExpiresAt <= nowMs) {
      skippedSocketCount += 1;
      continue;
    }
    if (options.requireConversationRoom && !socket.rooms.has(requiredRoom)) {
      skippedSocketCount += 1;
      continue;
    }
    if (options.sessionLookup) {
      const currentSession = await getSessionForSensitive(options.sessionLookup, principal.sid);
      if (!currentSession || currentSession.userId !== recipientUserId || currentSession.revoked) {
        skippedSocketCount += 1;
        continue;
      }
    }

    socket.emit("message:new", successEnvelope(event));
    deliveredSocketCount += 1;
  }

  return {
    deliveredSocketCount,
    skippedSocketCount,
    blockedOrIneligible: false,
    event,
  };
}

/**
 * Create an `onMessageCommitted` hook suitable for `createApp({ onMessageCommitted })`
 * that publishes committed encrypted messages to authorized live recipient sockets.
 */
export function createLiveMessagePublisher(
  io: SocketServer,
  options: LiveMessageDeliveryOptions = {},
): (record: MessageRecord, conversation: ConversationRecord) => Promise<void> {
  return async (record, conversation) => {
    await publishMessageNew(io, record, conversation, options);
  };
}

/**
 * Publish a `"message:receipt"` notification exclusively to the authenticated
 * message sender's personal room (`user:<senderUserId>`), suppressing emission
 * silently under bilateral blocks (`FR-CHAT-009`, `DEC-008`).
 */
export async function publishMessageReceipt(
  io: SocketServer,
  event: MessageReceiptEvent,
  conversation: ConversationRecord,
  options: LiveMessageDeliveryOptions = {},
): Promise<{ emittedSockets: number; suppressedReason?: "blocked" | "non_participant" }> {
  if (!conversation.participantIds.includes(event.senderUserId)) {
    return { emittedSockets: 0, suppressedReason: "non_participant" };
  }
  const [userA, userB] = conversation.participantIds;
  if (
    (options.blockStore && (await options.blockStore.isBlocked(userA, userB))) ||
    (options.isBlocked && (await options.isBlocked(userA, userB)))
  ) {
    return { emittedSockets: 0, suppressedReason: "blocked" };
  }

  const sockets = await io.of(SOCKET_NAMESPACE).in(userRoom(event.senderUserId)).fetchSockets();
  let emittedSockets = 0;
  for (const remote of sockets) {
    remote.emit("message:receipt", successEnvelope(event));
    emittedSockets += 1;
  }
  return { emittedSockets };
}

export function createLiveReceiptPublisher(
  io: SocketServer,
  options: LiveMessageDeliveryOptions = {},
): (event: MessageReceiptEvent, conversation: ConversationRecord) => Promise<void> {
  return async (event, conversation) => {
    await publishMessageReceipt(io, event, conversation, options);
  };
}

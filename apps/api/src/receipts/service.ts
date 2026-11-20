import {
  DEFAULT_READ_RECEIPTS_ENABLED,
  RECEIPT_SCHEMA_VERSION,
  computeUnreadCount,
  isDeviceId,
  type ConversationReceiptListResponse,
  type ErrorCode,
  type MessageReceiptDetailResponse,
  type MessageReceiptEvent,
  type MessageReceiptView,
  type ReadProgressResponse,
  type ReceiptPreferencesView,
  type SubmitMessageReceiptRequest,
  type SubmitMessageReceiptResponse,
  type UpdateReadProgressRequest,
} from "@chat/contracts";

import type { BlockStore } from "../blocks/store.js";
import type { ConversationRecord } from "../conversations/store.js";
import type { DeviceKeyStore } from "../keys/store.js";
import {
  extractStoredEnvelopeRecipientDeviceId,
  type MessageRecord,
  type MessageStore,
} from "../messages/store.js";
import type { BlockPredicate } from "../profiles/store.js";
import type { ReceiptPreferencesRecord, ReceiptRecord, ReceiptStore } from "./store.js";

/**
 * Receipts, privacy preferences, and private unread calculation service v0
 * (`P2-11`, `FR-CHAT-009..011`, `FR-HIST-004`, `FR-PRIV-003`, `DATA-006`,
 * `INT-002`; `DEC-008`, `DEC-015`, `DEC-018`, `DEC-020`, `DEC-021`).
 */

export type ReceiptServiceFailure = {
  ok: false;
  status: 403 | 404;
  code: Extract<ErrorCode, "FORBIDDEN" | "NOT_FOUND">;
  message: string;
};

export type SubmitReceiptServiceResult =
  | {
      ok: true;
      response: SubmitMessageReceiptResponse;
      event: MessageReceiptEvent | null;
    }
  | ReceiptServiceFailure;

export type SingleReceiptReadResult =
  { ok: true; response: MessageReceiptDetailResponse } | ReceiptServiceFailure;

export interface ReceiptServiceDeps {
  messageStore: MessageStore;
  receiptStore: ReceiptStore;
  deviceKeyStore: DeviceKeyStore;
  blockStore?: BlockStore;
  isBlocked?: BlockPredicate;
  now?: () => Date;
}

export function toMessageReceiptView(record: ReceiptRecord): MessageReceiptView {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    messageId: record.messageId,
    conversationId: record.conversationId,
    seq: record.seq,
    recipientUserId: record.recipientUserId,
    recipientDeviceId: record.recipientDeviceId,
    stage: record.stage,
    deliveredAt: record.deliveredAt,
    readAt: record.readAt,
    updatedAt: record.updatedAt,
  };
}

export function toMessageReceiptEvent(record: ReceiptRecord): MessageReceiptEvent {
  return {
    ...toMessageReceiptView(record),
    senderUserId: record.senderUserId,
  };
}

export function toReceiptPreferencesView(
  userId: string,
  record: ReceiptPreferencesRecord | null,
  now: Date = new Date(),
): ReceiptPreferencesView {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    userId,
    readReceiptsEnabled: record?.readReceiptsEnabled ?? DEFAULT_READ_RECEIPTS_ENABLED,
    updatedAt: record?.updatedAt ?? now.toISOString(),
  };
}

/**
 * Calculates private unread count for `viewerUserId` without inflating across
 * duplicate deliveries, permanent `seq` deletions/gaps (`DEC-015`), or the
 * viewer's own sent messages (`FR-HIST-004`, `TC-HIST-003`).
 */
export function calculateConversationUnreadCount(
  messages: readonly MessageRecord[],
  viewerUserId: string,
  readThroughSeq: number,
  conversationLastSeq: number,
): number {
  const safeLatest = Math.max(0, conversationLastSeq);
  const effectiveReadThrough = Math.max(0, Math.min(readThroughSeq, safeLatest));
  if (messages.length > 0) {
    let unread = 0;
    for (const message of messages) {
      if (message.seq > effectiveReadThrough && message.senderUserId !== viewerUserId) {
        unread += 1;
      }
    }
    return unread;
  }
  return computeUnreadCount(safeLatest, effectiveReadThrough);
}

async function isBilateralBlocked(
  userA: string,
  userB: string,
  deps: Pick<ReceiptServiceDeps, "blockStore" | "isBlocked">,
): Promise<boolean> {
  if (deps.blockStore && (await deps.blockStore.isBlocked(userA, userB))) {
    return true;
  }
  if (deps.isBlocked && (await deps.isBlocked(userA, userB))) {
    return true;
  }
  return false;
}

export async function submitMessageReceipt(
  conversation: ConversationRecord,
  messageId: string,
  requesterUserId: string,
  request: SubmitMessageReceiptRequest,
  deps: ReceiptServiceDeps,
): Promise<SubmitReceiptServiceResult> {
  if (!conversation.participantIds.includes(requesterUserId)) {
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: "Resource not found.",
    };
  }

  const message = await deps.messageStore.getById(messageId);
  if (!message || message.conversationId !== conversation.id) {
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: "Resource not found.",
    };
  }

  // Sender cannot forge delivery/read receipts for their own outgoing message (FR-CHAT-009).
  if (message.senderUserId === requesterUserId) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Sender cannot submit a delivery or read receipt for their own message.",
    };
  }

  // Require an active device bound to the recipient and envelope target device if present.
  const ownDevice = await deps.deviceKeyStore.getOwn(requesterUserId, request.deviceId);
  const activeDevice = await deps.deviceKeyStore.getActivePublicKeys(requesterUserId);
  if (
    !ownDevice ||
    ownDevice.status !== "active" ||
    !ownDevice.isActive ||
    (activeDevice && activeDevice.deviceId !== request.deviceId)
  ) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Receipt requires an active bound device for the recipient.",
    };
  }

  const targetDeviceId = extractStoredEnvelopeRecipientDeviceId(message.encryptedEnvelope);
  if (targetDeviceId !== null && targetDeviceId !== request.deviceId) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Receipt device does not match envelope target device.",
    };
  }

  // Bilateral block suppresses all new receipt recording/notifications silently (DEC-008).
  if (await isBilateralBlocked(message.senderUserId, requesterUserId, deps)) {
    return {
      ok: true,
      response: {
        accepted: false,
        suppressedReason: "policy",
        stage: request.type,
        recordedAt: null,
      },
      event: null,
    };
  }

  // Read receipts are strictly opt-in, default-off, and reciprocal (FR-CHAT-010, DEC-020).
  if (request.type === "read") {
    const [recipientPrefs, senderPrefs] = await Promise.all([
      deps.receiptStore.getPreferences(requesterUserId),
      deps.receiptStore.getPreferences(message.senderUserId),
    ]);
    const recipientEnabled = recipientPrefs?.readReceiptsEnabled ?? DEFAULT_READ_RECEIPTS_ENABLED;
    const senderEnabled = senderPrefs?.readReceiptsEnabled ?? DEFAULT_READ_RECEIPTS_ENABLED;
    if (!recipientEnabled || !senderEnabled) {
      return {
        ok: true,
        response: {
          accepted: false,
          suppressedReason: "policy",
          stage: "read",
          recordedAt: null,
        },
        event: null,
      };
    }
  }

  const now = deps.now ? deps.now() : new Date();
  const upserted = await deps.receiptStore.upsertReceipt({
    messageId: message.id,
    conversationId: conversation.id,
    seq: message.seq,
    senderUserId: message.senderUserId,
    recipientUserId: requesterUserId,
    recipientDeviceId: request.deviceId,
    type: request.type,
    now,
  });

  if (!upserted.advanced) {
    return {
      ok: true,
      response: {
        accepted: false,
        suppressedReason: "already_advanced",
        stage: request.type,
        recordedAt: request.type === "read" ? upserted.record.readAt : upserted.record.deliveredAt,
      },
      event: null,
    };
  }

  return {
    ok: true,
    response: {
      accepted: true,
      suppressedReason: null,
      stage: request.type,
      recordedAt: request.type === "read" ? upserted.record.readAt : upserted.record.deliveredAt,
    },
    event: toMessageReceiptEvent(upserted.record),
  };
}

export async function listConversationSenderReceipts(
  conversation: ConversationRecord,
  requesterUserId: string,
  receiptStore: ReceiptStore,
): Promise<ConversationReceiptListResponse> {
  const records = await receiptStore.listByConversationForSender(conversation.id, requesterUserId);
  return {
    items: records.map(toMessageReceiptView),
    latestSeq: conversation.lastSeq,
  };
}

export async function getSingleMessageSenderReceipt(
  conversation: ConversationRecord,
  messageId: string,
  requesterUserId: string,
  messageStore: MessageStore,
  receiptStore: ReceiptStore,
): Promise<SingleReceiptReadResult> {
  if (!conversation.participantIds.includes(requesterUserId)) {
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: "Resource not found.",
    };
  }
  const message = await messageStore.getById(messageId);
  if (!message || message.conversationId !== conversation.id) {
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: "Resource not found.",
    };
  }
  if (message.senderUserId !== requesterUserId) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Receipts are visible only to the message sender.",
    };
  }
  const peerUserId = conversation.participantIds.find((id) => id !== requesterUserId) ?? "";
  const stored = peerUserId ? await receiptStore.getReceipt(message.id, peerUserId) : null;
  if (stored) {
    return { ok: true, response: { receipt: toMessageReceiptView(stored) } };
  }
  const extractedDevice = extractStoredEnvelopeRecipientDeviceId(message.encryptedEnvelope);
  const recipientDeviceId =
    extractedDevice && isDeviceId(extractedDevice) ? extractedDevice : "unconfirmed";
  return {
    ok: true,
    response: {
      receipt: {
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        messageId: message.id,
        conversationId: conversation.id,
        seq: message.seq,
        recipientUserId: peerUserId,
        recipientDeviceId,
        stage: "sent",
        deliveredAt: null,
        readAt: null,
        updatedAt: message.committedAt,
      },
    },
  };
}

export async function getOwnConversationReadProgress(
  conversation: ConversationRecord,
  requesterUserId: string,
  messageStore: MessageStore,
  receiptStore: ReceiptStore,
): Promise<ReadProgressResponse> {
  const [stored, messages] = await Promise.all([
    receiptStore.getReadProgress(conversation.id, requesterUserId),
    messageStore.listByConversation(conversation.id),
  ]);
  const latestSeq = Math.max(0, conversation.lastSeq);
  const readThroughSeq = Math.max(0, Math.min(stored?.readThroughSeq ?? 0, latestSeq));
  const unreadCount = calculateConversationUnreadCount(
    messages,
    requesterUserId,
    readThroughSeq,
    latestSeq,
  );
  return {
    progress: {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      conversationId: conversation.id,
      userId: requesterUserId,
      readThroughSeq,
      latestSeq,
      unreadCount,
      updatedAt: stored?.updatedAt ?? conversation.createdAt,
    },
  };
}

export async function updateOwnConversationReadProgress(
  conversation: ConversationRecord,
  requesterUserId: string,
  request: UpdateReadProgressRequest,
  messageStore: MessageStore,
  receiptStore: ReceiptStore,
  now: Date = new Date(),
): Promise<ReadProgressResponse> {
  const latestSeq = Math.max(0, conversation.lastSeq);
  const [stored, messages] = await Promise.all([
    receiptStore.advanceReadProgress(
      conversation.id,
      requesterUserId,
      request.readThroughSeq,
      latestSeq,
      now,
    ),
    messageStore.listByConversation(conversation.id),
  ]);
  const readThroughSeq = Math.max(0, Math.min(stored.readThroughSeq, latestSeq));
  const unreadCount = calculateConversationUnreadCount(
    messages,
    requesterUserId,
    readThroughSeq,
    latestSeq,
  );
  return {
    progress: {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      conversationId: conversation.id,
      userId: requesterUserId,
      readThroughSeq,
      latestSeq,
      unreadCount,
      updatedAt: stored.updatedAt,
    },
  };
}

import {
  DEFAULT_ACTIVITY_SHARING_ENABLED,
  PRESENCE_SCHEMA_VERSION,
  type ActivityPreferencesView,
  type ConversationListCursor,
  type ConversationPresenceResponse,
  type PresenceState,
  type PresenceUpdateEvent,
  type TypingSignalResponse,
  type TypingUpdateEvent,
} from "@chat/contracts";

import type { BlockStore } from "../blocks/store.js";
import type { ConversationRecord, ConversationStore } from "../conversations/store.js";
import type { BlockPredicate } from "../profiles/store.js";
import {
  resolveActivitySharingEnabled,
  type ActivityPreferencesRecord,
  type PresenceStore,
} from "./store.js";

/**
 * Participant-only presence and typing service (`P2-12`, `FR-PRES-001`..`004`,
 * `DEC-008`, `DEC-015`, `DEC-016`, `DEC-020`).
 */

export interface PresenceServiceDependencies {
  conversationStore: ConversationStore;
  presenceStore: PresenceStore;
  blockStore?: BlockStore;
  isBlocked?: BlockPredicate;
  now?: () => Date;
}

export type PresenceVisibilityReason =
  "ok" | "blocked" | "peer_activity_disabled" | "viewer_activity_disabled";

export function toActivityPreferencesView(
  userId: string,
  record: ActivityPreferencesRecord | null,
  now: Date,
): ActivityPreferencesView {
  return {
    schemaVersion: PRESENCE_SCHEMA_VERSION,
    userId,
    activitySharingEnabled: resolveActivitySharingEnabled(record),
    updatedAt: record?.updatedAt ?? now.toISOString(),
  };
}

async function checkBilateralBlock(
  userA: string,
  userB: string,
  deps: Pick<PresenceServiceDependencies, "blockStore" | "isBlocked">,
): Promise<boolean> {
  if (deps.blockStore && (await deps.blockStore.isBlocked(userA, userB))) {
    return true;
  }
  if (deps.isBlocked && (await deps.isBlocked(userA, userB))) {
    return true;
  }
  return false;
}

/**
 * Evaluates whether `viewerUserId` may observe `peerUserId`'s presence and typing.
 * Bilateral blocks override `activitySharingEnabled` in both directions (`DEC-008`, `FR-PRES-004`).
 * Reciprocal `activitySharingEnabled` defaults to `true` (`DEC-020` §6.3) and masks both
 * presence and typing when either participant disables it.
 */
export async function isPresenceVisibleBetween(
  viewerUserId: string,
  peerUserId: string,
  deps: Pick<PresenceServiceDependencies, "presenceStore" | "blockStore" | "isBlocked">,
): Promise<{ visible: boolean; reason: PresenceVisibilityReason }> {
  if (viewerUserId === peerUserId) {
    return { visible: false, reason: "blocked" };
  }
  if (await checkBilateralBlock(viewerUserId, peerUserId, deps)) {
    return { visible: false, reason: "blocked" };
  }
  const [peerPref, viewerPref] = await Promise.all([
    deps.presenceStore.getPreferences(peerUserId),
    deps.presenceStore.getPreferences(viewerUserId),
  ]);
  const peerEnabled = peerPref ? peerPref.activitySharingEnabled : DEFAULT_ACTIVITY_SHARING_ENABLED;
  if (!peerEnabled) {
    return { visible: false, reason: "peer_activity_disabled" };
  }
  const viewerEnabled = viewerPref
    ? viewerPref.activitySharingEnabled
    : DEFAULT_ACTIVITY_SHARING_ENABLED;
  if (!viewerEnabled) {
    return { visible: false, reason: "viewer_activity_disabled" };
  }
  return { visible: true, reason: "ok" };
}

export async function getConversationPeerPresence(
  conversationId: string,
  requesterUserId: string,
  deps: PresenceServiceDependencies,
): Promise<
  | { ok: true; value: ConversationPresenceResponse }
  | { ok: false; status: 404; code: "NOT_FOUND"; message: string }
> {
  const conversation = await deps.conversationStore.getById(conversationId);
  if (!conversation || !conversation.participantIds.includes(requesterUserId)) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Resource not found." };
  }
  const peerUserId = conversation.participantIds.find((id) => id !== requesterUserId);
  if (!peerUserId) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Resource not found." };
  }

  const now = (deps.now ?? (() => new Date()))();
  const visibility = await isPresenceVisibleBetween(requesterUserId, peerUserId, deps);
  if (!visibility.visible) {
    return {
      ok: true,
      value: {
        presence: {
          schemaVersion: PRESENCE_SCHEMA_VERSION,
          conversationId,
          peerUserId,
          status: "unknown",
          typing: false,
          typingExpiresAt: null,
          updatedAt: now.toISOString(),
        },
      },
    };
  }

  const status = deps.presenceStore.getRawPresenceStatus(peerUserId, now);
  const typingState =
    status === "online"
      ? deps.presenceStore.isUserTyping(conversationId, peerUserId, now)
      : { isTyping: false, expiresAt: null };

  return {
    ok: true,
    value: {
      presence: {
        schemaVersion: PRESENCE_SCHEMA_VERSION,
        conversationId,
        peerUserId,
        status,
        typing: typingState.isTyping,
        typingExpiresAt: typingState.isTyping ? typingState.expiresAt : null,
        updatedAt: now.toISOString(),
      },
    },
  };
}

export interface HandleTypingResult {
  response: TypingSignalResponse;
  peerUserId: string;
  broadcastEvent: TypingUpdateEvent | null;
}

export async function handleConversationTypingSignal(
  conversationId: string,
  requesterUserId: string,
  isTyping: boolean,
  deps: PresenceServiceDependencies & { connectionId?: string },
): Promise<
  | { ok: true; value: HandleTypingResult }
  | { ok: false; status: 404; code: "NOT_FOUND"; message: string }
> {
  const conversation = await deps.conversationStore.getById(conversationId);
  if (!conversation || !conversation.participantIds.includes(requesterUserId)) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Resource not found." };
  }
  const peerUserId = conversation.participantIds.find((id) => id !== requesterUserId);
  if (!peerUserId) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Resource not found." };
  }

  const now = (deps.now ?? (() => new Date()))();
  const updatedAt = now.toISOString();
  const visibility = await isPresenceVisibleBetween(requesterUserId, peerUserId, deps);
  if (!visibility.visible) {
    deps.presenceStore.clearUserTyping(requesterUserId, conversationId);
    return {
      ok: true,
      value: {
        peerUserId,
        broadcastEvent: null,
        response: {
          typing: {
            schemaVersion: PRESENCE_SCHEMA_VERSION,
            conversationId,
            userId: requesterUserId,
            isTyping: false,
            accepted: true,
            coalesced: false,
            suppressed: true,
            expiresAt: null,
            updatedAt,
          },
        },
      },
    };
  }

  const applied = deps.presenceStore.setTyping({
    conversationId,
    userId: requesterUserId,
    connectionId: deps.connectionId,
    isTyping,
    now,
  });

  const broadcastEvent: TypingUpdateEvent | null = applied.accepted
    ? {
        schemaVersion: PRESENCE_SCHEMA_VERSION,
        conversationId,
        userId: requesterUserId,
        isTyping: applied.isTyping,
        expiresAt: applied.expiresAt,
        updatedAt,
      }
    : null;

  return {
    ok: true,
    value: {
      peerUserId,
      broadcastEvent,
      response: {
        typing: {
          schemaVersion: PRESENCE_SCHEMA_VERSION,
          conversationId,
          userId: requesterUserId,
          isTyping: applied.isTyping,
          accepted: applied.accepted,
          coalesced: applied.coalesced,
          suppressed: false,
          expiresAt: applied.expiresAt,
          updatedAt,
        },
      },
    },
  };
}

export interface PeerPresenceBroadcastTarget {
  conversationId: string;
  peerUserId: string;
  presenceEvent: PresenceUpdateEvent;
  clearTypingEvent?: TypingUpdateEvent;
}

/**
 * Computes participant-scoped `presence:update` (and optional `typing:update`
 * clear) events across all direct conversations of `userId` (`FR-PRES-004`).
 * Never emits to unrelated users, never leaks raw status across blocks or
 * disabled activity-sharing preferences.
 */
export async function computePresenceBroadcastsForUser(
  userId: string,
  deps: PresenceServiceDependencies,
  options: { clearedTypingConversationIds?: readonly string[]; maskedOnly?: boolean } = {},
): Promise<PeerPresenceBroadcastTarget[]> {
  const now = (deps.now ?? (() => new Date()))();
  const updatedAt = now.toISOString();
  const rawStatus: PresenceState = deps.presenceStore.getRawPresenceStatus(userId, now);
  const clearedSet = new Set(options.clearedTypingConversationIds ?? []);

  const items: ConversationRecord[] = [];
  let before: ConversationListCursor | null = null;
  for (let page = 0; page < 10; page += 1) {
    const listed = await deps.conversationStore.listForUser(userId, {
      limit: 50,
      before,
    });
    items.push(...listed.items);
    const last = listed.items[listed.items.length - 1];
    if (!listed.hasMore || !last) break;
    before = { v: 1, lastActivityAt: last.lastActivityAt, id: last.id };
  }

  const targets: PeerPresenceBroadcastTarget[] = [];
  for (const conv of items) {
    const peerUserId = conv.participantIds.find((id) => id !== userId);
    if (!peerUserId) continue;

    const visibility = await isPresenceVisibleBetween(peerUserId, userId, deps);
    const effectiveStatus: PresenceState =
      visibility.visible && !options.maskedOnly ? rawStatus : "unknown";

    const shouldClearTyping =
      !visibility.visible || effectiveStatus !== "online" || clearedSet.has(conv.id);

    targets.push({
      conversationId: conv.id,
      peerUserId,
      presenceEvent: {
        schemaVersion: PRESENCE_SCHEMA_VERSION,
        conversationId: conv.id,
        userId,
        status: effectiveStatus,
        updatedAt,
      },
      ...(shouldClearTyping
        ? {
            clearTypingEvent: {
              schemaVersion: PRESENCE_SCHEMA_VERSION,
              conversationId: conv.id,
              userId,
              isTyping: false,
              expiresAt: null,
              updatedAt,
            },
          }
        : {}),
    });
  }

  return targets;
}

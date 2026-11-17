import {
  CONVERSATION_SCHEMA_VERSION,
  type ConversationPeerSummary,
  type ConversationSummary,
} from "@chat/contracts";

import type { BlockStore } from "../blocks/store.js";
import type { BlockPredicate, ProfileStore } from "../profiles/store.js";
import type { ConversationRecord } from "./store.js";

export type UserEligibilityLookup = (userId: string) => Promise<boolean> | boolean;

export function peerIdFor(conversation: ConversationRecord, viewerUserId: string): string {
  const peerId = conversation.participantIds.find((id) => id !== viewerUserId);
  if (!peerId) {
    throw new Error("Viewer is not a participant in this conversation.");
  }
  return peerId;
}

/**
 * Project an internal `ConversationRecord` strictly onto the allowlisted
 * `ConversationSummary` view (`PUBLIC_FIELDS.conversationSummary`).
 *
 * `blockedByViewer` reflects ONLY whether `viewerUserId` has blocked `peerId`.
 * It is ALWAYS `false` when only `peerId` blocked `viewerUserId`, ensuring
 * silent blocking (`DEC-008`, `FR-PRIV-003`).
 */
export async function toConversationSummary(
  record: ConversationRecord,
  viewerUserId: string,
  deps: {
    profileStore: ProfileStore;
    blockStore: BlockStore;
  },
): Promise<ConversationSummary> {
  const peerId = peerIdFor(record, viewerUserId);
  const peerProfile = await deps.profileStore.getByUserId(peerId);
  const peer: ConversationPeerSummary = peerProfile
    ? {
        userId: peerProfile.userId,
        username: peerProfile.username,
        displayName: peerProfile.displayName,
        avatar: null,
      }
    : {
        userId: peerId,
        username: null,
        displayName: null,
        avatar: null,
      };

  const blockedByViewer = await deps.blockStore.hasBlocked(viewerUserId, peerId);

  return {
    id: record.id,
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    participantIds: [record.participantIds[0], record.participantIds[1]],
    peer,
    lastSeq: record.lastSeq,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    blockedByViewer,
  };
}

export interface PeerCreateCheckDeps {
  profileStore: ProfileStore;
  blockStore: BlockStore;
  isBlocked?: BlockPredicate;
  userEligibilityLookup?: UserEligibilityLookup;
}

export type PairEligibilityOutcome =
  { ok: true } | { ok: false; reason: "SELF" | "BLOCKED_BY_REQUESTER" | "USER_UNAVAILABLE" };

/**
 * Verify pairwise eligibility before `POST /api/v1/conversations` (FR-CHAT-001,
 * FR-PRIV-003, DEC-008):
 * - Self-conversations are rejected (`400 INVALID_REQUEST`).
 * - If the requester blocked the peer (`blockStore.hasBlocked(requester, peer)`),
 *   returns `BLOCKED_BY_REQUESTER` (`403 BLOCKED`) — depends ONLY on requester's
 *   own block list, never leaking peer state.
 * - If the peer does not exist, is ineligible (unverified/suspended/banned), or
 *   has blocked the requester (or a bilateral predicate fires), returns
 *   `USER_UNAVAILABLE` (`404 USER_UNAVAILABLE`) uniformly without block disclosure.
 */
export async function checkConversationPairEligibility(
  requesterUserId: string,
  peerUserId: string,
  deps: PeerCreateCheckDeps,
): Promise<PairEligibilityOutcome> {
  if (requesterUserId === peerUserId) {
    return { ok: false, reason: "SELF" };
  }

  const requesterBlockedPeer = await deps.blockStore.hasBlocked(requesterUserId, peerUserId);
  if (requesterBlockedPeer) {
    return { ok: false, reason: "BLOCKED_BY_REQUESTER" };
  }

  const requesterEligible = deps.userEligibilityLookup
    ? await deps.userEligibilityLookup(requesterUserId)
    : true;
  if (!requesterEligible) {
    return { ok: false, reason: "USER_UNAVAILABLE" };
  }

  const peerBlockedRequester = deps.isBlocked
    ? await deps.isBlocked(requesterUserId, peerUserId)
    : await deps.blockStore.hasBlocked(peerUserId, requesterUserId);
  if (peerBlockedRequester) {
    return { ok: false, reason: "USER_UNAVAILABLE" };
  }

  const peerProfile = await deps.profileStore.getByUserId(peerUserId);
  if (!peerProfile) {
    return { ok: false, reason: "USER_UNAVAILABLE" };
  }

  const peerEligible = deps.userEligibilityLookup
    ? await deps.userEligibilityLookup(peerUserId)
    : true;
  if (!peerEligible) {
    return { ok: false, reason: "USER_UNAVAILABLE" };
  }

  return { ok: true };
}

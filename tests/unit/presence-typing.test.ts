import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ACTIVITY_SHARING_ENABLED,
  PRESENCE_FORBIDDEN_FIELDS,
  PRESENCE_LEASE_TTL_MS,
  PRESENCE_SCHEMA_VERSION,
  PRESENCE_STATES,
  PUBLIC_FIELDS,
  TYPING_COALESCE_MS,
  TYPING_EXPIRY_MS,
  hasOnlyFields,
  isPresenceState,
  validateActivityPreferencesView,
  validateConversationPresenceResponse,
  validateConversationPresenceView,
  validatePresenceUpdateEvent,
  validateTypingSignalRequest,
  validateTypingSignalResponse,
  validateTypingUpdateEvent,
  validateUpdateActivityPreferencesRequest,
  type ActivityPreferencesView,
  type ConversationPresenceResponse,
  type PresenceUpdateEvent,
  type TypingSignalResponse,
  type TypingUpdateEvent,
} from "@chat/contracts";

import { MemoryBlockStore } from "../../apps/api/src/blocks/store.js";
import { MemoryConversationStore } from "../../apps/api/src/conversations/store.js";
import {
  InMemoryPresenceStore,
  computePresenceBroadcastsForUser,
  getConversationPeerPresence,
  handleConversationTypingSignal,
  toActivityPreferencesView,
} from "../../apps/api/src/presence/index.js";
import {
  PresenceAndTypingController,
  PresenceApiError,
  parsePresenceUpdateEventEnvelope,
  parseTypingUpdateEventEnvelope,
  type PresenceClient,
} from "../../apps/web/src/features/presence/index.js";

const CONV_AB = "conv_p212_ab_01";
const ALICE = "usr_p212_alice_01";
const BOB = "usr_p212_bob_02";
const MALLORY = "usr_p212_mallory_03";

describe("P2-12 presence & typing contracts and domain unit suite (FR-PRES-001..004, TC-PRES-001..002)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("validates contracts, PUBLIC_FIELDS allowlists, and rejects all lastSeen/plaintext/block forbidden keys", () => {
    expect(PRESENCE_STATES).toEqual(["online", "offline", "unknown"]);
    expect(PRESENCE_LEASE_TTL_MS).toBe(60_000);
    expect(TYPING_EXPIRY_MS).toBe(5_000);
    expect(TYPING_COALESCE_MS).toBe(2_000);
    expect(DEFAULT_ACTIVITY_SHARING_ENABLED).toBe(true);
    expect(isPresenceState("online")).toBe(true);
    expect(isPresenceState("idle")).toBe(false);

    const nowIso = "2026-11-20T10:00:00.000Z";
    const prefs: ActivityPreferencesView = {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      userId: ALICE,
      activitySharingEnabled: true,
      updatedAt: nowIso,
    };
    expect(validateActivityPreferencesView(prefs).ok).toBe(true);
    expect(hasOnlyFields(prefs, PUBLIC_FIELDS.activityPreferences)).toBe(true);

    const viewRes: ConversationPresenceResponse = {
      presence: {
        schemaVersion: PRESENCE_SCHEMA_VERSION,
        conversationId: CONV_AB,
        peerUserId: BOB,
        status: "online",
        typing: true,
        typingExpiresAt: "2026-11-20T10:00:05.000Z",
        updatedAt: nowIso,
      },
    };
    expect(validateConversationPresenceResponse(viewRes).ok).toBe(true);
    expect(hasOnlyFields(viewRes.presence, PUBLIC_FIELDS.conversationPresence)).toBe(true);

    const presenceEvent: PresenceUpdateEvent = {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      conversationId: CONV_AB,
      userId: BOB,
      status: "online",
      updatedAt: nowIso,
    };
    expect(validatePresenceUpdateEvent(presenceEvent).ok).toBe(true);
    expect(hasOnlyFields(presenceEvent, PUBLIC_FIELDS.presenceUpdateEvent)).toBe(true);

    const typingEvent: TypingUpdateEvent = {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      conversationId: CONV_AB,
      userId: BOB,
      isTyping: true,
      expiresAt: "2026-11-20T10:00:05.000Z",
      updatedAt: nowIso,
    };
    expect(validateTypingUpdateEvent(typingEvent).ok).toBe(true);
    expect(hasOnlyFields(typingEvent, PUBLIC_FIELDS.typingUpdateEvent)).toBe(true);

    const signalRes: TypingSignalResponse = {
      typing: {
        schemaVersion: PRESENCE_SCHEMA_VERSION,
        conversationId: CONV_AB,
        userId: ALICE,
        isTyping: true,
        accepted: true,
        coalesced: false,
        suppressed: false,
        expiresAt: "2026-11-20T10:00:05.000Z",
        updatedAt: nowIso,
      },
    };
    expect(validateTypingSignalResponse(signalRes).ok).toBe(true);
    expect(hasOnlyFields(signalRes.typing, PUBLIC_FIELDS.typingSignalResult)).toBe(true);

    // Consistency invariants: cannot be typing while offline/unknown; expiresAt must match typing boolean.
    expect(
      validateConversationPresenceView({
        ...viewRes.presence,
        status: "offline",
        typing: true,
      }).ok,
    ).toBe(false);
    expect(
      validateTypingUpdateEvent({
        ...typingEvent,
        isTyping: false,
        expiresAt: "2026-11-20T10:00:05.000Z",
      }).ok,
    ).toBe(false);

    // Every forbidden field (including lastSeen, history, plaintext, keys, block state) must be rejected.
    for (const forbidden of PRESENCE_FORBIDDEN_FIELDS) {
      expect(
        validateUpdateActivityPreferencesRequest({
          schemaVersion: 1,
          activitySharingEnabled: false,
          [forbidden]: "leak",
        }).ok,
      ).toBe(false);
      expect(
        validateTypingSignalRequest({
          schemaVersion: 1,
          isTyping: true,
          [forbidden]: "leak",
        }).ok,
      ).toBe(false);
    }
    expect(
      validateUpdateActivityPreferencesRequest({ schemaVersion: 2, activitySharingEnabled: true })
        .ok,
    ).toBe(false);
  });

  it("enforces 60s lease, multi-tab aggregation (FR-PRES-002), and backend restart unknown state (FR-PRES-001)", () => {
    const store = new InMemoryPresenceStore();
    let clock = new Date("2026-11-20T10:00:00.000Z");

    // Fresh server epoch starts with unknown before any connection.
    expect(store.getRawPresenceStatus(BOB, clock)).toBe("unknown");

    // Tab 1 connects -> online (1 tab).
    const t1 = store.touchConnection(BOB, "sock_tab_1", clock);
    expect(t1.previousStatus).toBe("unknown");
    expect(t1.currentStatus).toBe("online");
    expect(t1.changed).toBe(true);
    expect(t1.activeConnectionCount).toBe(1);

    // Tab 2 connects 10s later -> still online (2 tabs aggregated).
    clock = new Date(clock.getTime() + 10_000);
    const t2 = store.touchConnection(BOB, "sock_tab_2", clock);
    expect(t2.currentStatus).toBe("online");
    expect(t2.changed).toBe(false);
    expect(t2.activeConnectionCount).toBe(2);

    // Tab 1 closes -> Tab 2 remains open, so Bob MUST remain online (FR-PRES-002).
    clock = new Date(clock.getTime() + 1_000);
    const d1 = store.disconnectConnection(BOB, "sock_tab_1", clock);
    expect(d1.currentStatus).toBe("online");
    expect(d1.changed).toBe(false);
    expect(d1.activeConnectionCount).toBe(1);
    expect(store.getRawPresenceStatus(BOB, clock)).toBe("online");

    // Tab 2 closes -> now offline (0 tabs).
    const d2 = store.disconnectConnection(BOB, "sock_tab_2", clock);
    expect(d2.currentStatus).toBe("offline");
    expect(d2.changed).toBe(true);
    expect(d2.activeConnectionCount).toBe(0);
    expect(store.getRawPresenceStatus(BOB, clock)).toBe("offline");

    // Reconnect and let 60s lease expire without heartbeat -> offline.
    store.touchConnection(BOB, "sock_tab_3", clock);
    store.setTyping({
      conversationId: CONV_AB,
      userId: BOB,
      connectionId: "sock_tab_3",
      isTyping: true,
      now: clock,
    });
    expect(store.isUserTyping(CONV_AB, BOB, clock).isTyping).toBe(true);

    clock = new Date(clock.getTime() + PRESENCE_LEASE_TTL_MS - 1);
    expect(store.getRawPresenceStatus(BOB, clock)).toBe("online");

    clock = new Date(clock.getTime() + 2); // past 60,000 ms lease TTL
    expect(store.getRawPresenceStatus(BOB, clock)).toBe("offline");
    expect(store.isUserTyping(CONV_AB, BOB, clock).isTyping).toBe(false);

    // Simulate backend restart -> status resets to unknown until a connection re-establishes lease.
    store.touchConnection(BOB, "sock_tab_4", clock);
    expect(store.getRawPresenceStatus(BOB, clock)).toBe("online");
    store.simulateServerRestart();
    expect(store.getRawPresenceStatus(BOB, clock)).toBe("unknown");
  });

  it("enforces 2s coalescing, 5s typing expiry, immediate explicit stop, participant-only visibility, activity-sharing toggle, and bilateral block override (FR-PRES-003..004)", async () => {
    const conversationStore = new MemoryConversationStore();
    const presenceStore = new InMemoryPresenceStore();
    const blockStore = new MemoryBlockStore();
    let clock = new Date("2026-11-20T10:05:00.000Z");

    const { conversation } = await conversationStore.upsertDirect(ALICE, BOB, clock);
    const deps = {
      conversationStore,
      presenceStore,
      blockStore,
      now: () => clock,
    };

    // Unrelated user Mallory gets uniform 404 on both GET /presence and typing signals.
    const malloryPresence = await getConversationPeerPresence(conversation.id, MALLORY, deps);
    expect(malloryPresence).toEqual({
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: "Resource not found.",
    });
    const malloryTyping = await handleConversationTypingSignal(
      conversation.id,
      MALLORY,
      true,
      deps,
    );
    expect(malloryTyping.ok).toBe(false);

    // Default activity sharing is true (on by default, FR-PRES-004).
    const defaultPref = toActivityPreferencesView(
      BOB,
      await presenceStore.getPreferences(BOB),
      clock,
    );
    expect(defaultPref.activitySharingEnabled).toBe(true);

    // Connect Bob on socket and start typing.
    presenceStore.touchConnection(BOB, "bob_sock_1", clock);
    const firstType = await handleConversationTypingSignal(conversation.id, BOB, true, {
      ...deps,
      connectionId: "bob_sock_1",
    });
    expect(firstType.ok).toBe(true);
    if (!firstType.ok) throw new Error("unreachable");
    expect(firstType.value.response.typing.accepted).toBe(true);
    expect(firstType.value.response.typing.coalesced).toBe(false);
    expect(firstType.value.broadcastEvent?.isTyping).toBe(true);

    // Second start signal within 2s is coalesced without duplicate broadcast (FR-PRES-003, DEC-016).
    clock = new Date(clock.getTime() + TYPING_COALESCE_MS - 500);
    const secondType = await handleConversationTypingSignal(conversation.id, BOB, true, {
      ...deps,
      connectionId: "bob_sock_1",
    });
    expect(secondType.ok).toBe(true);
    if (!secondType.ok) throw new Error("unreachable");
    expect(secondType.value.response.typing.accepted).toBe(false);
    expect(secondType.value.response.typing.coalesced).toBe(true);
    expect(secondType.value.broadcastEvent).toBeNull();

    // Explicit stop (isTyping: false) succeeds immediately without waiting for 2s window.
    const explicitStop = await handleConversationTypingSignal(conversation.id, BOB, false, {
      ...deps,
      connectionId: "bob_sock_1",
    });
    expect(explicitStop.ok).toBe(true);
    if (!explicitStop.ok) throw new Error("unreachable");
    expect(explicitStop.value.response.typing.isTyping).toBe(false);
    expect(explicitStop.value.broadcastEvent?.isTyping).toBe(false);

    // Start again after 2s window, then advance past 5s expiry -> auto-cleared.
    clock = new Date(clock.getTime() + TYPING_COALESCE_MS + 100);
    await handleConversationTypingSignal(conversation.id, BOB, true, {
      ...deps,
      connectionId: "bob_sock_1",
    });
    const activeSnapshot = await getConversationPeerPresence(conversation.id, ALICE, deps);
    expect(activeSnapshot.ok && activeSnapshot.value.presence.typing).toBe(true);

    clock = new Date(clock.getTime() + TYPING_EXPIRY_MS + 1);
    const expiredSnapshot = await getConversationPeerPresence(conversation.id, ALICE, deps);
    expect(expiredSnapshot.ok && expiredSnapshot.value.presence.typing).toBe(false);
    expect(expiredSnapshot.ok && expiredSnapshot.value.presence.status).toBe("online");

    // Bob disables activity sharing -> Alice sees unknown & no typing, and broadcasts clear.
    clock = new Date(clock.getTime() + 3_000);
    await handleConversationTypingSignal(conversation.id, BOB, true, {
      ...deps,
      connectionId: "bob_sock_1",
    });
    const prefOff = await presenceStore.setPreferences(BOB, false, clock.toISOString());
    expect(prefOff.clearedTypingConversationIds).toContain(conversation.id);
    const maskedByPref = await getConversationPeerPresence(conversation.id, ALICE, deps);
    expect(maskedByPref.ok && maskedByPref.value.presence.status).toBe("unknown");
    expect(maskedByPref.ok && maskedByPref.value.presence.typing).toBe(false);
    const suppressedTyping = await handleConversationTypingSignal(conversation.id, BOB, true, deps);
    expect(suppressedTyping.ok && suppressedTyping.value.response.typing.suppressed).toBe(true);
    expect(suppressedTyping.ok && suppressedTyping.value.broadcastEvent).toBeNull();

    // Re-enable activity sharing, then bilateral block (DEC-008) MUST override it in both directions!
    await presenceStore.setPreferences(BOB, true, clock.toISOString());
    presenceStore.touchConnection(ALICE, "alice_sock_1", clock);
    expect(
      (await getConversationPeerPresence(conversation.id, ALICE, deps)).ok &&
        (await getConversationPeerPresence(conversation.id, ALICE, deps)),
    ).toMatchObject({ ok: true, value: { presence: { status: "online" } } });

    await blockStore.create(ALICE, BOB);
    const aliceBlockedView = await getConversationPeerPresence(conversation.id, ALICE, deps);
    const bobBlockedView = await getConversationPeerPresence(conversation.id, BOB, deps);
    expect(aliceBlockedView.ok && aliceBlockedView.value.presence.status).toBe("unknown");
    expect(bobBlockedView.ok && bobBlockedView.value.presence.status).toBe("unknown");
    const blockedBroadcasts = await computePresenceBroadcastsForUser(BOB, deps);
    expect(blockedBroadcasts[0]?.presenceEvent.status).toBe("unknown");
    expect(blockedBroadcasts[0]?.clearTypingEvent?.isTyping).toBe(false);
  });

  it("drives PresenceAndTypingController 5s local expiry timer, 2s outbound coalescer, disconnect/reconnect clear, and ERR-003 isolation", async () => {
    let clockMs = Date.UTC(2026, 10, 20, 11, 0, 0);
    let sentSignals: boolean[] = [];
    let activitySharing = true;
    let resolveDelayedPresence: ((v: ConversationPresenceResponse) => void) | null = null;

    const client: PresenceClient = {
      async getActivityPreferences() {
        return {
          schemaVersion: 1,
          userId: ALICE,
          activitySharingEnabled: activitySharing,
          updatedAt: new Date(clockMs).toISOString(),
        };
      },
      async setActivityPreferences(enabled) {
        activitySharing = enabled;
        return {
          schemaVersion: 1,
          userId: ALICE,
          activitySharingEnabled: enabled,
          updatedAt: new Date(clockMs).toISOString(),
        };
      },
      async getConversationPresence(conversationId) {
        if (conversationId === CONV_AB && resolveDelayedPresence === null) {
          return new Promise<ConversationPresenceResponse>((resolve) => {
            resolveDelayedPresence = resolve;
          });
        }
        return {
          presence: {
            schemaVersion: 1,
            conversationId,
            peerUserId: BOB,
            status: "online",
            typing: false,
            typingExpiresAt: null,
            updatedAt: new Date(clockMs).toISOString(),
          },
        };
      },
      async sendTypingSignal(conversationId, isTyping) {
        sentSignals.push(isTyping);
        return {
          typing: {
            schemaVersion: 1,
            conversationId,
            userId: ALICE,
            isTyping,
            accepted: true,
            coalesced: false,
            suppressed: false,
            expiresAt: isTyping ? new Date(clockMs + TYPING_EXPIRY_MS).toISOString() : null,
            updatedAt: new Date(clockMs).toISOString(),
          },
        };
      },
    };

    const ctrl = new PresenceAndTypingController({
      conversationId: CONV_AB,
      currentUserId: ALICE,
      peerUserId: BOB,
      client,
      now: () => clockMs,
    });

    // Validate envelope parsers cleanly handle both direct & Socket.IO SuccessEnvelope payloads.
    expect(
      parsePresenceUpdateEventEnvelope({
        ok: true,
        requestId: "req_1",
        data: {
          schemaVersion: 1,
          conversationId: CONV_AB,
          userId: BOB,
          status: "online",
          updatedAt: new Date(clockMs).toISOString(),
        },
      }).ok,
    ).toBe(true);
    expect(parsePresenceUpdateEventEnvelope({ bad: true }).ok).toBe(false);
    expect(
      parseTypingUpdateEventEnvelope({
        schemaVersion: 1,
        conversationId: CONV_AB,
        userId: BOB,
        isTyping: true,
        expiresAt: new Date(clockMs + TYPING_EXPIRY_MS).toISOString(),
        updatedAt: new Date(clockMs).toISOString(),
      }).ok,
    ).toBe(true);

    // Inbound typing starts 5-second auto-expiry timer even if stop packet is dropped.
    ctrl.applyPresenceUpdateEvent({
      schemaVersion: 1,
      conversationId: CONV_AB,
      userId: BOB,
      status: "online",
      updatedAt: new Date(clockMs).toISOString(),
    });
    ctrl.applyTypingUpdateEvent({
      schemaVersion: 1,
      conversationId: CONV_AB,
      userId: BOB,
      isTyping: true,
      expiresAt: new Date(clockMs + TYPING_EXPIRY_MS).toISOString(),
      updatedAt: new Date(clockMs).toISOString(),
    });
    expect(ctrl.getSnapshot().peerTyping).toBe(true);

    clockMs += TYPING_EXPIRY_MS;
    vi.advanceTimersByTime(TYPING_EXPIRY_MS);
    expect(ctrl.getSnapshot().peerTyping).toBe(false);

    // Outbound composer input coalesces bursts within 2s and sends explicit stop cleanly.
    const firstOut = await ctrl.notifyLocalComposerInput();
    expect(firstOut).toEqual({ sent: true, coalesced: false });
    clockMs += 400;
    const secondOut = await ctrl.notifyLocalComposerInput();
    expect(secondOut).toEqual({ sent: false, coalesced: true });
    await ctrl.notifyLocalComposerStop();
    expect(sentSignals).toEqual([true, false]);

    // Disconnect clears active peer typing immediately.
    ctrl.applyTypingUpdateEvent({
      schemaVersion: 1,
      conversationId: CONV_AB,
      userId: BOB,
      isTyping: true,
      expiresAt: new Date(clockMs + TYPING_EXPIRY_MS).toISOString(),
      updatedAt: new Date(clockMs).toISOString(),
    });
    expect(ctrl.getSnapshot().peerTyping).toBe(true);
    ctrl.handleTransportDisconnect();
    expect(ctrl.getSnapshot().peerTyping).toBe(false);

    // ERR-003 stale completion safety: delayed response from CONV_AB must NOT mutate switched CONV_2.
    sentSignals = [];
    const pendingLoad = ctrl.loadInitialState();
    ctrl.switchContext({
      conversationId: "conv_p212_switched_02",
      currentUserId: ALICE,
      peerUserId: "usr_p212_carol_04",
    });
    const resolver = resolveDelayedPresence as ((v: ConversationPresenceResponse) => void) | null;
    if (resolver) {
      resolver({
        presence: {
          schemaVersion: 1,
          conversationId: CONV_AB,
          peerUserId: BOB,
          status: "online",
          typing: true,
          typingExpiresAt: new Date(clockMs + 5000).toISOString(),
          updatedAt: new Date(clockMs).toISOString(),
        },
      });
    }
    await pendingLoad;
    expect(ctrl.getSnapshot().conversationId).toBe("conv_p212_switched_02");
    expect(ctrl.getSnapshot().peerStatus).toBe("unknown");
    expect(ctrl.getSnapshot().peerTyping).toBe(false);
    expect(new PresenceApiError(404, "NOT_FOUND", false).code).toBe("NOT_FOUND");
    ctrl.dispose();
  });
});

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  DEFAULT_ACTIVITY_SHARING_ENABLED,
  PRESENCE_LEASE_TTL_MS,
  PRESENCE_SCHEMA_VERSION,
  TYPING_COALESCE_MS,
  TYPING_EXPIRY_MS,
  type ActivityPreferencesView,
  type ConversationPresenceResponse,
  type PresenceState,
  type PresenceUpdateEvent,
  type TypingSignalResponse,
  type TypingUpdateEvent,
} from "@chat/contracts";

import { ActionButton } from "@/components/ui/action-button";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import surface from "@/components/ui/surface.module.css";
import {
  PresenceAndTypingController,
  type PresenceClient,
  type PresenceControllerSnapshot,
} from "@/src/features/presence";
import { useI18n } from "@/src/i18n/provider";
import type { MessageKey } from "@/src/i18n/catalog";

import styles from "./history-panel.module.css";

const CONV_ID = "conv_p212_presence_01";
const ALICE_ID = "usr_p212_alice_01";
const BOB_ID = "usr_p212_bob_02";

interface LeaseSlot {
  expiresAtMs: number;
}

class SimulatedPresenceEngine {
  clockMs = Date.UTC(2026, 10, 20, 10, 0, 0);
  activitySharingEnabled: boolean = DEFAULT_ACTIVITY_SHARING_ENABLED;
  blocked = false;
  seenBobInEpoch = false;
  bobLeases = new Map<string, LeaseSlot>();
  bobTypingExpiresAtMs: number | null = null;
  bobLastStartSignalAtMs: number | null = null;
  coalescedPeerBursts = 0;
  emittedPeerSignals = 0;

  private pruneExpired(): void {
    for (const [tabId, slot] of this.bobLeases.entries()) {
      if (slot.expiresAtMs <= this.clockMs) {
        this.bobLeases.delete(tabId);
      }
    }
    if (this.bobLeases.size === 0) {
      this.bobTypingExpiresAtMs = null;
    } else if (this.bobTypingExpiresAtMs !== null && this.bobTypingExpiresAtMs <= this.clockMs) {
      this.bobTypingExpiresAtMs = null;
    }
  }

  rawStatus(): PresenceState {
    this.pruneExpired();
    if (this.bobLeases.size > 0) return "online";
    if (!this.seenBobInEpoch) return "unknown";
    return "offline";
  }

  visibleStatus(): PresenceState {
    const raw = this.rawStatus();
    if (this.blocked || !this.activitySharingEnabled) return "unknown";
    return raw;
  }

  visibleTyping(): { typing: boolean; expiresAt: string | null } {
    this.pruneExpired();
    if (this.blocked || !this.activitySharingEnabled || this.rawStatus() !== "online") {
      return { typing: false, expiresAt: null };
    }
    if (this.bobTypingExpiresAtMs === null || this.bobTypingExpiresAtMs <= this.clockMs) {
      return { typing: false, expiresAt: null };
    }
    return {
      typing: true,
      expiresAt: new Date(this.bobTypingExpiresAtMs).toISOString(),
    };
  }

  presenceEvent(): PresenceUpdateEvent {
    return {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      conversationId: CONV_ID,
      userId: BOB_ID,
      status: this.visibleStatus(),
      updatedAt: new Date(this.clockMs).toISOString(),
    };
  }

  typingEvent(isTyping: boolean): TypingUpdateEvent {
    const allowed =
      isTyping && !this.blocked && this.activitySharingEnabled && this.rawStatus() === "online";
    return {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      conversationId: CONV_ID,
      userId: BOB_ID,
      isTyping: allowed,
      expiresAt:
        allowed && this.bobTypingExpiresAtMs !== null
          ? new Date(this.bobTypingExpiresAtMs).toISOString()
          : null,
      updatedAt: new Date(this.clockMs).toISOString(),
    };
  }
}

function statusLabelKey(status: PresenceState): MessageKey {
  if (status === "online") return "states.presenceTypingStatusOnline";
  if (status === "offline") return "states.presenceTypingStatusOffline";
  return "states.presenceTypingStatusUnknown";
}

/**
 * Interactive Presence & Typing fixture on `/states` (`P2-12`, `FR-PRES-001`..`004`,
 * `TC-PRES-001`, `TC-PRES-002`, `DEC-008`, `DEC-020` §6.3).
 */
export function PresenceTypingFixtureShowcase() {
  const { t } = useI18n();
  const engineRef = useRef<SimulatedPresenceEngine | null>(null);
  const controllerRef = useRef<PresenceAndTypingController | null>(null);

  const [snapshot, setSnapshot] = useState<PresenceControllerSnapshot>({
    conversationId: CONV_ID,
    currentUserId: ALICE_ID,
    peerUserId: BOB_ID,
    peerStatus: "unknown",
    peerTyping: false,
    peerTypingExpiresAt: null,
    activitySharingEnabled: DEFAULT_ACTIVITY_SHARING_ENABLED,
    localTypingActive: false,
    coalescedOutboundCount: 0,
    emittedOutboundSignals: 0,
    lastErrorCode: null,
  });
  const [activeTabs, setActiveTabs] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [coalescedBursts, setCoalescedBursts] = useState(0);
  const [emittedSignals, setEmittedSignals] = useState(0);
  const [phase, setPhase] = useState("initial");

  const initEngineOnly = useCallback(() => {
    controllerRef.current?.dispose();
    const engine = new SimulatedPresenceEngine();
    engineRef.current = engine;

    const client: PresenceClient = {
      async getActivityPreferences(): Promise<ActivityPreferencesView> {
        return {
          schemaVersion: PRESENCE_SCHEMA_VERSION,
          userId: ALICE_ID,
          activitySharingEnabled: engine.activitySharingEnabled,
          updatedAt: new Date(engine.clockMs).toISOString(),
        };
      },
      async setActivityPreferences(enabled: boolean): Promise<ActivityPreferencesView> {
        engine.activitySharingEnabled = enabled;
        if (!enabled) {
          engine.bobTypingExpiresAtMs = null;
        }
        return {
          schemaVersion: PRESENCE_SCHEMA_VERSION,
          userId: ALICE_ID,
          activitySharingEnabled: enabled,
          updatedAt: new Date(engine.clockMs).toISOString(),
        };
      },
      async getConversationPresence(): Promise<ConversationPresenceResponse> {
        const typing = engine.visibleTyping();
        return {
          presence: {
            schemaVersion: PRESENCE_SCHEMA_VERSION,
            conversationId: CONV_ID,
            peerUserId: BOB_ID,
            status: engine.visibleStatus(),
            typing: typing.typing,
            typingExpiresAt: typing.expiresAt,
            updatedAt: new Date(engine.clockMs).toISOString(),
          },
        };
      },
      async sendTypingSignal(
        _conversationId: string,
        isTyping: boolean,
      ): Promise<TypingSignalResponse> {
        return {
          typing: {
            schemaVersion: PRESENCE_SCHEMA_VERSION,
            conversationId: CONV_ID,
            userId: ALICE_ID,
            isTyping: isTyping && engine.activitySharingEnabled && !engine.blocked,
            accepted: true,
            coalesced: false,
            suppressed: !engine.activitySharingEnabled || engine.blocked,
            expiresAt:
              isTyping && engine.activitySharingEnabled && !engine.blocked
                ? new Date(engine.clockMs + TYPING_EXPIRY_MS).toISOString()
                : null,
            updatedAt: new Date(engine.clockMs).toISOString(),
          },
        };
      },
    };

    const controller = new PresenceAndTypingController({
      conversationId: CONV_ID,
      currentUserId: ALICE_ID,
      peerUserId: BOB_ID,
      client,
      now: () => engine.clockMs,
      onStateChange: (next) => {
        setSnapshot(next);
      },
    });
    controllerRef.current = controller;
    return { engine, controller };
  }, []);

  const ensureReady = useCallback(() => {
    if (engineRef.current && controllerRef.current) {
      return { engine: engineRef.current, controller: controllerRef.current };
    }
    return initEngineOnly();
  }, [initEngineOnly]);

  const createControllerAndEngine = useCallback(() => {
    const { controller } = initEngineOnly();
    setActiveTabs(0);
    setBlocked(false);
    setCoalescedBursts(0);
    setEmittedSignals(0);
    setPhase("initial");
    setSnapshot(controller.getSnapshot());
  }, [initEngineOnly]);

  useEffect(() => {
    initEngineOnly();
    return () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      engineRef.current = null;
    };
  }, [initEngineOnly]);

  const syncUiFromEngine = useCallback(
    (nextPhase: string) => {
      const { engine, controller: ctrl } = ensureReady();
      ctrl.applyPresenceUpdateEvent(engine.presenceEvent());
      const typingState = engine.visibleTyping();
      ctrl.applyTypingUpdateEvent(engine.typingEvent(typingState.typing));
      setActiveTabs(engine.bobLeases.size);
      setBlocked(engine.blocked);
      setCoalescedBursts(engine.coalescedPeerBursts);
      setEmittedSignals(engine.emittedPeerSignals);
      setPhase(nextPhase);
    },
    [ensureReady],
  );

  const handleConnectTab = (tabId: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.seenBobInEpoch = true;
    engine.bobLeases.set(tabId, { expiresAtMs: engine.clockMs + PRESENCE_LEASE_TTL_MS });
    syncUiFromEngine(`${tabId}_connected`);
  };

  const handleCloseTab = (tabId: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.bobLeases.delete(tabId);
    if (engine.bobLeases.size === 0) {
      engine.bobTypingExpiresAtMs = null;
    }
    syncUiFromEngine(`${tabId}_closed`);
  };

  const handleAdvanceLeaseExpiry = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.clockMs += PRESENCE_LEASE_TTL_MS + 1;
    syncUiFromEngine("lease_expired");
  };

  const handleSimulateServerRestart = () => {
    const engine = engineRef.current;
    const ctrl = controllerRef.current;
    if (!engine || !ctrl) return;
    engine.bobLeases.clear();
    engine.seenBobInEpoch = false;
    engine.bobTypingExpiresAtMs = null;
    engine.bobLastStartSignalAtMs = null;
    ctrl.handleTransportDisconnect();
    syncUiFromEngine("server_restarted");
  };

  const handlePeerTypingBurst = () => {
    const engine = engineRef.current;
    const ctrl = controllerRef.current;
    if (!engine || !ctrl) return;
    if (engine.rawStatus() !== "online") {
      engine.seenBobInEpoch = true;
      engine.bobLeases.set("tab1", { expiresAtMs: engine.clockMs + PRESENCE_LEASE_TTL_MS });
    }
    if (
      engine.bobLastStartSignalAtMs !== null &&
      engine.clockMs - engine.bobLastStartSignalAtMs < TYPING_COALESCE_MS
    ) {
      engine.coalescedPeerBursts += 1;
      syncUiFromEngine("typing_coalesced");
      return;
    }
    engine.bobLastStartSignalAtMs = engine.clockMs;
    engine.bobTypingExpiresAtMs = engine.clockMs + TYPING_EXPIRY_MS;
    engine.emittedPeerSignals += 1;
    syncUiFromEngine("typing_started");
  };

  const handlePeerTypingStop = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.bobTypingExpiresAtMs = null;
    syncUiFromEngine("typing_stopped");
  };

  const handleAdvanceTypingExpiry = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.clockMs += TYPING_EXPIRY_MS + 1;
    syncUiFromEngine("typing_expired");
  };

  const handleDisconnectAndReconnect = async () => {
    const engine = engineRef.current;
    const ctrl = controllerRef.current;
    if (!engine || !ctrl) return;
    engine.bobTypingExpiresAtMs = null;
    ctrl.handleTransportDisconnect();
    await ctrl.handleTransportReconnect();
    setActiveTabs(engine.bobLeases.size);
    setBlocked(engine.blocked);
    setCoalescedBursts(engine.coalescedPeerBursts);
    setEmittedSignals(engine.emittedPeerSignals);
    setPhase("reconnected_clean");
  };

  const handleToggleActivitySharing = async () => {
    const engine = engineRef.current;
    const ctrl = controllerRef.current;
    if (!engine || !ctrl) return;
    const next = !engine.activitySharingEnabled;
    await ctrl.setActivitySharing(next);
    syncUiFromEngine(next ? "activity_sharing_on" : "activity_sharing_off");
  };

  const handleToggleBlock = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.blocked = !engine.blocked;
    if (engine.blocked) {
      engine.bobTypingExpiresAtMs = null;
    }
    syncUiFromEngine(engine.blocked ? "bilateral_blocked" : "unblocked");
  };

  return (
    <section
      className={`${surface.card} ${styles.showcaseCard}`}
      aria-label={t("states.presenceTypingSectionLabel")}
      data-testid="presence-typing-fixture"
    >
      <div className={styles.wrapper}>
        <div>
          <h2 className={surface.cardTitle}>{t("states.presenceTypingTitle")}</h2>
          <p className={surface.cardDescription}>{t("states.presenceTypingSubtitle")}</p>
        </div>

        <PlaceholderNotice title={t("states.presenceTypingNoticeTitle")}>
          {t("states.presenceTypingNoticeBody")}
        </PlaceholderNotice>

        <div className={styles.inlineBanner} data-testid="presence-status-panel">
          <p
            className={styles.bannerTitle}
            data-testid="presence-peer-status"
            data-status={snapshot.peerStatus}
            data-typing={String(snapshot.peerTyping)}
          >
            {t("states.presenceTypingPeerHeading", {
              status: t(statusLabelKey(snapshot.peerStatus)),
              tabs: activeTabs,
            })}
          </p>
          <p className={styles.bannerDescription} data-testid="presence-typing-indicator">
            {snapshot.peerTyping
              ? t("states.presenceTypingIndicatorActive")
              : t("states.presenceTypingIndicatorIdle")}
          </p>
          <p className={styles.statusMeta} data-testid="presence-typing-summary">
            {t("states.presenceTypingStatusSummary", {
              phase,
              sharing: snapshot.activitySharingEnabled
                ? t("states.presenceTypingSharingOn")
                : t("states.presenceTypingSharingOff"),
              blocked: blocked
                ? t("states.presenceTypingBlockedOn")
                : t("states.presenceTypingBlockedOff"),
              emitted: emittedSignals,
              coalesced: coalescedBursts,
            })}
          </p>
        </div>

        <div className={styles.toolbar}>
          <ActionButton type="button" variant="primary" onClick={() => handleConnectTab("tab1")}>
            {t("states.presenceTypingBtnTab1Connect")}
          </ActionButton>
          <ActionButton type="button" variant="secondary" onClick={() => handleConnectTab("tab2")}>
            {t("states.presenceTypingBtnTab2Connect")}
          </ActionButton>
          <ActionButton type="button" variant="secondary" onClick={() => handleCloseTab("tab1")}>
            {t("states.presenceTypingBtnTab1Close")}
          </ActionButton>
          <ActionButton type="button" variant="secondary" onClick={() => handleCloseTab("tab2")}>
            {t("states.presenceTypingBtnTab2Close")}
          </ActionButton>
          <ActionButton type="button" variant="secondary" onClick={handleAdvanceLeaseExpiry}>
            {t("states.presenceTypingBtnLeaseExpire")}
          </ActionButton>
          <ActionButton type="button" variant="secondary" onClick={handleSimulateServerRestart}>
            {t("states.presenceTypingBtnRestartServer")}
          </ActionButton>
          <ActionButton type="button" variant="primary" onClick={handlePeerTypingBurst}>
            {t("states.presenceTypingBtnPeerTypingStart")}
          </ActionButton>
          <ActionButton type="button" variant="secondary" onClick={handlePeerTypingStop}>
            {t("states.presenceTypingBtnPeerTypingStop")}
          </ActionButton>
          <ActionButton type="button" variant="secondary" onClick={handleAdvanceTypingExpiry}>
            {t("states.presenceTypingBtnTypingExpire")}
          </ActionButton>
          <ActionButton
            type="button"
            variant="secondary"
            onClick={() => {
              void handleDisconnectAndReconnect();
            }}
          >
            {t("states.presenceTypingBtnReconnectClear")}
          </ActionButton>
          <ActionButton
            type="button"
            variant="secondary"
            onClick={() => {
              void handleToggleActivitySharing();
            }}
          >
            {t("states.presenceTypingBtnToggleActivity")}
          </ActionButton>
          <ActionButton type="button" variant="secondary" onClick={handleToggleBlock}>
            {t("states.presenceTypingBtnToggleBlock")}
          </ActionButton>
          <ActionButton type="button" variant="ghost" onClick={createControllerAndEngine}>
            {t("states.presenceTypingBtnReset")}
          </ActionButton>
        </div>
      </div>
    </section>
  );
}

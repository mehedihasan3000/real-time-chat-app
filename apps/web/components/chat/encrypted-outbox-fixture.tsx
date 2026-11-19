"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { MESSAGE_ALLOWED_PROTOCOL_VERSION, type MessageSendResponse } from "@chat/contracts";
import { OUTBOX_IDB_DEFAULT_NAME, OlmAccountDevice } from "@chat/crypto";

import { ActionButton } from "@/components/ui/action-button";
import surface from "@/components/ui/surface.module.css";
import { prepareEncryptedSend, type PreparedEncryptedSend } from "@/src/features/chat/send";
import type { OutboxActionKind } from "@/src/features/chat/send-state";
import { useI18n } from "@/src/i18n/provider";
import {
  EncryptedIndexedDbOutboxStorageAdapter,
  SendOutboxCoordinator,
  type OutboxSnapshot,
  type PreparedMessageSender,
} from "@/src/lib/outbox/index";

import { SendStateList } from "./send-state-list";
import styles from "./send-state.module.css";

const ACCOUNT_ID = "fixture_p209_user_a";
const PEER_ACCOUNT_ID = "fixture_p209_user_b";
const CONV_ID = "conv_p209_01";
const PLAINTEXT_SECRET_MARKER = "SECRET_OUTBOX_MARKER_DO_NOT_PERSIST";

interface AtRestTelemetry {
  sealedCount: number;
  hasKey: boolean;
  plaintextBytes: number;
  networkSends: number;
}

interface FixtureState {
  storage: EncryptedIndexedDbOutboxStorageAdapter;
  coordinator: SendOutboxCoordinator;
  alice: OlmAccountDevice | null;
  bob: OlmAccountDevice | null;
  preparedEnvelopes: Set<string>;
  networkSends: number;
  seq: number;
  latencyMs: number;
  committedByClientId: Map<string, MessageSendResponse>;
  unsubscribe: () => void;
}

const INITIAL_SNAPSHOT: OutboxSnapshot = {
  accountId: ACCOUNT_ID,
  activeConversationId: CONV_ID,
  online: false,
  storageAvailable: true,
  storageNoticeCode: null,
  logoutWarningPendingCount: null,
  entriesForActiveConversation: [],
  allEntries: [],
};

const INITIAL_TELEMETRY: AtRestTelemetry = {
  sealedCount: 0,
  hasKey: false,
  plaintextBytes: 0,
  networkSends: 0,
};

function countLeakedPlaintextBytes(rawJson: string, envelopes: ReadonlySet<string>): number {
  let leaked = 0;
  if (rawJson.includes(PLAINTEXT_SECRET_MARKER)) {
    leaked += PLAINTEXT_SECRET_MARKER.length;
  }
  for (const envelope of envelopes) {
    if (envelope.length > 0 && rawJson.includes(envelope)) {
      leaked += envelope.length;
    }
  }
  return leaked;
}

export function EncryptedOutboxFixtureShowcase() {
  const { t } = useI18n();
  const runtimeRef = useRef<FixtureState | null>(null);
  const [snapshot, setSnapshot] = useState<OutboxSnapshot>(INITIAL_SNAPSHOT);
  const [telemetry, setTelemetry] = useState<AtRestTelemetry>(INITIAL_TELEMETRY);
  const [busy, setBusy] = useState(false);

  const refreshTelemetry = useCallback(async (rt: FixtureState) => {
    const inspection = await rt.storage.inspectAtRest(ACCOUNT_ID);
    const serialized = JSON.stringify(inspection.sealedEntries);
    const leaked = countLeakedPlaintextBytes(serialized, rt.preparedEnvelopes);
    setTelemetry({
      sealedCount: inspection.sealedEntries.length,
      hasKey: inspection.hasKey && inspection.keyExtractable === false,
      plaintextBytes: leaked,
      networkSends: rt.networkSends,
    });
  }, []);

  const ensureDevices = useCallback(async (rt: FixtureState) => {
    if (!rt.alice) {
      rt.alice = await OlmAccountDevice.create({ deviceId: "dev-p209-alice-01" });
    }
    if (!rt.bob) {
      rt.bob = await OlmAccountDevice.create({ deviceId: "dev-p209-bob-01" });
    }
    return { alice: rt.alice, bob: rt.bob };
  }, []);

  const buildNextPrepared = useCallback(
    async (rt: FixtureState, indexLabel: number): Promise<PreparedEncryptedSend> => {
      const { alice, bob } = await ensureDevices(rt);
      const bobBundle = bob.toPublicKeyBundle();
      const plaintext = `Encrypted outbox message #${indexLabel} — বাংলা 🔒 ${PLAINTEXT_SECRET_MARKER}`;
      const result = await prepareEncryptedSend({
        conversationId: CONV_ID,
        senderDevice: alice,
        peerTarget: {
          peerUserId: PEER_ACCOUNT_ID,
          peerDeviceId: bobBundle.deviceId,
          peerIdentityKey: bobBundle.identityKey,
          peerSenderKey: bobBundle.senderKey,
          peerOneTimeOrFallbackKey: bobBundle.oneTimeKeys[0]?.key ?? bobBundle.fallbackKey.key,
        },
        plaintext,
      });
      if (!result.ok) {
        throw new Error(result.failure.message);
      }
      rt.preparedEnvelopes.add(result.prepared.payload.encryptedEnvelope);
      return result.prepared;
    },
    [ensureDevices],
  );

  useEffect(() => {
    let active = true;
    const storage = new EncryptedIndexedDbOutboxStorageAdapter({
      dbName: OUTBOX_IDB_DEFAULT_NAME,
    });

    const rt: FixtureState = {
      storage,
      coordinator: null as unknown as SendOutboxCoordinator,
      alice: null,
      bob: null,
      preparedEnvelopes: new Set(),
      networkSends: 0,
      seq: 0,
      latencyMs: 0,
      committedByClientId: new Map(),
      unsubscribe: () => {},
    };

    const sender: PreparedMessageSender = {
      async sendPrepared(prepared: PreparedEncryptedSend): Promise<MessageSendResponse> {
        rt.networkSends += 1;
        if (rt.latencyMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, rt.latencyMs));
        }
        const existing = rt.committedByClientId.get(prepared.payload.clientMessageId);
        if (existing) {
          return { ...existing, idempotent: true };
        }
        rt.seq += 1;
        const created: MessageSendResponse = {
          idempotent: false,
          message: {
            messageId: `msg_p209_${rt.seq}`,
            conversationId: prepared.conversationId,
            seq: rt.seq,
            senderUserId: ACCOUNT_ID,
            senderDeviceId: prepared.payload.senderDeviceId,
            clientMessageId: prepared.payload.clientMessageId,
            protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
            committedAt: new Date().toISOString(),
            schemaVersion: 1,
          },
        };
        rt.committedByClientId.set(prepared.payload.clientMessageId, created);
        return created;
      },
    };

    const coordinator = new SendOutboxCoordinator({
      accountId: ACCOUNT_ID,
      activeConversationId: CONV_ID,
      sender,
      storage,
      online: false,
      random: () => 0.5,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });
    rt.coordinator = coordinator;
    runtimeRef.current = rt;

    rt.unsubscribe = coordinator.subscribe((next) => {
      if (active) {
        setSnapshot(next);
      }
    });

    void (async () => {
      const inspection = await storage.inspectAtRest(ACCOUNT_ID);
      if (!active) return;
      if (inspection.sealedEntries.length > 0 || (inspection.meta?.pendingCount ?? 0) > 0) {
        await coordinator.hydrate();
      }
      if (active) {
        await refreshTelemetry(rt);
      }
    })();

    return () => {
      active = false;
      rt.unsubscribe();
      try {
        rt.alice?.dispose();
      } catch {
        // ignore cleanup error
      }
      try {
        rt.bob?.dispose();
      } catch {
        // ignore cleanup error
      }
      runtimeRef.current = null;
    };
  }, [refreshTelemetry]);

  const runAction = useCallback(
    async (task: (rt: FixtureState) => Promise<void>) => {
      const rt = runtimeRef.current;
      if (!rt) return;
      setBusy(true);
      try {
        await task(rt);
        await refreshTelemetry(rt);
      } finally {
        setBusy(false);
      }
    },
    [refreshTelemetry],
  );

  const handleQueueOffline = () =>
    runAction(async (rt) => {
      await rt.coordinator.setOnline(false);
      const count = rt.coordinator.getSnapshot().allEntries.length + 1;
      const prepared = await buildNextPrepared(rt, count);
      await rt.coordinator.submitPrepared(prepared);
    });

  const handleSimulateReload = () =>
    runAction(async (rt) => {
      await rt.coordinator.setOnline(false);
      await rt.coordinator.reconcileAfterReload();
    });

  const handleFlushOnline = () =>
    runAction(async (rt) => {
      rt.latencyMs = 0;
      await rt.coordinator.setOnline(true);
    });

  const handleTwoTabRace = () =>
    runAction(async (rt) => {
      rt.networkSends = 0;
      rt.seq = 0;
      rt.committedByClientId.clear();
      await rt.coordinator.logoutAndClear();
      await rt.coordinator.setOnline(false);

      const prepared = await buildNextPrepared(rt, 1);
      await rt.coordinator.submitPrepared(prepared);

      const siblingSender: PreparedMessageSender = {
        async sendPrepared(prep: PreparedEncryptedSend): Promise<MessageSendResponse> {
          rt.networkSends += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, 35));
          rt.seq += 1;
          const created: MessageSendResponse = {
            idempotent: false,
            message: {
              messageId: `msg_p209_race_${rt.seq}`,
              conversationId: prep.conversationId,
              seq: rt.seq,
              senderUserId: ACCOUNT_ID,
              senderDeviceId: prep.payload.senderDeviceId,
              clientMessageId: prep.payload.clientMessageId,
              protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
              committedAt: new Date().toISOString(),
              schemaVersion: 1,
            },
          };
          rt.committedByClientId.set(prep.payload.clientMessageId, created);
          return created;
        },
      };

      const tabB = new SendOutboxCoordinator({
        accountId: ACCOUNT_ID,
        activeConversationId: CONV_ID,
        sender: siblingSender,
        storage: rt.storage,
        online: false,
        random: () => 0.5,
        scheduleTimer: () => 0,
        cancelTimer: () => {},
      });
      await tabB.hydrate();

      rt.latencyMs = 40;
      await Promise.all([rt.coordinator.setOnline(true), tabB.setOnline(true)]);
      rt.latencyMs = 0;
    });

  const handleEvictKey = () =>
    runAction(async (rt) => {
      if ((await rt.storage.inspectAtRest(ACCOUNT_ID)).sealedEntries.length === 0) {
        await rt.coordinator.setOnline(false);
        const prepared = await buildNextPrepared(rt, 1);
        await rt.coordinator.submitPrepared(prepared);
      }
      await rt.storage.simulateKeyEviction(ACCOUNT_ID);
      await rt.coordinator.reconcileAfterReload();
    });

  const handleTamperCiphertext = () =>
    runAction(async (rt) => {
      let inspection = await rt.storage.inspectAtRest(ACCOUNT_ID);
      if (inspection.sealedEntries.length === 0) {
        await rt.coordinator.setOnline(false);
        const prepared = await buildNextPrepared(rt, 1);
        await rt.coordinator.submitPrepared(prepared);
        inspection = await rt.storage.inspectAtRest(ACCOUNT_ID);
      }
      const target = inspection.sealedEntries[0];
      if (target) {
        await rt.storage.simulateCiphertextTamper(ACCOUNT_ID, target.clientMessageId);
      }
      await rt.coordinator.hydrate();
    });

  const handleLogoutWarn = () =>
    runAction(async (rt) => {
      if (!rt.coordinator.hasPendingEntries()) {
        await rt.coordinator.setOnline(false);
        const prepared = await buildNextPrepared(rt, 1);
        await rt.coordinator.submitPrepared(prepared);
      }
      await rt.coordinator.requestLogout();
    });

  const handleLogoutConfirm = () =>
    runAction(async (rt) => {
      await rt.coordinator.requestLogout({ confirmDiscardPending: true });
    });

  const handleReset = () =>
    runAction(async (rt) => {
      rt.networkSends = 0;
      rt.seq = 0;
      rt.latencyMs = 0;
      rt.committedByClientId.clear();
      rt.preparedEnvelopes.clear();
      await rt.coordinator.logoutAndClear();
      await rt.coordinator.setOnline(false);
    });

  const handleListAction = (clientMessageId: string, kind: OutboxActionKind) =>
    void runAction(async (rt) => {
      if (kind === "retry_now" || kind === "manual_retry") {
        rt.latencyMs = 0;
        await rt.coordinator.setOnline(true);
        await rt.coordinator.manualRetry(clientMessageId);
      } else if (kind === "discard") {
        await rt.coordinator.discard(clientMessageId);
      }
    });

  return (
    <section
      className={`${surface.card} ${styles.showcaseCard}`}
      aria-labelledby="encrypted-outbox-preview-title"
      data-testid="encrypted-outbox-fixture-showcase"
    >
      <div className={surface.cardHeader}>
        <div>
          <h2 className={surface.cardTitle} id="encrypted-outbox-preview-title">
            {t("states.encryptedOutboxTitle")}
          </h2>
          <p className={surface.cardDescription}>{t("states.encryptedOutboxDescription")}</p>
        </div>
        <div className={styles.statusSummary}>
          <span className={styles.statusPill}>{t("states.encryptedOutboxStorageBadge")}</span>
        </div>
      </div>

      <p className="u-muted u-small" style={{ marginBottom: "var(--space-2)" }}>
        {t("states.encryptedOutboxNotice")}
      </p>

      <p
        className="u-small"
        style={{ marginBottom: "var(--space-3)", fontWeight: 600 }}
        data-testid="encrypted-outbox-telemetry"
        data-sealed-count={telemetry.sealedCount}
        data-has-key={String(telemetry.hasKey)}
        data-plaintext-bytes={telemetry.plaintextBytes}
        data-network-sends={telemetry.networkSends}
      >
        {t("states.encryptedOutboxStatusSummary", {
          count: telemetry.sealedCount,
          keyCount: telemetry.hasKey ? 1 : 0,
          plaintextBytes: telemetry.plaintextBytes,
          sends: telemetry.networkSends,
        })}
      </p>

      <div className={styles.toolbar} style={{ marginBottom: "var(--space-4)" }}>
        <ActionButton disabled={busy} onClick={() => void handleQueueOffline()}>
          {t("states.encryptedOutboxBtnQueue")}
        </ActionButton>
        <ActionButton disabled={busy} onClick={() => void handleSimulateReload()}>
          {t("states.encryptedOutboxBtnReload")}
        </ActionButton>
        <ActionButton disabled={busy} variant="primary" onClick={() => void handleFlushOnline()}>
          {t("states.encryptedOutboxBtnFlush")}
        </ActionButton>
        <ActionButton disabled={busy} onClick={() => void handleTwoTabRace()}>
          {t("states.encryptedOutboxBtnMultiTab")}
        </ActionButton>
        <ActionButton disabled={busy} onClick={() => void handleEvictKey()}>
          {t("states.encryptedOutboxBtnEvictKey")}
        </ActionButton>
        <ActionButton disabled={busy} onClick={() => void handleTamperCiphertext()}>
          {t("states.encryptedOutboxBtnTamper")}
        </ActionButton>
        <ActionButton disabled={busy} onClick={() => void handleLogoutWarn()}>
          {t("states.encryptedOutboxBtnLogoutWarn")}
        </ActionButton>
        <ActionButton disabled={busy} onClick={() => void handleLogoutConfirm()}>
          {t("states.encryptedOutboxBtnLogoutConfirm")}
        </ActionButton>
        <ActionButton disabled={busy} variant="ghost" onClick={() => void handleReset()}>
          {t("states.encryptedOutboxBtnReset")}
        </ActionButton>
      </div>

      <SendStateList snapshot={snapshot} onAction={handleListAction} />
    </section>
  );
}

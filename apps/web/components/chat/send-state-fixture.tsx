"use client";

import { useEffect, useRef, useState } from "react";
import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  type MessageSendResponse,
} from "@chat/contracts";

import { ActionButton } from "@/components/ui/action-button";
import surface from "@/components/ui/surface.module.css";
import { MessageSendApiError, type PreparedEncryptedSend } from "@/src/features/chat/send";
import type { OutboxActionKind } from "@/src/features/chat/send-state";
import { useI18n } from "@/src/i18n/provider";
import {
  InMemoryOutboxStorageAdapter,
  SendOutboxCoordinator,
  type OutboxSnapshot,
  type PreparedMessageSender,
} from "@/src/lib/outbox/index";

import { SendStateList } from "./send-state-list";
import styles from "./send-state.module.css";

const SYNTHETIC_ACCOUNT = "fixture_user_a";
const SYNTHETIC_CONV = "conv_fixture_01";
const SYNTHETIC_DEVICE = "dev-fixture-01";
const INITIAL_NOW_MS = 1_763_500_000_000;

type MockServerBehavior = "accept" | "drop_ack" | "session_revoked" | "network_error";

function buildSyntheticEnvelope(seed: number): string {
  const payload = {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    senderDeviceId: SYNTHETIC_DEVICE,
    recipientDeviceId: "dev-fixture-peer-01",
    senderIdentityKey: "a".repeat(43),
    senderCurve25519Key: "b".repeat(43),
    sessionId: "session-fixture-01",
    messageIndex: seed,
    messageType: 0 as const,
    ciphertext: "c3ludGhldGljLWZpeHR1cmUtZW5jcnlwdGVkLWJ5dGVzLTEyMzQ1",
  };
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function makeSyntheticUuid(counter: number): string {
  const hex = counter.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

interface FixtureRuntime {
  storage: InMemoryOutboxStorageAdapter;
  coordinator: SendOutboxCoordinator;
  getNowMs: () => number;
  advanceNow: (deltaMs: number) => number;
  setBehavior: (next: MockServerBehavior) => void;
  resetCommitted: () => void;
  nextPrepared: () => PreparedEncryptedSend;
}

function createFixtureRuntime(): FixtureRuntime {
  const storage = new InMemoryOutboxStorageAdapter();
  let nowMs = INITIAL_NOW_MS;
  let counter = 1;
  let seq = 0;
  let behavior: MockServerBehavior = "accept";
  const committedMap = new Map<string, MessageSendResponse>();

  const mockSender: PreparedMessageSender = {
    async sendPrepared(prepared: PreparedEncryptedSend): Promise<MessageSendResponse> {
      if (behavior === "session_revoked") {
        throw new MessageSendApiError(401, "SESSION_REVOKED", false, "unauthenticated");
      }
      if (behavior === "network_error") {
        throw new MessageSendApiError(0, "NETWORK_ERROR", true, "unknown");
      }
      if (behavior === "drop_ack") {
        if (!committedMap.has(prepared.payload.clientMessageId)) {
          seq += 1;
          committedMap.set(prepared.payload.clientMessageId, {
            idempotent: false,
            message: {
              messageId: `msg_fixture_${seq}`,
              conversationId: prepared.conversationId,
              seq,
              senderUserId: SYNTHETIC_ACCOUNT,
              senderDeviceId: prepared.payload.senderDeviceId,
              clientMessageId: prepared.payload.clientMessageId,
              protocolVersion: prepared.payload.protocolVersion,
              committedAt: new Date(nowMs).toISOString(),
              schemaVersion: 1,
            },
          });
        }
        throw new MessageSendApiError(503, "TEMPORARILY_UNAVAILABLE", true, "unknown");
      }

      const existing = committedMap.get(prepared.payload.clientMessageId);
      if (existing) {
        return { ...existing, idempotent: true };
      }
      seq += 1;
      const created: MessageSendResponse = {
        idempotent: false,
        message: {
          messageId: `msg_fixture_${seq}`,
          conversationId: prepared.conversationId,
          seq,
          senderUserId: SYNTHETIC_ACCOUNT,
          senderDeviceId: prepared.payload.senderDeviceId,
          clientMessageId: prepared.payload.clientMessageId,
          protocolVersion: prepared.payload.protocolVersion,
          committedAt: new Date(nowMs).toISOString(),
          schemaVersion: 1,
        },
      };
      committedMap.set(prepared.payload.clientMessageId, created);
      return created;
    },
  };

  const coordinator = new SendOutboxCoordinator({
    accountId: SYNTHETIC_ACCOUNT,
    activeConversationId: SYNTHETIC_CONV,
    sender: mockSender,
    storage,
    online: true,
    nowMs: () => nowMs,
    random: () => 0.5,
    scheduleTimer: () => 0,
    cancelTimer: () => {},
  });

  return {
    storage,
    coordinator,
    getNowMs: () => nowMs,
    advanceNow: (deltaMs: number) => {
      nowMs += deltaMs;
      return nowMs;
    },
    setBehavior: (next: MockServerBehavior) => {
      behavior = next;
    },
    resetCommitted: () => {
      committedMap.clear();
      seq = 0;
    },
    nextPrepared: () => {
      const currentCounter = counter;
      counter += 1;
      return {
        conversationId: SYNTHETIC_CONV,
        payload: {
          schemaVersion: MESSAGE_SCHEMA_VERSION,
          clientMessageId: makeSyntheticUuid(currentCounter),
          senderDeviceId: SYNTHETIC_DEVICE,
          protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
          encryptedEnvelope: buildSyntheticEnvelope(currentCounter),
        },
      };
    },
  };
}

const INITIAL_SNAPSHOT: OutboxSnapshot = {
  accountId: SYNTHETIC_ACCOUNT,
  activeConversationId: SYNTHETIC_CONV,
  online: true,
  storageAvailable: true,
  storageNoticeCode: null,
  entriesForActiveConversation: [],
  allEntries: [],
};

export function SendStateFixtureShowcase() {
  const { t } = useI18n();
  const runtimeRef = useRef<FixtureRuntime | null>(null);
  const [snapshot, setSnapshot] = useState<OutboxSnapshot>(INITIAL_SNAPSHOT);
  const [displayNowMs, setDisplayNowMs] = useState<number>(INITIAL_NOW_MS);

  useEffect(() => {
    const rt = createFixtureRuntime();
    runtimeRef.current = rt;
    const unsubscribe = rt.coordinator.subscribe((next) => {
      setSnapshot(next);
      setDisplayNowMs(rt.getNowMs());
    });
    return () => {
      unsubscribe();
      runtimeRef.current = null;
    };
  }, []);

  const resetAll = async () => {
    const rt = runtimeRef.current;
    if (!rt) return;
    rt.storage.setAvailable(true);
    rt.setBehavior("accept");
    rt.resetCommitted();
    await rt.coordinator.logoutAndClear();
    await rt.coordinator.setOnline(true);
  };

  const runOfflineQueued = async () => {
    const rt = runtimeRef.current;
    if (!rt) return;
    rt.storage.setAvailable(true);
    rt.setBehavior("accept");
    await rt.coordinator.setOnline(false);
    await rt.coordinator.submitPrepared(rt.nextPrepared());
  };

  const runDroppedAck = async () => {
    const rt = runtimeRef.current;
    if (!rt) return;
    rt.storage.setAvailable(true);
    rt.setBehavior("drop_ack");
    await rt.coordinator.setOnline(true);
    await rt.coordinator.submitPrepared(rt.nextPrepared());
  };

  const runSimulateReload = async () => {
    const rt = runtimeRef.current;
    if (!rt) return;
    rt.storage.setAvailable(true);
    rt.setBehavior("drop_ack");
    if (rt.coordinator.getSnapshot().entriesForActiveConversation.length === 0) {
      await rt.coordinator.submitPrepared(rt.nextPrepared());
    }
    await rt.coordinator.setOnline(false);
    await rt.coordinator.reconcileAfterReload();
  };

  const runReconnectConfirm = async () => {
    const rt = runtimeRef.current;
    if (!rt) return;
    rt.storage.setAvailable(true);
    rt.setBehavior("accept");
    await rt.coordinator.setOnline(true);
  };

  const runExhausted = async () => {
    const rt = runtimeRef.current;
    if (!rt) return;
    rt.storage.setAvailable(true);
    rt.setBehavior("network_error");
    await rt.coordinator.setOnline(true);
    const created = await rt.coordinator.submitPrepared(rt.nextPrepared());
    for (let i = 0; i < 12; i += 1) {
      const current = rt.coordinator
        .getSnapshot()
        .entriesForActiveConversation.find((e) => e.clientMessageId === created.clientMessageId);
      if (!current || current.status === "failed" || current.status === "sent") break;
      const targetMs = current.nextAttemptAtMs ?? rt.getNowMs() + 1_000;
      const stepMs = Math.max(1_000, targetMs - rt.getNowMs() + 1);
      rt.advanceNow(stepMs);
      await rt.coordinator.flushDue();
    }
    rt.setBehavior("accept");
  };

  const runSessionRevoked = async () => {
    const rt = runtimeRef.current;
    if (!rt) return;
    rt.storage.setAvailable(true);
    rt.setBehavior("session_revoked");
    await rt.coordinator.setOnline(true);
    await rt.coordinator.submitPrepared(rt.nextPrepared());
  };

  const runDeviceRevoked = async () => {
    const rt = runtimeRef.current;
    if (!rt) return;
    rt.storage.setAvailable(true);
    rt.setBehavior("accept");
    await rt.coordinator.setOnline(false);
    await rt.coordinator.submitPrepared(rt.nextPrepared());
    await rt.coordinator.onDeviceRevoked();
  };

  const runStorageUnavailable = async () => {
    const rt = runtimeRef.current;
    if (!rt) return;
    rt.storage.setAvailable(false);
    rt.setBehavior("accept");
    await rt.coordinator.setOnline(false);
    await rt.coordinator.submitPrepared(rt.nextPrepared());
  };

  const handleItemAction = async (clientMessageId: string, kind: OutboxActionKind) => {
    const rt = runtimeRef.current;
    if (!rt) return;
    if (kind === "retry_now" || kind === "manual_retry") {
      rt.setBehavior("accept");
      await rt.coordinator.setOnline(true);
      await rt.coordinator.manualRetry(clientMessageId);
      return;
    }
    if (kind === "discard") {
      await rt.coordinator.discard(clientMessageId);
    }
  };

  return (
    <section
      className={`${surface.card} ${styles.showcaseCard}`}
      aria-labelledby="send-state-preview-title"
      data-testid="send-state-fixture-showcase"
    >
      <div className={surface.cardHeader}>
        <div>
          <h2 className={surface.cardTitle} id="send-state-preview-title">
            {t("states.sendStateTitle")}
          </h2>
          <p className={surface.cardDescription}>{t("states.sendStateDescription")}</p>
        </div>
        <div className={styles.statusSummary}>
          <span className={styles.statusPill}>
            {snapshot.online
              ? t("states.sendStateNetworkOnline")
              : t("states.sendStateNetworkOffline")}
          </span>
          <span className={styles.statusPill}>
            {snapshot.storageAvailable
              ? t("states.sendStateStorageOk")
              : t("states.sendStateStorageFailed")}
          </span>
        </div>
      </div>

      <p className="u-muted u-small" style={{ marginBottom: "var(--space-3)" }}>
        {t("states.sendStateNotice")}
      </p>

      <div className={styles.toolbar} style={{ marginBottom: "var(--space-4)" }}>
        <ActionButton onClick={() => void runOfflineQueued()}>
          {t("states.sendStateFixtureDisconnected")}
        </ActionButton>
        <ActionButton onClick={() => void runDroppedAck()}>
          {t("states.sendStateFixtureDroppedAck")}
        </ActionButton>
        <ActionButton onClick={() => void runSimulateReload()}>
          {t("states.sendStateFixtureReload")}
        </ActionButton>
        <ActionButton variant="primary" onClick={() => void runReconnectConfirm()}>
          {t("states.sendStateFixtureReconnect")}
        </ActionButton>
        <ActionButton onClick={() => void runExhausted()}>
          {t("states.sendStateFixtureExhausted")}
        </ActionButton>
        <ActionButton onClick={() => void runSessionRevoked()}>
          {t("states.sendStateFixtureRevokedSession")}
        </ActionButton>
        <ActionButton onClick={() => void runDeviceRevoked()}>
          {t("states.sendStateFixtureRevokedDevice")}
        </ActionButton>
        <ActionButton onClick={() => void runStorageUnavailable()}>
          {t("states.sendStateFixtureStorageUnavailable")}
        </ActionButton>
        <ActionButton variant="ghost" onClick={() => void resetAll()}>
          {t("states.sendStateFixtureReset")}
        </ActionButton>
      </div>

      <SendStateList
        snapshot={snapshot}
        nowMs={displayNowMs}
        onAction={(id, kind) => void handleItemAction(id, kind)}
      />
    </section>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  SOCKET_SUBSCRIBE_EVENT,
  SOCKET_UNSUBSCRIBE_EVENT,
  decodeHistoryAfterReference,
  successEnvelope,
  type HistoryMessageItem,
  type HistoryPageResponse,
} from "@chat/contracts";
import { OlmAccountDevice } from "@chat/crypto";

import { ActionButton } from "@/components/ui/action-button";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import surface from "@/components/ui/surface.module.css";
import {
  HistoryApiError,
  type HistoryFetchPageInput,
  type HistoryPageFetcher,
} from "@/src/features/chat/history";
import { useI18n } from "@/src/i18n/provider";
import {
  RealtimeClient,
  type RealtimeClientSnapshot,
  type RealtimeSocketTransport,
} from "@/src/lib/realtime";

import styles from "./history-panel.module.css";
import { ReceivedMessageFeed } from "./message-feed";
import { RealtimeSyncBanner } from "./realtime-sync-banner";

const FIXTURE_CONV_ID = "conv_p208_fixture_01";
const FIXTURE_ALICE_ID = "usr_p208_alice_01";
const FIXTURE_BOB_ID = "usr_p208_bob_02";
const FIXTURE_ORIGIN = "https://api.example.test";

interface LoopbackTransportController extends RealtimeSocketTransport {
  simulateDrop(): void;
  simulateLiveEvent(eventName: string, payload: unknown): void;
  simulateSessionExpired(): void;
}

interface ReconnectFixtureBackend {
  alice: OlmAccountDevice;
  bob: OlmAccountDevice;
  bobFirstPreKey: string;
  records: HistoryMessageItem[];
  nextSeq: number;
  revoked: boolean;
  racePendingOnCatchUp: boolean;
  activeTransport: LoopbackTransportController | null;
  client: RealtimeClient;
  unsubscribe: () => void;
}

function makeWireMessage(
  seq: number,
  senderDeviceId: string,
  encryptedEnvelope: string,
): HistoryMessageItem {
  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    messageId: `msg_p208_seq_${seq}`,
    conversationId: FIXTURE_CONV_ID,
    seq,
    senderUserId: FIXTURE_ALICE_ID,
    senderDeviceId,
    clientMessageId: globalThis.crypto.randomUUID(),
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    encryptedEnvelope,
    committedAt: new Date(Date.UTC(2026, 10, 19, 13, 0, seq)).toISOString(),
  };
}

const INITIAL_SNAPSHOT: RealtimeClientSnapshot = {
  connectionStatus: "disconnected",
  reconnectAttempt: 0,
  nextRetryDelayMs: null,
  activeConversationId: FIXTURE_CONV_ID,
  subscribedConversationId: null,
  protectedActionsBlocked: false,
  reauthReason: null,
  lastError: null,
  sync: {
    accountId: FIXTURE_BOB_ID,
    conversationId: FIXTURE_CONV_ID,
    phase: "idle",
    lastAppliedSeq: 0,
    bufferedCount: 0,
    items: [],
    lastError: null,
    catchUpRuns: 0,
    gapRecoveries: 0,
  },
};

function createLoopbackTransport(backendRef: {
  current: ReconnectFixtureBackend | null;
}): LoopbackTransportController {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let isConnected = false;

  const emitLocal = (event: string, ...args: unknown[]) => {
    const handlers = listeners.get(event);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      handler(...args);
    }
  };

  const controller: LoopbackTransportController = {
    get connected() {
      return isConnected;
    },
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    emit(event, payload, ack) {
      const current = backendRef.current;
      if (event === SOCKET_SUBSCRIBE_EVENT) {
        if (!current || current.revoked) {
          ack?.({
            ok: false,
            error: { code: "SESSION_REVOKED", message: "Session revoked", retryable: false },
          });
          emitLocal("session:expired", { ok: false, error: { code: "SESSION_REVOKED" } });
          return;
        }
        const convId =
          typeof (payload as { conversationId?: unknown } | null)?.conversationId === "string"
            ? (payload as { conversationId: string }).conversationId
            : FIXTURE_CONV_ID;
        ack?.({ ok: true, data: { conversationId: convId, subscribed: true } });
        return;
      }
      if (event === SOCKET_UNSUBSCRIBE_EVENT || event === "auth:refresh") {
        ack?.({ ok: true, data: { ok: true } });
      }
    },
    connect() {
      queueMicrotask(() => {
        const current = backendRef.current;
        if (!current) return;
        if (current.revoked) {
          emitLocal("connect_error", new Error("SESSION_REVOKED"));
          return;
        }
        isConnected = true;
        emitLocal("connect");
      });
    },
    disconnect() {
      if (!isConnected) return;
      isConnected = false;
      emitLocal("disconnect", "io client disconnect");
    },
    removeAllListeners() {
      listeners.clear();
    },
    simulateDrop() {
      if (!isConnected) return;
      isConnected = false;
      emitLocal("disconnect", "transport close");
    },
    simulateLiveEvent(eventName, payload) {
      if (!isConnected) return;
      emitLocal(eventName, payload);
    },
    simulateSessionExpired() {
      isConnected = false;
      emitLocal("session:expired", { ok: false, error: { code: "SESSION_REVOKED" } });
      emitLocal("disconnect", "io server disconnect");
    },
  };

  return controller;
}

function waitForClientCondition(
  client: RealtimeClient,
  predicate: (snap: RealtimeClientSnapshot) => boolean,
  timeoutMs = 5_000,
): Promise<RealtimeClientSnapshot> {
  const initial = client.getSnapshot();
  if (predicate(initial)) return Promise.resolve(initial);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error("Timed out waiting for realtime client state."));
    }, timeoutMs);
    const unsub = client.subscribe((snap) => {
      if (predicate(snap)) {
        clearTimeout(timer);
        unsub();
        resolve(snap);
      }
    });
  });
}

/**
 * Interactive real-WASM reconnect catch-up & expired-session fixture on `/states`
 * (`P2-08`, `TC-HIST-002`, `FR-AUTH-007`, `DATA-013`). Zero network traffic and
 * zero `localStorage` plaintext persistence.
 */
export function ReconnectCatchUpFixtureShowcase() {
  const { t } = useI18n();
  const backendRef = useRef<ReconnectFixtureBackend | null>(null);
  const [snapshot, setSnapshot] = useState<RealtimeClientSnapshot>(INITIAL_SNAPSHOT);
  const [busy, setBusy] = useState(false);

  const teardownBackend = useCallback(() => {
    const prev = backendRef.current;
    if (!prev) return;
    backendRef.current = null;
    prev.unsubscribe();
    prev.client.dispose();
    prev.alice.dispose();
    prev.bob.dispose();
  }, []);

  useEffect(() => {
    return () => {
      teardownBackend();
    };
  }, [teardownBackend]);

  const encryptAndAppend = useCallback(
    async (
      backend: ReconnectFixtureBackend,
      text: string,
      overrideSeq?: number,
    ): Promise<HistoryMessageItem> => {
      const seq = overrideSeq ?? backend.nextSeq + 1;
      const encrypted = await backend.alice.encryptForPeer(
        {
          peerUserId: FIXTURE_BOB_ID,
          peerDeviceId: backend.bob.deviceId,
          peerIdentityKey: backend.bob.identityKey,
          peerSenderKey: backend.bob.senderKey,
          peerOneTimeOrFallbackKey: backend.bobFirstPreKey,
        },
        text,
      );
      if (!encrypted.ok) {
        throw new Error(`Fixture Olm encrypt failed: ${encrypted.code}`);
      }
      backend.nextSeq = Math.max(backend.nextSeq, seq);
      const item = makeWireMessage(seq, backend.alice.deviceId, encrypted.value.encryptedEnvelope);
      backend.records.push(item);
      return item;
    },
    [],
  );

  const createInitializedBackend = useCallback(async (): Promise<ReconnectFixtureBackend> => {
    teardownBackend();

    const [alice, bob] = await Promise.all([
      OlmAccountDevice.create({ deviceId: "dev_p208_alice_01" }),
      OlmAccountDevice.create({ deviceId: "dev_p208_bob_02" }),
    ]);
    const bobBundle = bob.toPublicKeyBundle();
    const bobFirstPreKey = bobBundle.oneTimeKeys[0]?.key ?? bobBundle.fallbackKey.key;

    const historyFetcher: HistoryPageFetcher = {
      async fetchPage(input: HistoryFetchPageInput): Promise<HistoryPageResponse> {
        const current = backendRef.current;
        if (!current) {
          throw new HistoryApiError(500, "INTERNAL_ERROR", false);
        }
        if (current.revoked) {
          throw new HistoryApiError(401, "SESSION_REVOKED", false);
        }

        // Simulate a concurrent live delivery right BETWEEN subscribe ack and HTTP catch-up response!
        if (current.racePendingOnCatchUp) {
          current.racePendingOnCatchUp = false;
          const seq5 = await encryptAndAppend(
            current,
            "Fifth message arrived between subscribe & catch-up",
          );
          current.activeTransport?.simulateLiveEvent("message:new", successEnvelope(seq5));
        }

        let afterSeq = 0;
        if (input.after !== undefined) {
          const decoded = decodeHistoryAfterReference(input.after, input.conversationId);
          if (!decoded.ok || !decoded.value) {
            throw new HistoryApiError(400, "INVALID_CURSOR", false);
          }
          afterSeq = decoded.value.seq;
        }
        const filtered = [...current.records]
          .filter((item) => item.seq > afterSeq)
          .sort((a, b) => a.seq - b.seq);
        return {
          items: filtered,
          nextCursor: null,
          hasMore: false,
          latestSeq: current.nextSeq,
        };
      },
    };

    const client = new RealtimeClient({
      apiOrigin: FIXTURE_ORIGIN,
      accountId: FIXTURE_BOB_ID,
      conversationId: FIXTURE_CONV_ID,
      device: bob,
      tokenProvider: () => (backendRef.current?.revoked ? null : "tok_p208_fixture"),
      historyClient: historyFetcher,
      backoffOptions: { scheduleMs: [40, 80, 160], jitterRatio: 0 },
      socketFactory: () => {
        const transport = createLoopbackTransport(backendRef);
        if (backendRef.current) {
          backendRef.current.activeTransport = transport;
        }
        return transport;
      },
    });

    const unsubscribe = client.subscribe((next) => {
      setSnapshot(next);
    });

    const backend: ReconnectFixtureBackend = {
      alice,
      bob,
      bobFirstPreKey,
      records: [],
      nextSeq: 0,
      revoked: false,
      racePendingOnCatchUp: false,
      activeTransport: null,
      client,
      unsubscribe,
    };
    backendRef.current = backend;

    await encryptAndAppend(backend, "First message — baseline live sync before disconnect");
    await encryptAndAppend(backend, "দ্বিতীয় বার্তা — যুক্তাক্ষর: ক্ষ, জ্ঞ");

    await client.connect();
    await waitForClientCondition(
      client,
      (snap) => snap.connectionStatus === "connected" && snap.sync.lastAppliedSeq >= 2,
    );
    return backend;
  }, [encryptAndAppend, teardownBackend]);

  const runDisconnectAndRace = useCallback(async () => {
    setBusy(true);
    try {
      const backend = await createInitializedBackend();
      backend.activeTransport?.simulateDrop();

      await encryptAndAppend(backend, "Third offline message 🇧🇩💬");
      await encryptAndAppend(
        backend,
        `<script>window.__p208XssFired = true;</script><img src=x onerror="window.__p208XssFired = true" />`,
      );
      backend.racePendingOnCatchUp = true;

      await waitForClientCondition(
        backend.client,
        (snap) => snap.connectionStatus === "connected" && snap.sync.lastAppliedSeq >= 5,
      );
      setSnapshot(backend.client.getSnapshot());
    } finally {
      setBusy(false);
    }
  }, [createInitializedBackend, encryptAndAppend]);

  const runGapRecovery = useCallback(async () => {
    setBusy(true);
    try {
      let backend = backendRef.current;
      if (
        !backend ||
        backend.revoked ||
        backend.client.getSnapshot().connectionStatus !== "connected" ||
        backend.nextSeq < 5
      ) {
        backend = await createInitializedBackend();
        await encryptAndAppend(backend, "Third offline message 🇧🇩💬");
        await encryptAndAppend(
          backend,
          `<script>window.__p208XssFired = true;</script><img src=x onerror="window.__p208XssFired = true" />`,
        );
        await encryptAndAppend(backend, "Fifth message arrived between subscribe & catch-up");
        await backend.client.triggerCatchUp();
      }

      // Skip seq 6 (permanent gap) and commit seq 7 (dropped live event) + seq 8 (delivered live).
      backend.nextSeq = Math.max(backend.nextSeq, 6);
      await encryptAndAppend(backend, "Recovered missed seq 7 across permanent gap 6", 7);
      const seq8 = await encryptAndAppend(backend, "Out-of-order seq 8 triggers gap catch-up", 8);
      backend.activeTransport?.simulateLiveEvent("message:new", successEnvelope(seq8));

      await waitForClientCondition(
        backend.client,
        (snap) => snap.sync.lastAppliedSeq >= 8 && snap.sync.gapRecoveries >= 1,
      );
      setSnapshot(backend.client.getSnapshot());
    } finally {
      setBusy(false);
    }
  }, [createInitializedBackend, encryptAndAppend]);

  const runRevokeSession = useCallback(async () => {
    setBusy(true);
    try {
      let backend = backendRef.current;
      if (!backend || backend.client.getSnapshot().connectionStatus === "reauth_required") {
        backend = await createInitializedBackend();
      }
      backend.revoked = true;
      backend.activeTransport?.simulateSessionExpired();
      await waitForClientCondition(
        backend.client,
        (snap) => snap.connectionStatus === "reauth_required",
      );
      setSnapshot(backend.client.getSnapshot());
    } finally {
      setBusy(false);
    }
  }, [createInitializedBackend]);

  const handleReset = useCallback(() => {
    teardownBackend();
    setSnapshot(INITIAL_SNAPSHOT);
  }, [teardownBackend]);

  const handleManualRetry = useCallback(() => {
    const current = backendRef.current;
    if (!current) return;
    setBusy(true);
    void current.client.connect().finally(() => {
      if (backendRef.current) {
        setSnapshot(backendRef.current.client.getSnapshot());
      }
      setBusy(false);
    });
  }, []);

  return (
    <section
      className={`${surface.card} ${styles.showcaseCard}`}
      aria-labelledby="reconnect-fixture-showcase-title"
      data-testid="reconnect-fixture-showcase"
    >
      <div className={styles.wrapper}>
        <div>
          <h2 className={surface.cardTitle} id="reconnect-fixture-showcase-title">
            {t("states.reconnectTitle")}
          </h2>
          <p className={surface.cardDescription}>{t("states.reconnectDescription")}</p>
        </div>

        <PlaceholderNotice title={t("states.reconnectNoticeTitle")}>
          <p>{t("states.reconnectNoticeBody")}</p>
        </PlaceholderNotice>

        <div className={styles.toolbar}>
          <ActionButton
            variant="primary"
            disabled={busy}
            onClick={() => void runDisconnectAndRace()}
          >
            {t("states.reconnectBtnRace")}
          </ActionButton>
          <ActionButton variant="secondary" disabled={busy} onClick={() => void runGapRecovery()}>
            {t("states.reconnectBtnGap")}
          </ActionButton>
          <ActionButton variant="secondary" disabled={busy} onClick={() => void runRevokeSession()}>
            {t("states.reconnectBtnRevoke")}
          </ActionButton>
          <ActionButton variant="secondary" disabled={busy} onClick={handleReset}>
            {t("states.reconnectBtnReset")}
          </ActionButton>
        </div>

        <RealtimeSyncBanner snapshot={snapshot} onRetrySync={handleManualRetry} />

        <p className={styles.statusMeta} data-testid="reconnect-fixture-status">
          {t("states.reconnectStatusSummary", {
            status: snapshot.connectionStatus,
            phase: snapshot.sync.phase,
            seq: snapshot.sync.lastAppliedSeq,
            blocked: String(snapshot.protectedActionsBlocked),
          })}
        </p>

        <ReceivedMessageFeed
          items={snapshot.sync.items}
          ariaLabel={t("history.listLabel")}
          emptyMessage={t("history.emptyTitle")}
        />
      </div>
    </section>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  decodeHistoryAfterReference,
  type HistoryMessageItem,
  type HistoryPageResponse,
} from "@chat/contracts";
import { OlmAccountDevice, type SealedOlmStateBundle } from "@chat/crypto";

import { ActionButton } from "@/components/ui/action-button";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import surface from "@/components/ui/surface.module.css";
import type { ReceivedTimelineMessage } from "@/src/features/chat/receive";
import { HistoryApiError, type HistoryFetchPageInput } from "@/src/features/chat/history";
import { useI18n } from "@/src/i18n/provider";
import type { MessageKey } from "@/src/i18n/catalog";
import { ConversationCatchUpSynchronizer } from "@/src/lib/realtime";

import styles from "./history-panel.module.css";
import { ReceivedMessageFeed } from "./message-feed";

const CONV_ID = "conv_p210_offline_01";
const ALICE_ID = "usr_p210_alice_01";
const BOB_ID = "usr_p210_bob_02";
const OFFLINE_DAYS_SIMULATED = 35;

type DeliveryStage = "sent" | "delivered" | "read";

interface SenderDeliveryLedgerRow {
  messageId: string;
  seq: number;
  stage: DeliveryStage;
}

interface OfflineDeliveryBackend {
  alice: OlmAccountDevice;
  bobSealed: SealedOlmStateBundle;
  bobStorageKey: CryptoKey;
  bobUnsealed: OlmAccountDevice | null;
  retainedRecords: HistoryMessageItem[];
  senderLedger: Map<string, SenderDeliveryLedgerRow>;
  synchronizer: ConversationCatchUpSynchronizer;
  unsubscribe: () => void;
}

function stageLabelKey(stage: DeliveryStage): MessageKey {
  if (stage === "read") return "states.offlineDeliveryStageRead";
  if (stage === "delivered") return "states.offlineDeliveryStageDelivered";
  return "states.offlineDeliveryStageSent";
}

function createLedgerView(map: Map<string, SenderDeliveryLedgerRow>): SenderDeliveryLedgerRow[] {
  return [...map.values()].sort((a, b) => a.seq - b.seq).map((row) => ({ ...row }));
}

function createOfflineRecord(
  seq: number,
  senderDeviceId: string,
  encryptedEnvelope: string,
  clientMessageId: string,
): HistoryMessageItem {
  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    messageId: `msg_p210_seq_${seq}`,
    conversationId: CONV_ID,
    seq,
    senderUserId: ALICE_ID,
    senderDeviceId,
    clientMessageId,
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    encryptedEnvelope,
    committedAt: new Date(Date.UTC(2026, 10, 20, 8, 0, seq)).toISOString(),
  };
}

/**
 * Interactive real-WASM offline recipient delivery showcase on `/states`
 * (`P2-10`, `TC-CHAT-004`, `FR-CHAT-006`, `DEC-015`, `DEC-020`, `DEC-021`).
 */
export function OfflineDeliveryFixtureShowcase() {
  const { t } = useI18n();
  const backendRef = useRef<OfflineDeliveryBackend | null>(null);
  const readSharingRef = useRef(false);

  const [busy, setBusy] = useState(false);
  const [recipientState, setRecipientState] = useState("idle");
  const [offlineDays, setOfflineDays] = useState(0);
  const [readSharingEnabled, setReadSharingEnabled] = useState(false);
  const [retainedCount, setRetainedCount] = useState(0);
  const [senderLedger, setSenderLedger] = useState<SenderDeliveryLedgerRow[]>([]);
  const [items, setItems] = useState<readonly ReceivedTimelineMessage[]>([]);

  const syncLedgerState = useCallback((backend: OfflineDeliveryBackend) => {
    setRetainedCount(backend.retainedRecords.length);
    setSenderLedger(createLedgerView(backend.senderLedger));
  }, []);

  const teardownBackend = useCallback(() => {
    const prev = backendRef.current;
    if (!prev) return;
    backendRef.current = null;
    prev.unsubscribe();
    prev.synchronizer.dispose();
    prev.alice.dispose();
    prev.bobUnsealed?.dispose();
  }, []);

  useEffect(() => {
    return () => {
      teardownBackend();
    };
  }, [teardownBackend]);

  const handleSendOffline = useCallback(async () => {
    setBusy(true);
    try {
      teardownBackend();

      const [alice, bob] = await Promise.all([
        OlmAccountDevice.create({ deviceId: "dev_p210_alice_01" }),
        OlmAccountDevice.create({ deviceId: "dev_p210_bob_02" }),
      ]);
      const bobBundle = bob.toPublicKeyBundle();
      const bobStorageKey = bob.storageKey;
      const bobFirstPreKey = bobBundle.oneTimeKeys[0]?.key ?? bobBundle.fallbackKey.key;
      const bobSealed = await bob.sealState();
      // Simulate Bob completely offline with private keys sealed away from RAM.
      bob.dispose();

      const senderLedger = new Map<string, SenderDeliveryLedgerRow>();
      const retainedRecords: HistoryMessageItem[] = [];

      const plaintexts = [
        "Offline retained message 1 — durable sent while recipient disconnected",
        "অফলাইন বার্তা ২ — যুক্তাক্ষর: ক্ষ, জ্ঞ 🇧🇩",
        `<script>window.__p210XssFired = true;</script><img src=x onerror="window.__p210XssFired = true" />`,
      ];

      for (let i = 0; i < plaintexts.length; i += 1) {
        const seq = i + 1;
        const clientMessageId = globalThis.crypto.randomUUID();
        const encrypted = await alice.encryptForPeer(
          {
            peerUserId: BOB_ID,
            peerDeviceId: bobBundle.deviceId,
            peerIdentityKey: bobBundle.identityKey,
            peerSenderKey: bobBundle.senderKey,
            peerOneTimeOrFallbackKey: bobFirstPreKey,
          },
          plaintexts[i]!,
        );
        if (!encrypted.ok) {
          throw new Error(`Fixture encrypt failed: ${encrypted.code}`);
        }
        const record = createOfflineRecord(
          seq,
          alice.deviceId,
          encrypted.value.encryptedEnvelope,
          clientMessageId,
        );
        retainedRecords.push(record);
        senderLedger.set(record.messageId, {
          messageId: record.messageId,
          seq: record.seq,
          stage: "sent",
        });
      }

      const synchronizer = new ConversationCatchUpSynchronizer({
        accountId: BOB_ID,
        conversationId: CONV_ID,
        device: null,
        historyClient: {
          async fetchPage(input: HistoryFetchPageInput): Promise<HistoryPageResponse> {
            const current = backendRef.current;
            if (!current) {
              throw new HistoryApiError(500, "INTERNAL_ERROR", false);
            }
            let afterSeq = 0;
            if (input.after !== undefined) {
              const decoded = decodeHistoryAfterReference(input.after, input.conversationId);
              if (!decoded.ok || !decoded.value) {
                throw new HistoryApiError(400, "INVALID_CURSOR", false);
              }
              afterSeq = decoded.value.seq;
            }
            const filtered = current.retainedRecords
              .filter((r) => r.seq > afterSeq)
              .sort((a, b) => a.seq - b.seq);
            return {
              items: filtered,
              nextCursor: null,
              hasMore: false,
              latestSeq: current.retainedRecords[current.retainedRecords.length - 1]?.seq ?? 0,
            };
          },
        },
        onDeliveryEvidence: (evidenceList) => {
          const current = backendRef.current;
          if (!current) return;
          for (const ev of evidenceList) {
            const row = current.senderLedger.get(ev.messageId);
            if (row && row.stage === "sent") {
              row.stage = "delivered";
            }
          }
          syncLedgerState(current);
        },
      });

      const unsubscribe = synchronizer.subscribe((snap) => {
        setItems(snap.items);
      });

      const backend: OfflineDeliveryBackend = {
        alice,
        bobSealed,
        bobStorageKey,
        bobUnsealed: null,
        retainedRecords,
        senderLedger,
        synchronizer,
        unsubscribe,
      };
      backendRef.current = backend;

      setOfflineDays(OFFLINE_DAYS_SIMULATED);
      setRecipientState("offline");
      setItems([]);
      syncLedgerState(backend);
    } finally {
      setBusy(false);
    }
  }, [syncLedgerState, teardownBackend]);

  const handleSyncMissingKey = useCallback(async () => {
    const current = backendRef.current;
    if (!current) return;
    setBusy(true);
    try {
      current.synchronizer.setDevice(null);
      await current.synchronizer.runCatchUp();
      setRecipientState("key_locked");
      setItems(current.synchronizer.getItems());
      syncLedgerState(current);
    } finally {
      setBusy(false);
    }
  }, [syncLedgerState]);

  const handleUnsealAndDeliver = useCallback(async () => {
    const current = backendRef.current;
    if (!current) return;
    setBusy(true);
    try {
      if (!current.bobUnsealed) {
        const unsealed = await OlmAccountDevice.unsealState(
          current.bobSealed,
          current.bobStorageKey,
        );
        if (!unsealed.ok) {
          throw new Error(`Failed to unseal Bob device: ${unsealed.code}`);
        }
        current.bobUnsealed = unsealed.value;
      }

      current.synchronizer.setDevice(current.bobUnsealed);
      if (current.synchronizer.getItems().length === 0) {
        await current.synchronizer.runCatchUp();
      } else {
        await current.synchronizer.retryRecoverableMessages();
      }
      setRecipientState("delivered");
      setItems(current.synchronizer.getItems());
      syncLedgerState(current);
    } finally {
      setBusy(false);
    }
  }, [syncLedgerState]);

  const handleToggleReadSharing = useCallback(() => {
    readSharingRef.current = !readSharingRef.current;
    setReadSharingEnabled(readSharingRef.current);
  }, []);

  const handleFocusedRead = useCallback(() => {
    const current = backendRef.current;
    if (!current || !readSharingRef.current) {
      return;
    }
    const currentItems = current.synchronizer.getItems();
    for (const item of currentItems) {
      if (item.kind === "decrypted" && item.canEmitReadReceipt) {
        const row = current.senderLedger.get(item.messageId);
        if (row && (row.stage === "delivered" || row.stage === "read")) {
          row.stage = "read";
        }
      }
    }
    if (currentItems.some((i) => i.kind === "decrypted")) {
      setRecipientState("read");
    }
    syncLedgerState(current);
  }, [syncLedgerState]);

  const handleReset = useCallback(() => {
    teardownBackend();
    readSharingRef.current = false;
    setReadSharingEnabled(false);
    setRecipientState("idle");
    setOfflineDays(0);
    setRetainedCount(0);
    setSenderLedger([]);
    setItems([]);
  }, [teardownBackend]);

  const sentCount = senderLedger.length;
  const deliveredCount = senderLedger.filter(
    (row) => row.stage === "delivered" || row.stage === "read",
  ).length;
  const readCount = senderLedger.filter((row) => row.stage === "read").length;

  return (
    <section
      className={`${surface.card} ${styles.showcaseCard}`}
      aria-labelledby="offline-delivery-fixture-title"
      data-testid="offline-delivery-fixture-showcase"
    >
      <div className={styles.wrapper}>
        <div>
          <h2 className={surface.cardTitle} id="offline-delivery-fixture-title">
            {t("states.offlineDeliveryTitle")}
          </h2>
          <p className={surface.cardDescription}>{t("states.offlineDeliveryDescription")}</p>
        </div>

        <PlaceholderNotice title={t("states.offlineDeliveryNoticeTitle")}>
          <p>{t("states.offlineDeliveryNoticeBody")}</p>
        </PlaceholderNotice>

        <div className={styles.toolbar}>
          <ActionButton variant="primary" disabled={busy} onClick={() => void handleSendOffline()}>
            {t("states.offlineDeliveryBtnSendOffline")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            disabled={busy || retainedCount === 0}
            onClick={() => void handleSyncMissingKey()}
          >
            {t("states.offlineDeliveryBtnSyncMissingKey")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            disabled={busy || retainedCount === 0}
            onClick={() => void handleUnsealAndDeliver()}
          >
            {t("states.offlineDeliveryBtnUnsealAndDeliver")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            disabled={busy || items.length === 0}
            onClick={handleFocusedRead}
          >
            {t("states.offlineDeliveryBtnFocusedRead")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            disabled={busy}
            aria-pressed={readSharingEnabled}
            onClick={handleToggleReadSharing}
          >
            {t("states.offlineDeliveryBtnToggleReadSharing")}
          </ActionButton>
          <ActionButton variant="secondary" disabled={busy} onClick={handleReset}>
            {t("states.offlineDeliveryBtnReset")}
          </ActionButton>
        </div>

        <p className={styles.statusMeta} data-testid="offline-delivery-read-sharing">
          {t(
            readSharingEnabled
              ? "states.offlineDeliveryReadSharingOn"
              : "states.offlineDeliveryReadSharingOff",
          )}
        </p>

        <p
          className={styles.statusMeta}
          data-testid="offline-delivery-fixture-status"
          data-recipient-state={recipientState}
          data-retained-count={String(retainedCount)}
          data-sent-count={String(sentCount)}
          data-delivered-count={String(deliveredCount)}
          data-read-count={String(readCount)}
        >
          {t("states.offlineDeliveryStatusSummary", {
            recipientState,
            days: offlineDays,
            retained: retainedCount,
            sentCount,
            deliveredCount,
            readCount,
          })}
        </p>

        {senderLedger.length > 0 ? (
          <div className={styles.inlineBanner} data-testid="offline-delivery-sender-ledger">
            <h3 className={styles.bannerTitle}>{t("states.offlineDeliverySenderLedgerTitle")}</h3>
            <ol className={styles.wrapper} style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {senderLedger.map((row) => (
                <li
                  key={row.messageId}
                  className={styles.historyBar}
                  data-testid={`offline-sender-item-${row.messageId}`}
                  data-delivery-stage={row.stage}
                >
                  <p className={styles.beginningText}>
                    {t("states.offlineDeliverySenderItemMeta", {
                      seq: row.seq,
                      stage: t(stageLabelKey(row.stage)),
                    })}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        <ReceivedMessageFeed
          items={items}
          ariaLabel={t("receiveMessage.listLabel")}
          emptyMessage={t("history.emptyTitle")}
        />
      </div>
    </section>
  );
}

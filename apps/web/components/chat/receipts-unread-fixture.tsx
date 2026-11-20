"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  READ_RECEIPT_FOCUS_DEBOUNCE_MS,
  RECEIPT_SCHEMA_VERSION,
  type MessageReceiptView,
  type ReceiptStage,
} from "@chat/contracts";
import { OlmAccountDevice, decryptReceivedEnvelope } from "@chat/crypto";

import { ActionButton } from "@/components/ui/action-button";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import surface from "@/components/ui/surface.module.css";
import { ReceiptsAndUnreadController } from "@/src/features/chat/receipts";
import type { ReceivedTimelineMessage } from "@/src/features/chat/receive";
import { useI18n } from "@/src/i18n/provider";
import type { MessageKey } from "@/src/i18n/catalog";

import styles from "./history-panel.module.css";
import { ReceivedMessageFeed } from "./message-feed";

const CONV_ID = "conv_p211_receipts_01";
const ALICE_ID = "usr_p211_alice_01";
const BOB_ID = "usr_p211_bob_02";
const BOB_DEVICE_ID = "dev_p211_bob_02";

interface StoredWireMessage {
  messageId: string;
  seq: number;
  senderUserId: string;
  senderDeviceId: string;
  encryptedEnvelope: string;
  committedAt: string;
  decryptable: boolean;
}

interface FixtureLedgerRow {
  messageId: string;
  seq: number;
  kind: "decrypted" | "undecryptable" | "unconfirmed";
  stage: ReceiptStage;
  deliveredAt: string | null;
  readAt: string | null;
}

interface ReceiptsBackend {
  alice: OlmAccountDevice;
  bob: OlmAccountDevice;
  controller: ReceiptsAndUnreadController;
  messages: StoredWireMessage[];
  timeline: ReceivedTimelineMessage[];
  senderLedger: Map<string, MessageReceiptView>;
  unsubscribe: () => void;
}

function stageKey(stage: ReceiptStage): MessageKey {
  if (stage === "read") return "states.receiptsUnreadStageRead";
  if (stage === "delivered") return "states.receiptsUnreadStageDelivered";
  return "states.receiptsUnreadStageSent";
}

function kindKey(kind: FixtureLedgerRow["kind"]): MessageKey {
  if (kind === "decrypted") return "states.receiptsUnreadKindDecrypted";
  if (kind === "undecryptable") return "states.receiptsUnreadKindUndecryptable";
  return "states.receiptsUnreadKindMissing";
}

/**
 * Interactive real-WASM receipts, opt-in/reciprocal read sharing, 500 ms
 * focus debounce, monotonic merge & private unread count fixture on `/states`
 * (`P2-11`, `FR-CHAT-009..011`, `FR-HIST-004`, `DEC-008`, `DEC-020`).
 */
export function ReceiptsUnreadFixtureShowcase() {
  const { t } = useI18n();
  const backendRef = useRef<ReceiptsBackend | null>(null);
  const bobReadSharingRef = useRef(false);
  const aliceReadSharingRef = useRef(false);
  const blockedRef = useRef(false);

  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("idle");
  const [focused, setFocused] = useState(false);
  const [bobReadSharing, setBobReadSharing] = useState(false);
  const [aliceReadSharing, setAliceReadSharing] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [readThroughSeq, setReadThroughSeq] = useState(0);
  const [latestSeq, setLatestSeq] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [regressedBlocked, setRegressedBlocked] = useState(0);
  const [ledgerRows, setLedgerRows] = useState<FixtureLedgerRow[]>([]);
  const [items, setItems] = useState<readonly ReceivedTimelineMessage[]>([]);

  const refreshView = useCallback((backend: ReceiptsBackend) => {
    const snap = backend.controller.getSnapshot();
    setFocused(snap.focused);
    setReadThroughSeq(snap.readThroughSeq);
    setLatestSeq(snap.latestSeq);
    setUnreadCount(snap.unreadCount);

    const kindByMessage = new Map<string, FixtureLedgerRow["kind"]>();
    for (const item of backend.timeline) {
      kindByMessage.set(item.messageId, item.kind === "decrypted" ? "decrypted" : "undecryptable");
    }

    const rows: FixtureLedgerRow[] = backend.messages.map((msg) => {
      const receipt = snap.senderReceipts.get(msg.messageId);
      return {
        messageId: msg.messageId,
        seq: msg.seq,
        kind: kindByMessage.get(msg.messageId) ?? "unconfirmed",
        stage: receipt?.stage ?? "sent",
        deliveredAt: receipt?.deliveredAt ?? null,
        readAt: receipt?.readAt ?? null,
      };
    });
    setLedgerRows(rows);
    setItems([...backend.timeline]);
  }, []);

  const teardownBackend = useCallback(() => {
    const prev = backendRef.current;
    if (!prev) return;
    backendRef.current = null;
    prev.unsubscribe();
    prev.controller.dispose();
    prev.alice.dispose();
    prev.bob.dispose();
  }, []);

  useEffect(() => {
    return () => {
      teardownBackend();
    };
  }, [teardownBackend]);

  const handleSeed = useCallback(async () => {
    setBusy(true);
    try {
      teardownBackend();

      const [alice, bob] = await Promise.all([
        OlmAccountDevice.create({ deviceId: "dev_p211_alice_01" }),
        OlmAccountDevice.create({ deviceId: BOB_DEVICE_ID }),
      ]);
      const bobBundle = bob.toPublicKeyBundle();
      const firstPreKey = bobBundle.oneTimeKeys[0]?.key ?? bobBundle.fallbackKey.key;

      const messages: StoredWireMessage[] = [];
      const plaintexts = [
        "Receipts check 1 — live delivery requires endpoint decryption",
        "গোপনীয় বার্তা ২ — যুক্তাক্ষর: ক্ষ, জ্ঞ 🇧🇩",
        `<script>window.__p211XssFired = true;</script>Safe sanitized render 3`,
      ];

      // Seq 1..3 decryptable messages; seq 4 omitted (permanent gap DEC-015);
      // seq 5 intentionally undecryptable ciphertext (must never emit receipts!).
      const seqs = [1, 2, 3];
      for (let i = 0; i < plaintexts.length; i += 1) {
        const seq = seqs[i]!;
        const encrypted = await alice.encryptForPeer(
          {
            peerUserId: BOB_ID,
            peerDeviceId: bobBundle.deviceId,
            peerIdentityKey: bobBundle.identityKey,
            peerSenderKey: bobBundle.senderKey,
            peerOneTimeOrFallbackKey: firstPreKey,
          },
          plaintexts[i]!,
        );
        if (!encrypted.ok) {
          throw new Error(`Fixture encrypt failed: ${encrypted.code}`);
        }
        messages.push({
          messageId: `msg_p211_seq_${seq}`,
          seq,
          senderUserId: ALICE_ID,
          senderDeviceId: alice.deviceId,
          encryptedEnvelope: encrypted.value.encryptedEnvelope,
          committedAt: new Date(Date.UTC(2026, 10, 20, 9, 0, seq)).toISOString(),
          decryptable: true,
        });
      }

      messages.push({
        messageId: "msg_p211_seq_5",
        seq: 5,
        senderUserId: ALICE_ID,
        senderDeviceId: alice.deviceId,
        encryptedEnvelope: JSON.stringify({
          v: MESSAGE_ALLOWED_PROTOCOL_VERSION,
          recipientDeviceId: BOB_DEVICE_ID,
          olmType: 1,
          body: "corrupted-ciphertext-cannot-decrypt",
        }),
        committedAt: new Date(Date.UTC(2026, 10, 20, 9, 0, 5)).toISOString(),
        decryptable: false,
      });

      const senderLedger = new Map<string, MessageReceiptView>();
      const controller = new ReceiptsAndUnreadController({
        accountId: BOB_ID,
        conversationId: CONV_ID,
        focused: false,
        readReceiptsEnabled: bobReadSharingRef.current,
        blocked: blockedRef.current,
        focusDebounceMs: READ_RECEIPT_FOCUS_DEBOUNCE_MS,
        initialLatestSeq: 5,
        onEmitReceipt: (type, item) => {
          const active = backendRef.current;
          if (!active) return;
          if (blockedRef.current) return;
          if (type === "read" && (!bobReadSharingRef.current || !aliceReadSharingRef.current)) {
            return;
          }
          const nowIso = new Date().toISOString();
          const prev = active.senderLedger.get(item.messageId);
          const nextView: MessageReceiptView = {
            schemaVersion: RECEIPT_SCHEMA_VERSION,
            messageId: item.messageId,
            conversationId: CONV_ID,
            seq: item.seq,
            recipientUserId: BOB_ID,
            recipientDeviceId: BOB_DEVICE_ID,
            stage: type,
            deliveredAt: prev?.deliveredAt ?? nowIso,
            readAt: type === "read" ? (prev?.readAt ?? nowIso) : (prev?.readAt ?? null),
            updatedAt: nowIso,
          };
          active.senderLedger.set(item.messageId, nextView);
          active.controller.applyReceiptView(nextView);
        },
      });

      const backend: ReceiptsBackend = {
        alice,
        bob,
        controller,
        messages,
        timeline: [],
        senderLedger,
        unsubscribe: () => {},
      };
      backend.unsubscribe = controller.subscribe(() => {
        if (backendRef.current === backend) {
          refreshView(backend);
        }
      });

      backendRef.current = backend;
      setRegressedBlocked(0);
      setPhase("seeded_unread");
      refreshView(backend);
    } finally {
      setBusy(false);
    }
  }, [refreshView, teardownBackend]);

  const handleDecrypt = useCallback(async () => {
    const backend = backendRef.current;
    if (!backend) return;
    setBusy(true);
    try {
      const timeline: ReceivedTimelineMessage[] = [];
      for (const msg of backend.messages) {
        const result = await decryptReceivedEnvelope(
          backend.bob,
          {
            schemaVersion: MESSAGE_SCHEMA_VERSION,
            messageId: msg.messageId,
            conversationId: CONV_ID,
            seq: msg.seq,
            senderUserId: msg.senderUserId,
            senderDeviceId: msg.senderDeviceId,
            clientMessageId: `cli_${msg.messageId}`,
            protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
            encryptedEnvelope: msg.encryptedEnvelope,
            committedAt: msg.committedAt,
          },
          { peerUserId: ALICE_ID },
        );
        if (result.ok) {
          timeline.push({
            kind: "decrypted",
            messageId: result.messageId,
            conversationId: result.conversationId,
            seq: result.seq,
            senderUserId: result.senderUserId,
            senderDeviceId: result.senderDeviceId,
            ...(result.clientMessageId !== undefined
              ? { clientMessageId: result.clientMessageId }
              : {}),
            committedAt: result.committedAt,
            protocolVersion: result.protocolVersion,
            plaintext: result.plaintext,
            sessionId: result.sessionId,
            messageIndex: result.messageIndex,
            canEmitDeliveryReceipt: true,
            canEmitReadReceipt: true,
          });
        } else {
          timeline.push({
            kind: "decryption_failed",
            messageId: result.messageId,
            conversationId: result.conversationId,
            seq: result.seq,
            senderUserId: result.senderUserId,
            senderDeviceId: result.senderDeviceId,
            ...(result.clientMessageId !== undefined
              ? { clientMessageId: result.clientMessageId }
              : {}),
            committedAt: result.committedAt,
            protocolVersion: result.protocolVersion,
            failureState: result.failureState,
            code: result.code,
            recoverable: result.recoverable,
            canEmitDeliveryReceipt: false,
            canEmitReadReceipt: false,
          });
        }
      }
      backend.timeline = timeline;
      await backend.controller.syncTimeline(timeline, { latestSeq: 5 });
      setPhase("decrypted_delivered");
      refreshView(backend);
    } finally {
      setBusy(false);
    }
  }, [refreshView]);

  const handleFocusToggle = useCallback(
    (nextFocused: boolean) => {
      const backend = backendRef.current;
      if (!backend) return;
      backend.controller.setFocused(nextFocused);
      setPhase(nextFocused ? "focused_debouncing_500ms" : "blurred");
      refreshView(backend);
    },
    [refreshView],
  );

  const handleToggleBobShare = useCallback(() => {
    const next = !bobReadSharingRef.current;
    bobReadSharingRef.current = next;
    setBobReadSharing(next);
    const backend = backendRef.current;
    if (backend) {
      backend.controller.setReadReceiptsEnabled(next);
      refreshView(backend);
    }
  }, [refreshView]);

  const handleToggleAliceShare = useCallback(() => {
    const next = !aliceReadSharingRef.current;
    aliceReadSharingRef.current = next;
    setAliceReadSharing(next);
    const backend = backendRef.current;
    if (backend && next && bobReadSharingRef.current && backend.controller.getSnapshot().focused) {
      void backend.controller.flushFocusedRead().then(() => {
        if (backendRef.current === backend) {
          refreshView(backend);
        }
      });
    }
  }, [refreshView]);

  const handleReplayStaleAndDuplicate = useCallback(async () => {
    const backend = backendRef.current;
    if (!backend) return;
    setBusy(true);
    try {
      const targetMsg = backend.messages[0];
      let blockedCount = 0;
      if (targetMsg) {
        const before = backend.controller.getSnapshot().senderReceipts.get(targetMsg.messageId);
        const mergedStage = backend.controller.applyReceiptView({
          schemaVersion: RECEIPT_SCHEMA_VERSION,
          messageId: targetMsg.messageId,
          conversationId: CONV_ID,
          seq: targetMsg.seq,
          recipientUserId: BOB_ID,
          recipientDeviceId: BOB_DEVICE_ID,
          stage: "delivered",
          deliveredAt: new Date(Date.UTC(2026, 10, 20, 9, 5, 0)).toISOString(),
          readAt: null,
          updatedAt: new Date(Date.UTC(2026, 10, 20, 9, 5, 0)).toISOString(),
        });
        if (before && mergedStage === before.stage) {
          blockedCount += 1;
        }
      }
      // Replay duplicate timeline items & stale lower readThroughSeq; count must not inflate or regress.
      await backend.controller.syncTimeline(backend.timeline, { latestSeq: 5 });
      backend.controller.applyServerReadProgress({
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        conversationId: CONV_ID,
        userId: BOB_ID,
        readThroughSeq: 1,
        latestSeq: 5,
        unreadCount: 0,
        updatedAt: new Date().toISOString(),
      });
      setRegressedBlocked((prev) => prev + blockedCount);
      setPhase("monotonic_replayed");
      refreshView(backend);
    } finally {
      setBusy(false);
    }
  }, [refreshView]);

  const handleToggleBlock = useCallback(() => {
    const next = !blockedRef.current;
    blockedRef.current = next;
    setBlocked(next);
    const backend = backendRef.current;
    if (backend) {
      backend.controller.setBlocked(next);
      refreshView(backend);
    }
  }, [refreshView]);

  const handleReset = useCallback(() => {
    teardownBackend();
    bobReadSharingRef.current = false;
    aliceReadSharingRef.current = false;
    blockedRef.current = false;
    setBobReadSharing(false);
    setAliceReadSharing(false);
    setBlocked(false);
    setFocused(false);
    setPhase("idle");
    setReadThroughSeq(0);
    setLatestSeq(0);
    setUnreadCount(0);
    setRegressedBlocked(0);
    setLedgerRows([]);
    setItems([]);
  }, [teardownBackend]);

  const hasSeeded = ledgerRows.length > 0;

  return (
    <section
      className={`${surface.card} ${styles.showcaseCard}`}
      aria-label={t("states.receiptsUnreadSectionLabel")}
      data-testid="receipts-unread-fixture"
    >
      <div className={styles.wrapper}>
        <div>
          <h2 className="section-title">{t("states.receiptsUnreadTitle")}</h2>
          <p className={styles.beginningText}>{t("states.receiptsUnreadSubtitle")}</p>
        </div>

        <PlaceholderNotice title={t("states.receiptsUnreadNoticeTitle")}>
          <p>{t("states.receiptsUnreadNoticeBody")}</p>
        </PlaceholderNotice>

        <div className={styles.toolbar}>
          <ActionButton variant="primary" disabled={busy} onClick={() => void handleSeed()}>
            {t("states.receiptsUnreadBtnSeed")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            disabled={busy || !hasSeeded}
            onClick={() => void handleDecrypt()}
          >
            {t("states.receiptsUnreadBtnDecrypt")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            disabled={busy || items.length === 0 || focused}
            onClick={() => handleFocusToggle(true)}
          >
            {t("states.receiptsUnreadBtnFocus")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            disabled={busy || !focused}
            onClick={() => handleFocusToggle(false)}
          >
            {t("states.receiptsUnreadBtnBlur")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            disabled={busy}
            aria-pressed={bobReadSharing}
            onClick={handleToggleBobShare}
          >
            {t("states.receiptsUnreadBtnToggleBobPrefs")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            disabled={busy}
            aria-pressed={aliceReadSharing}
            onClick={handleToggleAliceShare}
          >
            {t("states.receiptsUnreadBtnToggleAlicePrefs")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            disabled={busy || items.length === 0}
            onClick={() => void handleReplayStaleAndDuplicate()}
          >
            {t("states.receiptsUnreadBtnDuplicateReorder")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            disabled={busy}
            aria-pressed={blocked}
            onClick={handleToggleBlock}
          >
            {t("states.receiptsUnreadBtnToggleBlock")}
          </ActionButton>
          <ActionButton variant="secondary" disabled={busy} onClick={handleReset}>
            {t("states.receiptsUnreadBtnReset")}
          </ActionButton>
        </div>

        <p
          className={styles.statusMeta}
          data-testid="receipts-unread-status"
          data-phase={phase}
          data-focused={String(focused)}
          data-bob-share={String(bobReadSharing)}
          data-alice-share={String(aliceReadSharing)}
          data-blocked={String(blocked)}
          data-read-through-seq={String(readThroughSeq)}
          data-latest-seq={String(latestSeq)}
          data-unread-count={String(unreadCount)}
          data-regressed-blocked={String(regressedBlocked)}
        >
          {t("states.receiptsUnreadStatusSummary", {
            phase,
            focused: t(focused ? "states.receiptsUnreadYes" : "states.receiptsUnreadNo"),
            bobShare: t(
              bobReadSharing ? "states.receiptsUnreadToggleOn" : "states.receiptsUnreadToggleOff",
            ),
            aliceShare: t(
              aliceReadSharing ? "states.receiptsUnreadToggleOn" : "states.receiptsUnreadToggleOff",
            ),
            blocked: t(blocked ? "states.receiptsUnreadYes" : "states.receiptsUnreadNo"),
            readThroughSeq,
            latestSeq,
            unreadCount,
            regressedBlocked,
          })}
        </p>

        {ledgerRows.length > 0 ? (
          <div className={styles.inlineBanner} data-testid="receipts-unread-sender-ledger">
            <h3 className={styles.bannerTitle}>{t("states.receiptsUnreadLedgerTitle")}</h3>
            <ol className={styles.wrapper} style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {ledgerRows.map((row) => (
                <li
                  key={row.messageId}
                  className={styles.historyBar}
                  data-testid={`receipts-sender-row-${row.messageId}`}
                  data-stage={row.stage}
                  data-kind={row.kind}
                >
                  <p className={styles.beginningText}>
                    {t("states.receiptsUnreadLedgerRow", {
                      seq: row.seq,
                      kind: t(kindKey(row.kind)),
                      stage: t(stageKey(row.stage)),
                      deliveredAt: row.deliveredAt ?? t("states.receiptsUnreadTimeNone"),
                      readAt: row.readAt ?? t("states.receiptsUnreadTimeNone"),
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

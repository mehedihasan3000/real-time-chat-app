"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  decodeHistoryCursor,
  type HistoryMessageItem,
  type HistoryPageResponse,
} from "@chat/contracts";
import { OlmAccountDevice } from "@chat/crypto";

import { ActionButton } from "@/components/ui/action-button";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import surface from "@/components/ui/surface.module.css";
import {
  HistoryApiError,
  HistoryController,
  type HistoryFetchPageInput,
  type HistoryPageFetcher,
  type HistoryViewState,
} from "@/src/features/chat/history";
import { useI18n } from "@/src/i18n/provider";

import { HistoryPanel } from "./history-panel";
import styles from "./history-panel.module.css";

const FIXTURE_CONV_ID = "conv_p207_fixture_01";
const FIXTURE_ALICE_ID = "usr_p207_alice_01";
const FIXTURE_BOB_ID = "usr_p207_bob_02";
const FIXTURE_PAGE_SIZE = 3;

const SEEDED_MESSAGES: readonly string[] = [
  "প্রথম বার্তা — Welcome to encrypted history pagination",
  "দ্বিতীয় বার্তা — যুক্তাক্ষর: ক্ষ, জ্ঞ, য় ও র‍্যাপিড",
  "Third message — 🇧🇩👨‍👩‍👧‍👦💬🔐 mixed Unicode preserved",
  "Fourth message — server seq stays authoritative over timestamps",
  `<script>window.__p207XssFired = true;</script><img src=x onerror="window.__p207XssFired = true" />`,
  "ষষ্ঠ বার্তা — Concurrent sends never displace older pages",
  "Seventh message — Latest page arrives first, rendered in ascending order",
];

type FixtureFault = "none" | "empty" | "pending" | "offline" | "failed_once" | "forbidden";

interface FixtureBackend {
  alice: OlmAccountDevice;
  bob: OlmAccountDevice;
  records: HistoryMessageItem[];
  nextSeq: number;
  online: boolean;
  fault: FixtureFault;
  failOlderOnce: boolean;
  controller: HistoryController;
  unsubscribe: () => void;
  resolvePending?: () => void;
}

function makeCursorToken(conversationId: string, seq: number): string {
  const json = JSON.stringify({ v: 1, conversationId, seq });
  return globalThis.btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeWireItem(
  seq: number,
  senderDeviceId: string,
  encryptedEnvelope: string,
): HistoryMessageItem {
  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    messageId: `msg_p207_seq_${seq}`,
    conversationId: FIXTURE_CONV_ID,
    seq,
    senderUserId: FIXTURE_ALICE_ID,
    senderDeviceId,
    clientMessageId: globalThis.crypto.randomUUID(),
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    encryptedEnvelope,
    committedAt: new Date(Date.UTC(2026, 10, 19, 12, 0, seq)).toISOString(),
  };
}

const INITIAL_VIEW_STATE: HistoryViewState = {
  status: "empty",
  conversationId: FIXTURE_CONV_ID,
  items: [],
  hasMore: false,
  nextCursor: null,
};

/**
 * Interactive real-WASM history pagination & `FR-HIST-005` / `TC-HIST-004` state
 * showcase on `/states` (`P2-07`). Runs purely in browser memory with zero
 * network traffic and zero `localStorage` plaintext persistence (`DATA-013`).
 */
export function HistoryFixtureShowcase() {
  const { t } = useI18n();
  const backendRef = useRef<FixtureBackend | null>(null);
  const [viewState, setViewState] = useState<HistoryViewState>(INITIAL_VIEW_STATE);
  const [busy, setBusy] = useState(false);

  const teardownBackend = useCallback(() => {
    const prev = backendRef.current;
    if (!prev) return;
    prev.resolvePending?.();
    prev.unsubscribe();
    prev.controller.dispose();
    prev.alice.dispose();
    prev.bob.dispose();
    backendRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      teardownBackend();
    };
  }, [teardownBackend]);

  const createSeededBackend = useCallback(
    async (options: {
      fault?: FixtureFault;
      online?: boolean;
      useBobDevice?: boolean;
      seedMessages?: boolean;
    }): Promise<FixtureBackend> => {
      teardownBackend();

      const [alice, bob] = await Promise.all([
        OlmAccountDevice.create({ deviceId: "dev_p207_alice_01" }),
        OlmAccountDevice.create({ deviceId: "dev_p207_bob_02" }),
      ]);
      const bobBundle = bob.toPublicKeyBundle();
      const firstPreKey = bobBundle.oneTimeKeys[0]?.key ?? bobBundle.fallbackKey.key;

      const records: HistoryMessageItem[] = [];
      let seq = 0;
      if (options.seedMessages !== false) {
        for (const text of SEEDED_MESSAGES) {
          const encrypted = await alice.encryptForPeer(
            {
              peerUserId: FIXTURE_BOB_ID,
              peerDeviceId: bob.deviceId,
              peerIdentityKey: bob.identityKey,
              peerSenderKey: bob.senderKey,
              peerOneTimeOrFallbackKey: firstPreKey,
            },
            text,
          );
          if (encrypted.ok) {
            seq += 1;
            records.push(makeWireItem(seq, alice.deviceId, encrypted.value.encryptedEnvelope));
          }
        }
      }

      const stateObj: { backend: FixtureBackend | null } = { backend: null };

      const fetcher: HistoryPageFetcher = {
        async fetchPage(input: HistoryFetchPageInput): Promise<HistoryPageResponse> {
          const current = stateObj.backend;
          if (!current) {
            throw new HistoryApiError(500, "INTERNAL_ERROR", false);
          }
          if (!current.online || current.fault === "offline") {
            throw new HistoryApiError(0, "OFFLINE", true);
          }
          if (current.fault === "forbidden") {
            throw new HistoryApiError(
              403,
              "FORBIDDEN",
              false,
              "123e4567-e89b-42d3-a456-426614174007",
            );
          }
          if (current.fault === "pending") {
            await new Promise<void>((resolve) => {
              current.resolvePending = resolve;
            });
            throw new HistoryApiError(503, "TEMPORARILY_UNAVAILABLE", true);
          }
          if (current.fault === "failed_once") {
            current.fault = "none";
            throw new HistoryApiError(
              503,
              "TEMPORARILY_UNAVAILABLE",
              true,
              "123e4567-e89b-42d3-a456-426614174099",
            );
          }
          if (input.before !== undefined && current.failOlderOnce) {
            current.failOlderOnce = false;
            throw new HistoryApiError(
              503,
              "TEMPORARILY_UNAVAILABLE",
              true,
              "123e4567-e89b-42d3-a456-426614174088",
            );
          }
          if (current.fault === "empty") {
            return { items: [], nextCursor: null, hasMore: false };
          }

          const limit = input.limit ?? FIXTURE_PAGE_SIZE;
          let beforeSeq: number | null = null;
          if (input.before !== undefined) {
            const decoded = decodeHistoryCursor(input.before, input.conversationId);
            if (!decoded.ok || !decoded.value) {
              throw new HistoryApiError(400, "INVALID_CURSOR", false);
            }
            beforeSeq = decoded.value.seq;
          }

          const desc = [...current.records]
            .filter((r) => (beforeSeq === null ? true : r.seq < beforeSeq))
            .sort((a, b) => b.seq - a.seq);
          const hasMore = desc.length > limit;
          const items = desc.slice(0, limit).reverse();
          const nextCursor =
            hasMore && items.length > 0
              ? makeCursorToken(input.conversationId, items[0]!.seq)
              : null;

          return { items, nextCursor, hasMore };
        },
      };

      const controller = new HistoryController({
        accountId: FIXTURE_BOB_ID,
        conversationId: FIXTURE_CONV_ID,
        device: options.useBobDevice === false ? null : bob,
        client: fetcher,
        pageLimit: FIXTURE_PAGE_SIZE,
      });

      const unsubscribe = controller.subscribe((nextState) => {
        setViewState(nextState);
      });

      const backend: FixtureBackend = {
        alice,
        bob,
        records,
        nextSeq: seq,
        online: options.online ?? true,
        fault: options.fault ?? "none",
        failOlderOnce: false,
        controller,
        unsubscribe,
      };
      stateObj.backend = backend;
      backendRef.current = backend;
      return backend;
    },
    [teardownBackend],
  );

  const runLoadPaginated = useCallback(async () => {
    setBusy(true);
    try {
      const backend = await createSeededBackend({ fault: "none", online: true });
      await backend.controller.loadInitial();
    } finally {
      setBusy(false);
    }
  }, [createSeededBackend]);

  const runConcurrentSend = useCallback(async () => {
    setBusy(true);
    try {
      let backend = backendRef.current;
      if (!backend || backend.controller.getState().status !== "ready") {
        backend = await createSeededBackend({ fault: "none", online: true });
        await backend.controller.loadInitial();
      }
      const bobBundle = backend.bob.toPublicKeyBundle();
      const firstPreKey = bobBundle.oneTimeKeys[0]?.key ?? bobBundle.fallbackKey.key;
      const seq = backend.nextSeq + 1;
      const encrypted = await backend.alice.encryptForPeer(
        {
          peerUserId: FIXTURE_BOB_ID,
          peerDeviceId: backend.bob.deviceId,
          peerIdentityKey: backend.bob.identityKey,
          peerSenderKey: backend.bob.senderKey,
          peerOneTimeOrFallbackKey: firstPreKey,
        },
        `সমসাময়িক বার্তা #${seq} — Concurrent live message without duplicates`,
      );
      if (encrypted.ok) {
        backend.nextSeq = seq;
        const item = makeWireItem(seq, backend.alice.deviceId, encrypted.value.encryptedEnvelope);
        backend.records.push(item);
        await backend.controller.ingestLiveMessage(item);
        // Replay duplicate delivery to demonstrate deduplication by messageId
        await backend.controller.ingestLiveMessage(item);
      }
    } finally {
      setBusy(false);
    }
  }, [createSeededBackend]);

  const runFailOlder = useCallback(async () => {
    setBusy(true);
    try {
      const backend = await createSeededBackend({ fault: "none", online: true });
      await backend.controller.loadInitial();
      backend.failOlderOnce = true;
      await backend.controller.loadOlder();
    } finally {
      setBusy(false);
    }
  }, [createSeededBackend]);

  const runLoadingState = useCallback(async () => {
    const backend = await createSeededBackend({
      fault: "pending",
      online: true,
      seedMessages: false,
    });
    void backend.controller.loadInitial();
  }, [createSeededBackend]);

  const runEmptyState = useCallback(async () => {
    setBusy(true);
    try {
      const backend = await createSeededBackend({
        fault: "empty",
        online: true,
        seedMessages: false,
      });
      await backend.controller.loadInitial();
    } finally {
      setBusy(false);
    }
  }, [createSeededBackend]);

  const runOfflineState = useCallback(async () => {
    setBusy(true);
    try {
      const backend = await createSeededBackend({ fault: "offline", online: false });
      await backend.controller.loadInitial();
    } finally {
      setBusy(false);
    }
  }, [createSeededBackend]);

  const runFailedState = useCallback(async () => {
    setBusy(true);
    try {
      const backend = await createSeededBackend({ fault: "failed_once", online: true });
      await backend.controller.loadInitial();
    } finally {
      setBusy(false);
    }
  }, [createSeededBackend]);

  const runForbiddenState = useCallback(async () => {
    setBusy(true);
    try {
      const backend = await createSeededBackend({
        fault: "forbidden",
        online: true,
        seedMessages: false,
      });
      await backend.controller.loadInitial();
    } finally {
      setBusy(false);
    }
  }, [createSeededBackend]);

  const runKeyUnavailableState = useCallback(async () => {
    setBusy(true);
    try {
      const backend = await createSeededBackend({
        fault: "none",
        online: true,
        useBobDevice: false,
      });
      await backend.controller.loadInitial();
    } finally {
      setBusy(false);
    }
  }, [createSeededBackend]);

  const handleLoadOlder = useCallback(() => {
    const current = backendRef.current;
    if (!current) return;
    setBusy(true);
    void current.controller.loadOlder().finally(() => {
      setBusy(false);
    });
  }, []);

  const handleRetry = useCallback(() => {
    const current = backendRef.current;
    if (!current) return;
    current.online = true;
    if (current.fault === "offline") {
      current.fault = "none";
    }
    setBusy(true);
    void current.controller.retry().finally(() => {
      setBusy(false);
    });
  }, []);

  return (
    <section
      className={`${surface.card} ${styles.showcaseCard}`}
      aria-labelledby="history-fixture-showcase-title"
      data-testid="history-fixture-showcase"
    >
      <div className={styles.wrapper}>
        <div>
          <h2 className={surface.cardTitle} id="history-fixture-showcase-title">
            {t("states.historyTitle")}
          </h2>
          <p className={surface.cardDescription}>{t("states.historyDescription")}</p>
        </div>

        <PlaceholderNotice title={t("states.historyNoticeTitle")}>
          <p>{t("states.historyNoticeBody")}</p>
        </PlaceholderNotice>

        <div className={styles.toolbar}>
          <ActionButton variant="primary" disabled={busy} onClick={() => void runLoadPaginated()}>
            {t("states.historyBtnLoadPaginated")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            disabled={busy}
            onClick={() => void runConcurrentSend()}
          >
            {t("states.historyBtnConcurrentSend")}
          </ActionButton>
          <ActionButton variant="secondary" disabled={busy} onClick={() => void runFailOlder()}>
            {t("states.historyBtnFailOlder")}
          </ActionButton>
          <ActionButton variant="secondary" disabled={busy} onClick={() => void runLoadingState()}>
            {t("states.historyBtnLoading")}
          </ActionButton>
          <ActionButton variant="secondary" disabled={busy} onClick={() => void runEmptyState()}>
            {t("states.historyBtnEmpty")}
          </ActionButton>
          <ActionButton variant="secondary" disabled={busy} onClick={() => void runOfflineState()}>
            {t("states.historyBtnOffline")}
          </ActionButton>
          <ActionButton variant="secondary" disabled={busy} onClick={() => void runFailedState()}>
            {t("states.historyBtnFailed")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            disabled={busy}
            onClick={() => void runForbiddenState()}
          >
            {t("states.historyBtnForbidden")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            disabled={busy}
            onClick={() => void runKeyUnavailableState()}
          >
            {t("states.historyBtnKeyUnavailable")}
          </ActionButton>
        </div>

        <p className={styles.statusMeta} data-testid="history-fixture-status">
          {t("states.historyStatusSummary", {
            status: viewState.status,
            count: viewState.items.length,
          })}
        </p>

        <HistoryPanel
          state={viewState}
          onLoadOlder={handleLoadOlder}
          onRetry={handleRetry}
          onRetryOlder={handleLoadOlder}
        />
      </div>
    </section>
  );
}

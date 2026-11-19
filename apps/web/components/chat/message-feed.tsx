"use client";

import Link from "next/link";

import {
  toReceivedMessageViewModel,
  type ReceivedTimelineMessage,
} from "@/src/features/chat/receive";
import { useI18n } from "@/src/i18n/provider";

import styles from "./message-feed.module.css";

interface ReceivedMessageFeedProps {
  items: readonly ReceivedTimelineMessage[];
  ariaLabel: string;
  emptyMessage: string;
}

/**
 * Accessible, strictly inert message renderer (`P2-06`, `FR-CHAT-013`, `FR-CHAT-014`,
 * `NFR-REC-002`, `FR-SEC-013`).
 *
 * - Decrypted plaintext is rendered strictly as a React text node (`{vm.text}`),
 *   never via `dangerouslySetInnerHTML`, `innerHTML`, or untrusted URL attributes.
 * - Bengali combining sequences, emoji, mixed scripts, and script-like text render
 *   verbatim without normalization or HTML execution.
 * - Decryption failures render explicit localized placeholders with `data-receipt-eligible="false"`
 *   and never display an empty bubble or misleading delivered/read indicator.
 */
export function ReceivedMessageFeed({ items, ariaLabel, emptyMessage }: ReceivedMessageFeedProps) {
  const { t, formatDateTime } = useI18n();

  if (items.length === 0) {
    return (
      <p className={styles.emptyText} data-testid="receive-feed-empty">
        {emptyMessage}
      </p>
    );
  }

  return (
    <ol className={styles.list} aria-label={ariaLabel} data-testid="receive-message-feed">
      {items.map((item) => {
        const vm = toReceivedMessageViewModel(item, t, formatDateTime);
        const itemClass =
          vm.tone === "danger"
            ? `${styles.item} ${styles.itemDanger}`
            : vm.tone === "warning"
              ? `${styles.item} ${styles.itemWarning}`
              : styles.item;
        const pillClass =
          vm.tone === "danger"
            ? `${styles.statusPill} ${styles.pillDanger}`
            : vm.tone === "warning"
              ? `${styles.statusPill} ${styles.pillWarning}`
              : styles.statusPill;

        return (
          <li
            key={vm.messageId}
            className={itemClass}
            data-testid={`received-message-${vm.messageId}`}
            data-message-kind={vm.kind}
            data-failure-state={vm.failureState ?? "none"}
            data-receipt-eligible={String(vm.canEmitDeliveryReceipt)}
          >
            <div className={styles.itemHeader}>
              <span className={pillClass}>{vm.statusBadge}</span>
              <p className={styles.meta}>{vm.metaLabel}</p>
            </div>

            {vm.kind === "decrypted" ? (
              <p className={styles.messageText} data-testid={`received-plaintext-${vm.messageId}`}>
                {vm.text}
              </p>
            ) : (
              <div
                role="status"
                aria-live="polite"
                data-testid={`received-placeholder-${vm.messageId}`}
              >
                <p className={styles.placeholderTitle}>{vm.placeholderTitle}</p>
                <p className={styles.placeholderDescription}>{vm.placeholderDescription}</p>
                {vm.recoveryLabel && vm.recoveryHref ? (
                  <Link href={vm.recoveryHref} className={styles.recoveryLink}>
                    {vm.recoveryLabel}
                  </Link>
                ) : null}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

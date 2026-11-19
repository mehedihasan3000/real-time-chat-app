"use client";

import Link from "next/link";

import { ActionButton } from "@/components/ui/action-button";
import { StatePanel } from "@/components/ui/state-panel";
import type { HistoryViewState } from "@/src/features/chat/history";
import { useI18n } from "@/src/i18n/provider";

import styles from "./history-panel.module.css";
import { ReceivedMessageFeed } from "./message-feed";

interface HistoryPanelProps {
  state: HistoryViewState;
  onLoadOlder?: () => void;
  onRetry?: () => void;
  onRetryOlder?: () => void;
}

/**
 * Localized EN/BN conversation history panel (`P2-07`, `FR-HIST-002`,
 * `FR-HIST-005`, `FR-CHAT-012`–`014`, `ERR-002`, `TC-HIST-004`).
 *
 * Distinguishes `loading`, `empty`, `offline`, `failed`, `forbidden`,
 * `key-unavailable`, and paginated `ready` states without hiding or clearing
 * already-decrypted messages on older-page transient failures.
 */
export function HistoryPanel({ state, onLoadOlder, onRetry, onRetryOlder }: HistoryPanelProps) {
  const { t } = useI18n();

  if (state.status === "idle" || state.status === "loading") {
    return (
      <div data-testid="history-state-loading">
        <StatePanel
          kind="loading"
          live
          title={t("history.loadingTitle")}
          description={t("history.loadingDescription")}
        />
      </div>
    );
  }

  if (state.status === "empty") {
    return (
      <div data-testid="history-state-empty">
        <StatePanel
          kind="empty"
          title={t("history.emptyTitle")}
          description={t("history.emptyDescription")}
          action={<Link href="/search">{t("common.searchByUsername")}</Link>}
        />
      </div>
    );
  }

  if (state.status === "offline") {
    return (
      <div data-testid="history-state-offline">
        <StatePanel
          kind="disconnected"
          title={t("history.offlineTitle")}
          description={t("history.offlineDescription")}
          action={
            onRetry ? (
              <ActionButton variant="primary" onClick={onRetry}>
                {t("history.retry")}
              </ActionButton>
            ) : undefined
          }
        />
      </div>
    );
  }

  if (state.status === "forbidden") {
    const title =
      state.reason === "unauthenticated"
        ? t("history.unauthenticatedTitle")
        : t("history.forbiddenTitle");
    const description =
      state.reason === "unauthenticated"
        ? t("history.unauthenticatedDescription")
        : t("history.forbiddenDescription");
    const href = state.reason === "unauthenticated" ? "/sign-in" : "/conversations";
    const linkLabel =
      state.reason === "unauthenticated" ? t("common.openSignIn") : t("common.backToChats");

    return (
      <div data-testid="history-state-forbidden" data-forbidden-code={state.code}>
        <StatePanel
          kind="unauthorized"
          title={title}
          description={description}
          action={<Link href={href}>{linkLabel}</Link>}
        />
      </div>
    );
  }

  if (state.status === "key-unavailable") {
    return (
      <div data-testid="history-state-key-unavailable">
        <StatePanel
          kind="error"
          title={t("history.keyUnavailableTitle")}
          description={t("history.keyUnavailableDescription", { count: state.encryptedCount })}
          action={
            <div className={styles.actionRow}>
              <Link href={state.recoveryHref} prefetch={false}>
                {t("receiveMessage.action.reviewKeys")}
              </Link>
              <Link href="/conversations" className={styles.secondaryLink}>
                {t("common.backToChats")}
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  if (state.status === "failed") {
    const title = state.code ? t(state.copy.titleKey) : t("history.failedTitle");
    const description = state.code
      ? `${t(state.copy.descriptionKey)} ${t("history.failedRetryHint")}`
      : t("history.failedRetryHint");

    return (
      <div data-testid="history-state-failed">
        <StatePanel
          kind="error"
          live
          title={title}
          description={description}
          action={
            <div className={styles.wrapper}>
              {state.requestId ? (
                <p className={styles.supportRef}>
                  {t("history.supportReference", { requestId: state.requestId })}
                </p>
              ) : null}
              {onRetry ? (
                <div className={styles.actionRow}>
                  <ActionButton variant="primary" onClick={onRetry}>
                    {t("history.retry")}
                  </ActionButton>
                </div>
              ) : null}
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className={styles.wrapper} data-testid="history-state-ready">
      <div className={styles.historyBar}>
        {state.hasMore ? (
          <ActionButton variant="secondary" disabled={state.loadingOlder} onClick={onLoadOlder}>
            {state.loadingOlder ? t("history.loadingOlder") : t("history.loadOlder")}
          </ActionButton>
        ) : (
          <p className={styles.beginningText} data-testid="history-end-of-history">
            {t("history.beginningOfHistory")}
          </p>
        )}
      </div>

      {state.pageError ? (
        <div
          className={`${styles.inlineBanner} ${styles.bannerDanger}`}
          role="alert"
          data-testid="history-older-error"
        >
          <p className={styles.bannerTitle}>{t("history.olderPageErrorTitle")}</p>
          <p className={styles.bannerDescription}>{t("history.olderPageErrorDescription")}</p>
          {state.pageError.requestId ? (
            <p className={styles.supportRef}>
              {t("history.supportReference", { requestId: state.pageError.requestId })}
            </p>
          ) : null}
          {onRetryOlder ? (
            <div className={styles.bannerActions}>
              <ActionButton variant="secondary" onClick={onRetryOlder}>
                {t("history.retryOlder")}
              </ActionButton>
            </div>
          ) : null}
        </div>
      ) : null}

      {state.keyUnavailableBanner ? (
        <div
          className={`${styles.inlineBanner} ${styles.bannerWarning}`}
          role="status"
          data-testid="history-partial-key-warning"
        >
          <p className={styles.bannerDescription}>{t("history.partialKeyUnavailableNotice")}</p>
          <div className={styles.bannerActions}>
            <Link href="/settings/encryption" prefetch={false} className={styles.secondaryLink}>
              {t("receiveMessage.action.reviewKeys")}
            </Link>
          </div>
        </div>
      ) : null}

      <ReceivedMessageFeed
        items={state.items}
        ariaLabel={t("history.listLabel")}
        emptyMessage={t("history.emptyTitle")}
      />
    </div>
  );
}

"use client";

import Link from "next/link";

import { ActionButton } from "@/components/ui/action-button";
import { useI18n } from "@/src/i18n/provider";
import type { RealtimeClientSnapshot } from "@/src/lib/realtime";

import styles from "./realtime-sync-banner.module.css";

interface RealtimeSyncBannerProps {
  snapshot: RealtimeClientSnapshot;
  onRetrySync?: () => void;
}

/**
 * Localized EN/BN connection, reconnect catch-up, and expired-session banner
 * (`P2-08`, `FR-AUTH-007`, `NFR-REL-003`, `ERR-002`, `FR-HIST-003`).
 *
 * Exposes truthful disconnected/reconnecting/syncing/reauth states and halts
 * protected retry actions when `reauth_required`.
 */
export function RealtimeSyncBanner({ snapshot, onRetrySync }: RealtimeSyncBannerProps) {
  const { t } = useI18n();
  const { connectionStatus, reconnectAttempt, nextRetryDelayMs, sync, protectedActionsBlocked } =
    snapshot;

  if (connectionStatus === "reauth_required") {
    return (
      <div
        className={`${styles.banner} ${styles.bannerDanger}`}
        role="alert"
        data-testid="realtime-sync-banner"
        data-connection-status={connectionStatus}
        data-protected-blocked={String(protectedActionsBlocked)}
      >
        <div className={styles.headerRow}>
          <p className={styles.statusTitle}>{t("realtime.reauthTitle")}</p>
        </div>
        <p className={styles.detailText}>{t("realtime.reauthDescription")}</p>
        <div className={styles.actionsRow}>
          <Link href="/sign-in" className={styles.reauthLink}>
            {t("realtime.reauthAction")}
          </Link>
        </div>
      </div>
    );
  }

  let statusLabel: string;
  let detailText: string;
  let toneClass = styles.banner;

  switch (connectionStatus) {
    case "connected":
      statusLabel = t("realtime.statusConnected");
      detailText = t("realtime.connectedDetail", {
        seq: sync.lastAppliedSeq,
        recoveries: sync.gapRecoveries,
      });
      toneClass = `${styles.banner} ${styles.bannerConnected}`;
      break;
    case "connecting":
      statusLabel = t("realtime.statusConnecting");
      detailText = t("realtime.syncingDetail", {
        buffered: sync.bufferedCount,
        seq: sync.lastAppliedSeq,
      });
      break;
    case "syncing":
      statusLabel = t("realtime.statusSyncing");
      detailText = t("realtime.syncingDetail", {
        buffered: sync.bufferedCount,
        seq: sync.lastAppliedSeq,
      });
      toneClass = `${styles.banner} ${styles.bannerWarning}`;
      break;
    case "reconnecting": {
      const retrySeconds = Math.max(1, Math.round((nextRetryDelayMs ?? 1_000) / 1_000));
      statusLabel = t("realtime.statusReconnecting");
      detailText = t("realtime.reconnectingDetail", {
        attempt: Math.max(1, reconnectAttempt),
        seconds: retrySeconds,
      });
      toneClass = `${styles.banner} ${styles.bannerWarning}`;
      break;
    }
    case "disconnected":
    default:
      statusLabel = t("realtime.statusDisconnected");
      detailText = t("realtime.disconnectedDetail");
      toneClass = `${styles.banner} ${styles.bannerWarning}`;
      break;
  }

  const canManualRetry =
    !protectedActionsBlocked &&
    Boolean(onRetrySync) &&
    (connectionStatus === "disconnected" ||
      connectionStatus === "reconnecting" ||
      sync.phase === "error");

  return (
    <div
      className={toneClass}
      role="status"
      aria-live="polite"
      data-testid="realtime-sync-banner"
      data-connection-status={connectionStatus}
      data-protected-blocked={String(protectedActionsBlocked)}
    >
      <div className={styles.headerRow}>
        <p className={styles.statusTitle}>{t("realtime.statusLabel", { status: statusLabel })}</p>
      </div>
      <p className={styles.detailText}>{detailText}</p>
      {canManualRetry ? (
        <div className={styles.actionsRow}>
          <ActionButton variant="secondary" onClick={onRetrySync}>
            {t("realtime.retryNow")}
          </ActionButton>
        </div>
      ) : null}
    </div>
  );
}

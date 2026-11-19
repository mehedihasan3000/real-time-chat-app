"use client";

import { ActionButton } from "@/components/ui/action-button";
import { ActionLink } from "@/components/ui/action-link";
import { StatePanel } from "@/components/ui/state-panel";
import {
  buildSendStateBanners,
  toSendStateItemViewModel,
  type OutboxActionKind,
  type SendBadgeTone,
} from "@/src/features/chat/send-state";
import { useI18n } from "@/src/i18n/provider";
import type { OutboxRecord, OutboxSnapshot } from "@/src/lib/outbox/index";

import styles from "./send-state.module.css";

const TONE_CLASS: Record<SendBadgeTone, string | undefined> = {
  neutral: styles.badgeNeutral,
  progress: styles.badgeProgress,
  warning: styles.badgeWarning,
  success: styles.badgeSuccess,
  danger: styles.badgeDanger,
};

export function SendStateList({
  snapshot,
  entries,
  nowMs,
  onAction,
}: {
  snapshot: OutboxSnapshot;
  entries?: readonly OutboxRecord[];
  nowMs?: number;
  onAction?: (clientMessageId: string, kind: OutboxActionKind) => void;
}) {
  const { locale, t } = useI18n();
  const banners = buildSendStateBanners(snapshot);
  const items = entries ?? snapshot.entriesForActiveConversation;

  return (
    <div className={styles.wrapper} data-testid="send-state-region">
      {banners.map((banner, index) => (
        <StatePanel
          key={`${banner.kind}-${index}`}
          kind={banner.kind}
          title={t(banner.titleKey)}
          description={t(banner.descriptionKey)}
          live={banner.kind === "error"}
        />
      ))}

      {items.length > 0 ? (
        <ul className={styles.list} data-testid="send-state-list">
          {items.map((record) => {
            const vm = toSendStateItemViewModel(record, {
              online: snapshot.online,
              locale,
              nowMs,
            });
            return (
              <li
                key={vm.clientMessageId}
                className={styles.item}
                data-testid={`send-state-item-${vm.status}`}
                data-send-state={vm.status}
                data-client-message-id={vm.clientMessageId}
                role={vm.status === "failed" ? "alert" : undefined}
              >
                <div className={styles.itemHeader}>
                  <p className={styles.itemTitle}>{t(vm.titleKey)}</p>
                  <span className={`${styles.badge} ${TONE_CLASS[vm.badgeTone] ?? ""}`}>
                    {t(vm.statusLabelKey)}
                  </span>
                </div>

                <p className={styles.itemDescription}>
                  {t(vm.descriptionKey, vm.descriptionParams)}
                </p>

                <p className={styles.itemMeta} data-testid="send-state-meta">
                  {t("sendState.meta.idAndAttempts", {
                    id: vm.shortSendId,
                    attempts: vm.attemptCount,
                  })}
                </p>

                {vm.actions.length > 0 ? (
                  <div className={styles.actions}>
                    {vm.actions.map((action) => {
                      if (action.kind === "sign_in") {
                        return (
                          <ActionLink key={action.kind} href="/sign-in" variant="primary">
                            {t(action.labelKey)}
                          </ActionLink>
                        );
                      }
                      if (action.kind === "re_enroll_device") {
                        return (
                          <ActionLink key={action.kind} href="/settings" variant="primary">
                            {t(action.labelKey)}
                          </ActionLink>
                        );
                      }
                      const variant =
                        action.kind === "manual_retry"
                          ? "primary"
                          : action.kind === "discard"
                            ? "ghost"
                            : "secondary";
                      return (
                        <ActionButton
                          key={action.kind}
                          variant={variant}
                          onClick={() => onAction?.(vm.clientMessageId, action.kind)}
                        >
                          {t(action.labelKey)}
                        </ActionButton>
                      );
                    })}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

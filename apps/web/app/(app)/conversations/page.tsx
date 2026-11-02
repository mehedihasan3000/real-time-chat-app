"use client";

import Link from "next/link";

import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PhotoFrame } from "@/components/ui/photo-frame";
import { PressedFlower } from "@/components/ui/motif";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";
import { sampleConversation } from "@/lib/preview-data";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";

import styles from "./conversations.module.css";

export default function ConversationsPage() {
  const { t, formatDateTime, timeZone } = useI18n();
  const lastMessage = sampleConversation.messages[sampleConversation.messages.length - 1];

  return (
    <div className="u-stack">
      <DocumentTitle titleKey="documentTitle.chats" />
      <PageHeader
        eyebrow={t("conversations.eyebrow")}
        title={t("conversations.title")}
        description={t("conversations.description")}
        actions={
          <ActionLink href="/search" variant="secondary">
            {t("common.findSomeone")}
          </ActionLink>
        }
      />

      <PlaceholderNotice title={t("conversations.noticeTitle")}>
        <p>{t("conversations.noticeBody")}</p>
      </PlaceholderNotice>

      <div className={styles.layout}>
        <div className={styles.mainColumn}>
          <section className={styles.empty} aria-labelledby="empty-conversations-title">
            <PressedFlower className={styles.flower} />
            <p className={styles.emptyEyebrow}>{t("conversations.emptyEyebrow")}</p>
            <h2 className={styles.emptyTitle} id="empty-conversations-title">
              {t("conversations.emptyTitle")}
            </h2>
            <p className={styles.emptyBody}>{t("conversations.emptyBody")}</p>
            <ActionLink href="/search" variant="secondary">
              {t("common.searchByUsername")}
            </ActionLink>
          </section>

          <section className={surface.card} aria-labelledby="sample-conversations-title">
            <div className={surface.cardHeader}>
              <div>
                <h2 className={surface.cardTitle} id="sample-conversations-title">
                  {t("conversations.sampleTitle")}
                </h2>
                <p className={surface.cardDescription}>{t("conversations.sampleDescription")}</p>
                <p className={surface.hint} style={{ marginTop: "var(--space-2)" }}>
                  {t("time.displayTimeZone", { timezone: timeZone })}
                </p>
              </div>
              <span className={surface.badge}>{t("common.sample")}</span>
            </div>

            <Link
              className={styles.conversationRow}
              href={`/conversations/${sampleConversation.id}`}
            >
              <GeneratedAvatar
                userId={sampleConversation.participant.userId}
                name={sampleConversation.participant.name}
                size="md"
              />
              <span className={styles.rowCopy}>
                <span className={styles.rowName}>{sampleConversation.participant.name}</span>
                <span className={styles.rowSnippet}>
                  {lastMessage ? t(lastMessage.bodyKey) : null}
                </span>
              </span>
              <span className={styles.rowMeta}>
                {t("conversations.rowMeta", {
                  time: lastMessage
                    ? formatDateTime(lastMessage.sentAt, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "",
                })}
              </span>
            </Link>
          </section>
        </div>

        <aside className={styles.side} aria-labelledby="desktop-preview-title">
          <PhotoFrame
            src="/images/couple-silhouette.jpg"
            alt=""
            className={styles.sidePhoto}
            sizes="(min-width: 64rem) 22vw, 100vw"
            position="center 42%"
          >
            <span className={styles.sidePhotoBadge}>{t("conversations.sidePhotoBadge")}</span>
          </PhotoFrame>
          <h2 className={styles.sideTitle} id="desktop-preview-title">
            {t("conversations.sideTitle")}
          </h2>
          <p className={styles.sideBody}>{t("conversations.sideBody")}</p>
          <ActionLink href={`/conversations/${sampleConversation.id}`} variant="secondary">
            {t("common.openSampleThread")}
          </ActionLink>
          <p className={styles.sideNote}>{t("conversations.sideNote")}</p>
        </aside>
      </div>

      <section aria-labelledby="conversation-states-title">
        <h2 className="u-section-title" id="conversation-states-title">
          {t("conversations.statesTitle")}
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="loading"
            title={t("conversations.stateLoadingTitle")}
            description={t("conversations.stateLoadingDescription")}
          />
          <StatePanel
            kind="disconnected"
            title={t("conversations.stateDisconnectedTitle")}
            description={t("conversations.stateDisconnectedDescription")}
          />
          <StatePanel
            kind="error"
            title={t("conversations.stateErrorTitle")}
            description={t("conversations.stateErrorDescription")}
          />
        </div>
      </section>
    </div>
  );
}

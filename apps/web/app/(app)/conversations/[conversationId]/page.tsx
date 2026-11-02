"use client";

import Link from "next/link";
import { use } from "react";

import { PhoneIcon, SparklesIcon } from "@/components/icons";
import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewAction } from "@/components/ui/preview-action";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";
import { sampleConversation } from "@/lib/preview-data";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";

import styles from "./thread.module.css";

export default function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = use(params);
  const { t, formatDateTime, timeZone } = useI18n();

  if (conversationId !== sampleConversation.id) {
    return (
      <div className="u-stack">
        <DocumentTitle titleKey="documentTitle.conversation" />
        <PageHeader
          eyebrow={t("thread.eyebrow")}
          title={t("thread.title")}
          description={t("thread.description")}
          actions={
            <ActionLink href="/conversations" variant="secondary">
              {t("common.backToChats")}
            </ActionLink>
          }
        />
        <StatePanel
          kind="empty"
          title={t("thread.noConversationTitle")}
          description={t("thread.noConversationDescription", { id: conversationId })}
          action={
            <ActionLink href={`/conversations/${sampleConversation.id}`} variant="secondary">
              {t("thread.openSample")}
            </ActionLink>
          }
        />
      </div>
    );
  }

  return (
    <div className="u-stack">
      <DocumentTitle titleKey="documentTitle.conversation" />
      <PageHeader
        eyebrow={t("thread.sampleEyebrow")}
        title={sampleConversation.participant.name}
        description={t("thread.descriptionWithUsername", {
          username: sampleConversation.participant.username,
        })}
        actions={
          <>
            <ActionLink href="/conversations" variant="ghost">
              {t("common.backToChats")}
            </ActionLink>
            <ActionLink href="/calls/sample-call" variant="secondary">
              {t("common.previewCall")}
            </ActionLink>
          </>
        }
      />

      <PlaceholderNotice title={t("thread.noticeTitle")} tone="warning">
        <p>{t("thread.noticeBody")}</p>
      </PlaceholderNotice>

      <div className={styles.layout}>
        <section className={styles.thread} aria-labelledby="thread-title">
          <header className={styles.threadHeader}>
            <div className={styles.person}>
              <GeneratedAvatar
                userId={sampleConversation.participant.userId}
                name={sampleConversation.participant.name}
                size="md"
              />
              <div>
                <h2 className={styles.threadTitle} id="thread-title">
                  {sampleConversation.participant.name}
                </h2>
                <p className={styles.threadHandle}>
                  {t("thread.threadHandle", {
                    username: sampleConversation.participant.username,
                  })}
                </p>
              </div>
            </div>
            <div className={styles.threadBadges}>
              <span className={surface.badge}>{t("common.sample")}</span>
              <span className={surface.badge}>{t("common.notConnected")}</span>
            </div>
          </header>

          <div className={styles.threadActions}>
            <Link className={styles.iconLink} href="/calls/sample-call">
              <PhoneIcon size={18} />
              {t("thread.callPreview")}
            </Link>
            <Link className={styles.iconLink} href="/ai">
              <SparklesIcon size={18} />
              {t("common.aiAssist")}
            </Link>
            <span className={styles.actionNote}>{t("thread.actionNote")}</span>
          </div>

          <div className={styles.canvas}>
            <p className={styles.dateDivider}>
              <span>{t("common.today")}</span>
              <span>{t("common.sampleLower")}</span>
            </p>

            <ol className={surface.messageList}>
              {sampleConversation.messages.map((message) => (
                <li
                  className={`${surface.message} ${message.outgoing ? surface.messageOutgoing : ""}`}
                  key={message.id}
                >
                  <div className={surface.messageHeader}>
                    <span className={surface.messageAuthor}>
                      {message.outgoing ? t("common.you") : message.authorName}
                    </span>
                    <span className={surface.messageTime}>
                      {t("thread.messageTime", {
                        time: formatDateTime(message.sentAt, {
                          hour: "2-digit",
                          minute: "2-digit",
                        }),
                      })}
                    </span>
                  </div>
                  <p className={surface.messageBody}>{t(message.bodyKey)}</p>
                </li>
              ))}
            </ol>
          </div>

          <div className={surface.composer}>
            <label className={surface.cardTitle} htmlFor="message-draft">
              {t("thread.composerLabel")}
            </label>
            <textarea
              className={surface.textarea}
              id="message-draft"
              readOnly
              placeholder={t("thread.composerPlaceholder")}
              aria-describedby="message-draft-hint"
            />
            <p className={surface.hint} id="message-draft-hint">
              {t("thread.composerHint")}
            </p>
            <div className={surface.actions}>
              <PreviewAction
                message={t("thread.sendPreviewMessage")}
                describedBy="message-draft-hint"
              >
                {t("thread.previewSend")}
              </PreviewAction>
              <span className={surface.badge}>{t("thread.unknownOutcomeBadge")}</span>
            </div>
          </div>
        </section>

        <aside className={styles.side} aria-labelledby="thread-context-title">
          <h2 className={styles.sideTitle} id="thread-context-title">
            {t("thread.sideTitle")}
          </h2>
          <p className={styles.sideBody}>{t("thread.sideBody")}</p>
          <dl className={styles.sideMeta}>
            <div>
              <dt>{t("thread.messages")}</dt>
              <dd>{t("time.messageCount", { count: sampleConversation.messages.length })}</dd>
            </div>
            <div>
              <dt>{t("thread.receipts")}</dt>
              <dd>{t("common.notImplemented")}</dd>
            </div>
            <div>
              <dt>{t("thread.presence")}</dt>
              <dd>{t("thread.notShown")}</dd>
            </div>
            <div>
              <dt>{t("common.timezone")}</dt>
              <dd>{timeZone}</dd>
            </div>
            <div>
              <dt>{t("thread.composer")}</dt>
              <dd>{t("thread.readOnly")}</dd>
            </div>
          </dl>
          <div className={styles.sideActions}>
            <ActionLink href="/calls/sample-call" variant="secondary">
              {t("common.openCallStage")}
            </ActionLink>
            <ActionLink href="/ai" variant="ghost">
              {t("common.openAiSurfaces")}
            </ActionLink>
          </div>
          <p className={styles.sideNote}>{t("thread.sideNote")}</p>
        </aside>
      </div>

      <section aria-labelledby="thread-states-title">
        <h2 className="u-section-title" id="thread-states-title">
          {t("thread.statesTitle")}
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="disconnected"
            title={t("thread.stateDisconnectedTitle")}
            description={t("thread.stateDisconnectedDescription")}
          />
          <StatePanel
            kind="error"
            title={t("thread.stateUnknownTitle")}
            description={t("thread.stateUnknownDescription")}
          />
          <StatePanel
            kind="unauthorized"
            title={t("thread.stateInaccessibleTitle")}
            description={t("thread.stateInaccessibleDescription")}
            action={<Link href="/sign-in">{t("common.openSignIn")}</Link>}
          />
          <StatePanel
            kind="info"
            title={t("thread.statePresenceTitle")}
            description={t("thread.statePresenceDescription")}
          />
          <StatePanel
            kind="info"
            title={t("thread.stateUnreadTitle")}
            description={t("thread.stateUnreadDescription")}
          />
          <StatePanel
            kind="info"
            title={t("thread.stateReceiptsTitle")}
            description={t("thread.stateReceiptsDescription")}
          />
        </div>
      </section>

      <p className="u-muted u-small">{t("thread.userContentNote")}</p>
    </div>
  );
}

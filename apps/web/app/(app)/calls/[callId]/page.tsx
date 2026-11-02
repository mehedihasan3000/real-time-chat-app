"use client";

import Link from "next/link";
import { use } from "react";

import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { CallControls } from "@/components/ui/call-controls";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PhotoFrame } from "@/components/ui/photo-frame";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";
import { findSampleCall, sampleCall, sampleConversation } from "@/lib/preview-data";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";

import styles from "./call.module.css";

export default function CallPage({ params }: { params: Promise<{ callId: string }> }) {
  const { callId } = use(params);
  const { t, formatDateTime, formatDuration } = useI18n();
  const call = findSampleCall(callId);

  if (!call) {
    return (
      <div className="u-stack">
        <DocumentTitle titleKey="documentTitle.call" />
        <PageHeader
          eyebrow={t("call.eyebrow")}
          title={t("call.title")}
          description={t("call.description")}
          actions={
            <ActionLink href="/calls" variant="secondary">
              {t("common.backToCalls")}
            </ActionLink>
          }
        />
        <StatePanel
          kind="empty"
          title={t("call.noCallTitle")}
          description={t("call.noCallDescription", { id: callId })}
          action={
            <ActionLink href={`/calls/${sampleCall.id}`} variant="secondary">
              {t("call.openSample")}
            </ActionLink>
          }
        />
      </div>
    );
  }

  return (
    <div className="u-stack">
      <DocumentTitle titleKey="documentTitle.call" />
      <PageHeader
        eyebrow={t("call.eyebrow")}
        title={call.name}
        description={t("call.descriptionWithUsername", { username: call.username })}
        actions={
          <ActionLink href="/calls" variant="secondary">
            {t("common.backToCalls")}
          </ActionLink>
        }
      />

      <PlaceholderNotice title={t("call.noticeTitle")} tone="warning">
        <p>{t("call.noticeBody")}</p>
      </PlaceholderNotice>

      <section className={styles.stage} aria-labelledby="call-stage-title">
        <h2 className="visually-hidden" id="call-stage-title">
          {t("call.stageTitle")}
        </h2>
        <PhotoFrame
          src="/images/couple-silhouette.jpg"
          alt=""
          className={styles.stagePhoto}
          sizes="(min-width: 64rem) 76rem, 100vw"
          priority
          position="center 32%"
        >
          <span className={styles.stageScrim} aria-hidden="true" />
          <div className={styles.stageTop}>
            <span className={styles.stageBadge}>{t("call.stageBadge")}</span>
            <span className={styles.stageMeta}>
              {t("call.stageMeta", {
                kind: t(call.kindKey),
                direction: t(call.directionKey),
              })}
            </span>
          </div>

          <div className={styles.stagePeople}>
            <div className={styles.remoteFrame}>
              <GeneratedAvatar
                userId={call.userId}
                name={call.name}
                size="xl"
                ring
                decorative={false}
              />
              <p className={styles.remoteName}>{call.name}</p>
              <p className={styles.remoteHandle}>
                {t("call.sampleParticipant", { username: call.username })}
              </p>
            </div>

            <div className={styles.selfFrame}>
              <span className={styles.selfLabel}>{t("call.selfLabel")}</span>
              <GeneratedAvatar
                userId="preview-self"
                name={t("common.sampleUser")}
                size="lg"
                decorative={false}
              />
            </div>
          </div>

          <div className={styles.stageBottom}>
            <CallControls />
            <p className={styles.stageHint} id="call-controls-hint">
              {t("call.stageHint")}
            </p>
          </div>
        </PhotoFrame>
      </section>

      <div className={styles.layout}>
        <section className={surface.card} aria-labelledby="call-summary-title">
          <div className={surface.cardHeader}>
            <div>
              <h2 className={surface.cardTitle} id="call-summary-title">
                {t("call.summaryTitle")}
              </h2>
              <p className={surface.cardDescription}>{t("call.summaryDescription")}</p>
            </div>
            <span className={surface.badge}>{t(call.outcomeKey)}</span>
          </div>

          <dl className={surface.metaGrid}>
            <div className={surface.metaItem}>
              <dt className={surface.metaTerm}>{t("call.direction")}</dt>
              <dd className={surface.metaValue}>{t(call.directionKey)}</dd>
            </div>
            <div className={surface.metaItem}>
              <dt className={surface.metaTerm}>{t("call.type")}</dt>
              <dd className={surface.metaValue}>{t(call.kindKey)}</dd>
            </div>
            <div className={surface.metaItem}>
              <dt className={surface.metaTerm}>{t("call.started")}</dt>
              <dd className={surface.metaValue}>
                {formatDateTime(call.startedAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </dd>
            </div>
            <div className={surface.metaItem}>
              <dt className={surface.metaTerm}>{t("call.duration")}</dt>
              <dd className={surface.metaValue}>
                {call.durationSeconds === null
                  ? t("sample.call.notConnected")
                  : formatDuration(call.durationSeconds)}
              </dd>
            </div>
            <div className={surface.metaItem}>
              <dt className={surface.metaTerm}>{t("call.outcome")}</dt>
              <dd className={surface.metaValue}>{t(call.outcomeKey)}</dd>
            </div>
            <div className={surface.metaItem}>
              <dt className={surface.metaTerm}>{t("call.media")}</dt>
              <dd className={surface.metaValue}>{t("call.noMediaStored")}</dd>
            </div>
          </dl>
        </section>

        <aside className={styles.sideChat} aria-labelledby="side-chat-title">
          <div className={styles.sideChatHeader}>
            <h2 className={styles.sideChatTitle} id="side-chat-title">
              {t("call.sideChatTitle")}
            </h2>
            <span className={surface.badge}>{t("common.sample")}</span>
          </div>
          <p className={styles.sideChatNote}>{t("call.sideChatNote")}</p>
          <ol className={surface.messageList}>
            {sampleConversation.messages.slice(0, 2).map((message) => (
              <li className={surface.message} key={`call-${message.id}`}>
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
          <div className={styles.sideComposer}>
            <label className={surface.controlLabel} htmlFor="call-chat-draft">
              {t("call.messageLabel")}
            </label>
            <textarea
              className={surface.textarea}
              id="call-chat-draft"
              readOnly
              placeholder={t("call.sideChatPlaceholder")}
              aria-describedby="call-chat-hint"
            />
            <p className={surface.hint} id="call-chat-hint">
              {t("call.sideChatHint")}
            </p>
          </div>
        </aside>
      </div>

      <section aria-labelledby="call-detail-states-title">
        <h2 className="u-section-title" id="call-detail-states-title">
          {t("call.statesTitle")}
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="error"
            title={t("call.statePermissionTitle")}
            description={t("call.statePermissionDescription")}
          />
          <StatePanel
            kind="disconnected"
            title={t("call.stateMediaTitle")}
            description={t("call.stateMediaDescription")}
          />
          <StatePanel
            kind="unsupported"
            title={t("call.stateRelayTitle")}
            description={t("call.stateRelayDescription")}
            action={<Link href="/states">{t("common.viewAllUiStates")}</Link>}
          />
          <StatePanel
            kind="info"
            title={t("call.stateLifecycleTitle")}
            description={t("call.stateLifecycleDescription")}
          />
        </div>
      </section>
    </div>
  );
}

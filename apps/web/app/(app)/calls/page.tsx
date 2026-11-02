"use client";

import Link from "next/link";

import { PhoneIcon, PhoneOffIcon } from "@/components/icons";
import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PhotoFrame } from "@/components/ui/photo-frame";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";
import { sampleCalls } from "@/lib/preview-data";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";

import styles from "./calls.module.css";

export default function CallsPage() {
  const { t, formatDateTime, formatDuration, timeZone } = useI18n();

  return (
    <div className="u-stack">
      <DocumentTitle titleKey="documentTitle.calls" />
      <PageHeader
        eyebrow={t("calls.eyebrow")}
        title={t("calls.title")}
        description={t("calls.description")}
        actions={
          <ActionLink href="/calls/sample-call" variant="secondary">
            {t("calls.previewCallStage")}
          </ActionLink>
        }
      />

      <PlaceholderNotice title={t("calls.noticeTitle")}>
        <p>{t("calls.noticeBody")}</p>
      </PlaceholderNotice>

      <div className={styles.layout}>
        <div className={styles.mainColumn}>
          <StatePanel
            kind="empty"
            title={t("calls.emptyTitle")}
            description={t("calls.emptyDescription")}
            action={
              <ActionLink href="/conversations/sample-conversation" variant="secondary">
                {t("common.previewConversation")}
              </ActionLink>
            }
          />

          <section className={surface.card} aria-labelledby="sample-calls-title">
            <div className={surface.cardHeader}>
              <div>
                <h2 className={surface.cardTitle} id="sample-calls-title">
                  {t("calls.sampleTitle")}
                </h2>
                <p className={surface.cardDescription}>{t("calls.sampleDescription")}</p>
                <p className={surface.hint} style={{ marginTop: "var(--space-2)" }}>
                  {t("time.displayTimeZone", { timezone: timeZone })}
                </p>
              </div>
              <span className={surface.badge}>{t("common.sample")}</span>
            </div>

            <ul className={styles.callList}>
              {sampleCalls.map((call) => (
                <li key={call.id}>
                  <Link className={styles.callRow} href={`/calls/${call.id}`}>
                    <span className={styles.callIcon} aria-hidden="true">
                      {call.missed ? <PhoneOffIcon size={19} /> : <PhoneIcon size={19} />}
                    </span>
                    <GeneratedAvatar userId={call.userId} name={call.name} size="sm" />
                    <span className={styles.callCopy}>
                      <span className={styles.callName}>{call.name}</span>
                      <span className={styles.callMeta}>
                        {t("calls.callMeta", {
                          direction: t(call.directionKey),
                          kind: t(call.kindKey),
                          time: formatDateTime(call.startedAt, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          }),
                        })}
                      </span>
                    </span>
                    <span className={styles.callOutcome}>
                      <span className={surface.badge}>{t(call.outcomeKey)}</span>
                      <span className={styles.callDuration}>
                        {call.durationSeconds === null
                          ? t("sample.call.notConnected")
                          : formatDuration(call.durationSeconds)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className={styles.side} aria-labelledby="call-preview-title">
          <PhotoFrame
            src="/images/couple-silhouette.jpg"
            alt=""
            className={styles.sidePhoto}
            sizes="(min-width: 64rem) 22vw, 100vw"
            position="center 34%"
          >
            <span className={styles.sideScrim} aria-hidden="true" />
            <span className={styles.sideBadge}>{t("calls.sidePhotoBadge")}</span>
          </PhotoFrame>
          <h2 className={styles.sideTitle} id="call-preview-title">
            {t("calls.sideTitle")}
          </h2>
          <p className={styles.sideBody}>{t("calls.sideBody")}</p>
          <ActionLink href="/calls/sample-call" variant="secondary">
            {t("common.openSampleCall")}
          </ActionLink>
          <p className={styles.sideNote}>{t("calls.sideNote")}</p>
        </aside>
      </div>

      <section aria-labelledby="call-states-title">
        <h2 className="u-section-title" id="call-states-title">
          {t("calls.statesTitle")}
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="error"
            title={t("calls.statePermissionTitle")}
            description={t("calls.statePermissionDescription")}
          />
          <StatePanel
            kind="disconnected"
            title={t("calls.stateReconnectingTitle")}
            description={t("calls.stateReconnectingDescription")}
          />
          <StatePanel
            kind="unsupported"
            title={t("calls.stateRelayTitle")}
            description={t("calls.stateRelayDescription")}
          />
        </div>
      </section>
    </div>
  );
}

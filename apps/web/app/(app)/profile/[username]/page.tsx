"use client";

import Link from "next/link";
import { use } from "react";

import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewAction } from "@/components/ui/preview-action";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";
import { sampleConversation, sampleProfile } from "@/lib/preview-data";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";

import styles from "../profile.module.css";

export default function PublicProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = use(params);
  const { t } = useI18n();

  if (username !== sampleProfile.username) {
    return (
      <div className="u-stack">
        <DocumentTitle titleKey="documentTitle.publicProfile" />
        <PageHeader
          eyebrow={t("publicProfile.eyebrow")}
          title={t("publicProfile.title")}
          description={t("publicProfile.description")}
          actions={
            <ActionLink href="/search" variant="secondary">
              {t("common.backToSearch")}
            </ActionLink>
          }
        />
        <StatePanel
          kind="empty"
          title={t("publicProfile.noProfileTitle")}
          description={t("publicProfile.noProfileDescription", { username })}
          action={
            <ActionLink href={`/profile/${sampleProfile.username}`} variant="secondary">
              {t("publicProfile.openSample")}
            </ActionLink>
          }
        />
      </div>
    );
  }

  return (
    <div className="u-stack">
      <DocumentTitle titleKey="documentTitle.publicProfile" />
      <PageHeader
        eyebrow={t("publicProfile.eyebrow")}
        title={sampleProfile.name}
        description={t("publicProfile.descriptionWithUsername", {
          username: sampleProfile.username,
        })}
        actions={
          <ActionLink href={`/conversations/${sampleConversation.id}`} variant="secondary">
            {t("common.previewConversation")}
          </ActionLink>
        }
      />

      <PlaceholderNotice title={t("publicProfile.noticeTitle")}>
        <p>{t("publicProfile.noticeBody")}</p>
      </PlaceholderNotice>

      <section className={styles.hero} aria-labelledby="public-profile-title">
        <GeneratedAvatar
          userId={sampleProfile.userId}
          name={sampleProfile.name}
          size="xl"
          ring
          decorative={false}
        />
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>{t("publicProfile.sampleEyebrow")}</p>
          <h2 className={styles.name} id="public-profile-title">
            {sampleProfile.name}
          </h2>
          <p className={styles.handle}>@{sampleProfile.username}</p>
          <div className={surface.badgeRow}>
            <span className={surface.badge}>{t("common.sampleData")}</span>
            <span className={surface.badge}>{t("common.generatedAvatar")}</span>
          </div>
          <p className={styles.bio}>{t(sampleProfile.bioKey)}</p>
        </div>
      </section>

      <div className={styles.layout}>
        <section className={surface.card} aria-labelledby="safety-actions-title">
          <div className={surface.cardHeader}>
            <div>
              <h2 className={surface.cardTitle} id="safety-actions-title">
                {t("publicProfile.safetyTitle")}
              </h2>
              <p className={surface.cardDescription}>{t("publicProfile.safetyDescription")}</p>
            </div>
            <span className={surface.badge}>{t("common.preview")}</span>
          </div>

          <div className={surface.actions}>
            <PreviewAction
              message={t("publicProfile.blockMessage")}
              variant="danger"
              describedBy="block-action-hint"
            >
              {t("publicProfile.block")}
            </PreviewAction>
            <PreviewAction
              message={t("publicProfile.reportMessage")}
              describedBy="report-action-hint"
            >
              {t("publicProfile.report")}
            </PreviewAction>
          </div>
          <p
            className={surface.hint}
            id="block-action-hint"
            style={{ marginTop: "var(--space-3)" }}
          >
            {t("publicProfile.blockHint")}
          </p>
          <p
            className={surface.hint}
            id="report-action-hint"
            style={{ marginTop: "var(--space-2)" }}
          >
            {t("publicProfile.reportHint")}
          </p>
        </section>

        <aside className={styles.side} aria-labelledby="public-profile-context-title">
          <h2 className={styles.sideTitle} id="public-profile-context-title">
            {t("publicProfile.contextTitle")}
          </h2>
          <p className={styles.sideBody}>{t("publicProfile.contextBody")}</p>
          <ul className={styles.sideList}>
            <li>{t("publicProfile.contextList1")}</li>
            <li>{t("publicProfile.contextList2")}</li>
            <li>{t("publicProfile.contextList3")}</li>
            <li>{t("publicProfile.contextList4")}</li>
          </ul>
        </aside>
      </div>

      <section aria-labelledby="profile-safety-title">
        <h2 className="u-section-title" id="profile-safety-title">
          {t("publicProfile.statesTitle")}
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="info"
            title={t("publicProfile.stateBlockedTitle")}
            description={t("publicProfile.stateBlockedDescription")}
          />
          <StatePanel
            kind="unauthorized"
            title={t("publicProfile.stateUnavailableTitle")}
            description={t("publicProfile.stateUnavailableDescription")}
          />
        </div>
      </section>

      <p className="u-muted u-small">
        <Link href="/search">{t("common.backToSearch")}</Link> ·{" "}
        <Link href="/settings#blocked-users">{t("common.manageBlockedUsers")}</Link>
      </p>
    </div>
  );
}

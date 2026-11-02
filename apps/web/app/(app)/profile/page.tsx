"use client";

import Link from "next/link";

import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";
import { sampleProfile, sampleSelf } from "@/lib/preview-data";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";

import styles from "./profile.module.css";

export default function ProfilePage() {
  const { t, locale, timeZone } = useI18n();
  const localeName = locale === "bn" ? t("locale.bengali") : t("locale.english");

  return (
    <div className="u-stack">
      <DocumentTitle titleKey="documentTitle.profile" />
      <PageHeader
        eyebrow={t("profile.eyebrow")}
        title={t("profile.title")}
        description={t("profile.description")}
        actions={
          <ActionLink href="/settings" variant="secondary">
            {t("common.openSettings")}
          </ActionLink>
        }
      />

      <PlaceholderNotice title={t("profile.noticeTitle")}>
        <p>{t("profile.noticeBody")}</p>
      </PlaceholderNotice>

      <section className={styles.hero} aria-labelledby="own-profile-title">
        <GeneratedAvatar
          userId={sampleSelf.userId}
          name={sampleSelf.name}
          size="xl"
          ring
          decorative={false}
        />
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>{t("profile.sampleEyebrow")}</p>
          <h2 className={styles.name} id="own-profile-title">
            {sampleSelf.name}
          </h2>
          <p className={styles.handle}>@{sampleSelf.username}</p>
          <div className={surface.badgeRow}>
            <span className={surface.badge}>{t("common.generatedAvatar")}</span>
            <span className={surface.badge}>{t("common.noUpload")}</span>
            <span className={surface.badge}>{t("common.sampleData")}</span>
          </div>
          <p className={styles.bio}>{t(sampleSelf.bioKey)}</p>
          <div className={styles.heroActions}>
            <ActionLink href="/settings" variant="secondary">
              {t("common.settings")}
            </ActionLink>
            <ActionLink href="/onboarding/profile" variant="ghost">
              {t("common.previewProfileSetup")}
            </ActionLink>
          </div>
        </div>
      </section>

      <div className={styles.layout}>
        <section className={surface.card} aria-labelledby="profile-details-title">
          <div className={surface.cardHeader}>
            <div>
              <h2 className={surface.cardTitle} id="profile-details-title">
                {t("profile.detailsTitle")}
              </h2>
              <p className={surface.cardDescription}>{t("profile.detailsDescription")}</p>
            </div>
            <span className={surface.badge}>{t("common.notLoaded")}</span>
          </div>

          <dl className={surface.metaGrid}>
            <div className={surface.metaItem}>
              <dt className={surface.metaTerm}>{t("profile.email")}</dt>
              <dd className={surface.metaValue}>{t("common.notLoaded")}</dd>
            </div>
            <div className={surface.metaItem}>
              <dt className={surface.metaTerm}>{t("profile.username")}</dt>
              <dd className={surface.metaValue}>@{sampleSelf.username}</dd>
            </div>
            <div className={surface.metaItem}>
              <dt className={surface.metaTerm}>{t("profile.locale")}</dt>
              <dd className={surface.metaValue} lang={locale}>
                {localeName} {t("locale.provisional")}
              </dd>
            </div>
            <div className={surface.metaItem}>
              <dt className={surface.metaTerm}>{t("profile.timezone")}</dt>
              <dd className={surface.metaValue}>{timeZone}</dd>
            </div>
          </dl>

          <hr className={surface.divider} />

          <div className={surface.actions}>
            <ActionLink href={`/profile/${sampleProfile.username}`} variant="secondary">
              {t("common.openSampleProfile")}
            </ActionLink>
            <ActionLink href="/settings#blocked-users" variant="ghost">
              {t("common.manageBlockedUsers")}
            </ActionLink>
          </div>
        </section>

        <aside className={styles.side} aria-labelledby="profile-privacy-title">
          <h2 className={styles.sideTitle} id="profile-privacy-title">
            {t("profile.privacyTitle")}
          </h2>
          <p className={styles.sideBody}>{t("profile.privacyBody")}</p>
          <ul className={styles.sideList}>
            <li>{t("profile.privacyList1")}</li>
            <li>{t("profile.privacyList2")}</li>
            <li>{t("profile.privacyList3")}</li>
            <li>{t("profile.privacyList4")}</li>
          </ul>
          <p className={styles.sideNote}>{t("profile.privacyNote")}</p>
        </aside>
      </div>

      <section aria-labelledby="profile-states-title">
        <h2 className="u-section-title" id="profile-states-title">
          {t("profile.statesTitle")}
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="info"
            title={t("profile.stateAvatarTitle")}
            description={t("profile.stateAvatarDescription")}
          />
          <StatePanel
            kind="info"
            title={t("profile.statePersistenceTitle")}
            description={t("profile.statePersistenceDescription")}
          />
        </div>
      </section>

      <p className="u-muted u-small">
        {t("profile.lookingForSomeone")} <Link href="/search">{t("common.searchByUsername")}</Link>.
      </p>
    </div>
  );
}

"use client";

import Link from "next/link";

import { LocaleControl } from "@/components/i18n/locale-control";
import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewAction } from "@/components/ui/preview-action";
import { ThemeControl } from "@/components/theme/theme-control";
import surface from "@/components/ui/surface.module.css";
import { sampleSelf } from "@/lib/preview-data";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";
import type { MessageKey } from "@/src/i18n/catalog";

import styles from "./settings.module.css";

const sections: ReadonlyArray<{ href: string; labelKey: MessageKey }> = [
  { href: "#account", labelKey: "settings.navAccount" },
  { href: "#appearance", labelKey: "settings.navAppearance" },
  { href: "#profile-settings", labelKey: "settings.navProfile" },
  { href: "#privacy", labelKey: "settings.navPrivacy" },
  { href: "#blocked-users", labelKey: "settings.navBlocked" },
  { href: "#language-time", labelKey: "settings.navLanguage" },
  { href: "#data-sessions", labelKey: "settings.navData" },
  { href: "#ai", labelKey: "settings.navAi" },
];

export default function SettingsPage() {
  const { t, timeZone } = useI18n();

  return (
    <div className="u-stack">
      <DocumentTitle titleKey="documentTitle.settings" />
      <PageHeader
        eyebrow={t("settings.eyebrow")}
        title={t("settings.title")}
        description={t("settings.description")}
        actions={
          <ActionLink href="/profile" variant="secondary">
            {t("common.viewProfile")}
          </ActionLink>
        }
      />

      <PlaceholderNotice title={t("settings.noticeTitle")}>
        <p>{t("settings.noticeBody")}</p>
      </PlaceholderNotice>

      <div className={styles.layout}>
        <nav className={styles.nav} aria-label={t("settings.navAria")}>
          <ul className={styles.navList}>
            {sections.map((section) => (
              <li key={section.href}>
                <a href={section.href}>{t(section.labelKey)}</a>
              </li>
            ))}
          </ul>
        </nav>

        <div className={styles.content}>
          <section className={surface.card} id="account" aria-labelledby="account-title">
            <h2 className={surface.cardTitle} id="account-title">
              {t("settings.accountTitle")}
            </h2>
            <p className={surface.cardDescription}>{t("settings.accountDescription")}</p>
            <dl className={surface.metaGrid} style={{ marginTop: "var(--space-4)" }}>
              <div className={surface.metaItem}>
                <dt className={surface.metaTerm}>{t("common.email")}</dt>
                <dd className={surface.metaValue}>{t("common.notLoaded")}</dd>
              </div>
              <div className={surface.metaItem}>
                <dt className={surface.metaTerm}>{t("settings.emailVerification")}</dt>
                <dd className={surface.metaValue}>{t("settings.unknownAuth")}</dd>
              </div>
              <div className={surface.metaItem}>
                <dt className={surface.metaTerm}>{t("settings.session")}</dt>
                <dd className={surface.metaValue}>{t("settings.noSession")}</dd>
              </div>
            </dl>
            <div className={surface.actions} style={{ marginTop: "var(--space-4)" }}>
              <PreviewAction message={t("settings.signOutMessage")} describedBy="sign-out-hint">
                {t("settings.signOut")}
              </PreviewAction>
            </div>
            <p className={surface.hint} id="sign-out-hint" style={{ marginTop: "var(--space-2)" }}>
              {t("settings.signOutHint")}
            </p>
          </section>

          <section className={surface.card} id="appearance" aria-labelledby="appearance-title">
            <div className={surface.cardHeader}>
              <div>
                <h2 className={surface.cardTitle} id="appearance-title">
                  {t("settings.appearanceTitle")}
                </h2>
                <p className={surface.cardDescription}>{t("settings.appearanceDescription")}</p>
              </div>
              <span className={surface.badge}>{t("settings.savedLocally")}</span>
            </div>
            <ThemeControl />
          </section>

          <section
            className={surface.card}
            id="profile-settings"
            aria-labelledby="profile-settings-title"
          >
            <h2 className={surface.cardTitle} id="profile-settings-title">
              {t("settings.profileTitle")}
            </h2>
            <p className={surface.cardDescription}>{t("settings.profileDescription")}</p>
            <div className={surface.avatarRow} style={{ marginTop: "var(--space-4)" }}>
              <GeneratedAvatar
                userId={sampleSelf.userId}
                name={sampleSelf.name}
                size="md"
                decorative={false}
              />
              <div>
                <p className={surface.rowTitle}>{sampleSelf.name}</p>
                <p className={surface.rowMeta}>@{sampleSelf.username}</p>
              </div>
            </div>
            <div className={surface.actions} style={{ marginTop: "var(--space-4)" }}>
              <ActionLink href="/profile" variant="secondary">
                {t("common.openProfilePreview")}
              </ActionLink>
              <ActionLink href="/onboarding/profile" variant="ghost">
                {t("common.previewProfileSetup")}
              </ActionLink>
            </div>
          </section>

          <section className={surface.card} id="privacy" aria-labelledby="privacy-title">
            <h2 className={surface.cardTitle} id="privacy-title">
              {t("settings.privacyTitle")}
            </h2>
            <p className={surface.cardDescription}>{t("settings.privacyDescription")}</p>
            <ul className={surface.controlList} style={{ marginTop: "var(--space-4)" }}>
              <li className={surface.controlRow}>
                <div className={surface.controlCopy}>
                  <p className={surface.controlLabel}>{t("settings.readReceipts")}</p>
                  <p className={surface.controlHint} id="receipts-hint">
                    {t("settings.readReceiptsHint")}
                  </p>
                </div>
                <label className={surface.checkboxRow} htmlFor="read-receipts">
                  <input
                    id="read-receipts"
                    type="checkbox"
                    disabled
                    aria-describedby="receipts-hint"
                  />
                  <span>{t("settings.disabledPreview")}</span>
                </label>
              </li>
              <li className={surface.controlRow}>
                <div className={surface.controlCopy}>
                  <p className={surface.controlLabel}>{t("settings.aiProcessing")}</p>
                  <p className={surface.controlHint} id="ai-privacy-hint">
                    {t("settings.aiProcessingHint")}
                  </p>
                </div>
                <Link href="/ai">{t("common.openAiSurfaces")}</Link>
              </li>
            </ul>
          </section>

          <section
            className={surface.card}
            id="blocked-users"
            aria-labelledby="blocked-users-title"
          >
            <h2 className={surface.cardTitle} id="blocked-users-title">
              {t("settings.blockedTitle")}
            </h2>
            <p className={surface.cardDescription}>{t("settings.blockedDescription")}</p>
            <div className={surface.actions} style={{ marginTop: "var(--space-4)" }}>
              <ActionLink href="/profile/nusrat_j" variant="secondary">
                {t("settings.previewSafetyProfile")}
              </ActionLink>
            </div>
          </section>

          <section
            className={surface.card}
            id="language-time"
            aria-labelledby="language-time-title"
          >
            <h2 className={surface.cardTitle} id="language-time-title">
              {t("settings.languageTitle")}
            </h2>
            <p className={surface.cardDescription}>{t("settings.languageDescription")}</p>
            <div style={{ marginTop: "var(--space-4)" }}>
              <LocaleControl />
            </div>
            <div className={styles.fieldGrid} style={{ marginTop: "var(--space-4)" }}>
              <div>
                <label className={surface.controlLabel} htmlFor="display-timezone">
                  {t("settings.displayTimezone")}
                </label>
                <p className={surface.controlHint} id="display-timezone-hint">
                  {t("settings.displayTimezoneHint")}
                </p>
                <input
                  className={surface.select}
                  id="display-timezone"
                  type="text"
                  readOnly
                  value={timeZone}
                  aria-describedby="display-timezone-hint"
                  style={{ marginTop: "var(--space-2)", width: "100%" }}
                />
              </div>
            </div>
            <p className={surface.hint} style={{ marginTop: "var(--space-3)" }}>
              {t("settings.languageSavedNote")}
            </p>
          </section>

          <section
            className={surface.card}
            id="data-sessions"
            aria-labelledby="data-sessions-title"
          >
            <h2 className={surface.cardTitle} id="data-sessions-title">
              {t("settings.dataTitle")}
            </h2>
            <p className={surface.cardDescription}>{t("settings.dataDescription")}</p>
            <ul className={surface.controlList} style={{ marginTop: "var(--space-4)" }}>
              <li className={surface.controlRow}>
                <div className={surface.controlCopy}>
                  <p className={surface.controlLabel}>{t("settings.export")}</p>
                  <p className={surface.controlHint} id="export-hint">
                    {t("settings.exportHint")}
                  </p>
                </div>
                <PreviewAction message={t("settings.exportMessage")} describedBy="export-hint">
                  {t("settings.export")}
                </PreviewAction>
              </li>
              <li className={surface.controlRow}>
                <div className={surface.controlCopy}>
                  <p className={surface.controlLabel}>{t("settings.deleteAccount")}</p>
                  <p className={surface.controlHint} id="delete-account-hint">
                    {t("settings.deleteHint")}
                  </p>
                </div>
                <PreviewAction
                  message={t("settings.deleteMessage")}
                  variant="danger"
                  describedBy="delete-account-hint"
                >
                  {t("settings.deleteAccount")}
                </PreviewAction>
              </li>
              <li className={surface.controlRow}>
                <div className={surface.controlCopy}>
                  <p className={surface.controlLabel}>{t("settings.otherSessions")}</p>
                  <p className={surface.controlHint} id="other-sessions-hint">
                    {t("settings.otherSessionsHint")}
                  </p>
                </div>
                <PreviewAction
                  message={t("settings.revokeMessage")}
                  describedBy="other-sessions-hint"
                >
                  {t("settings.otherSessions")}
                </PreviewAction>
              </li>
            </ul>
          </section>

          <section className={surface.card} id="ai" aria-labelledby="settings-ai-title">
            <h2 className={surface.cardTitle} id="settings-ai-title">
              {t("settings.aiTitle")}
            </h2>
            <p className={surface.cardDescription}>{t("settings.aiDescription")}</p>
            <div className={surface.actions} style={{ marginTop: "var(--space-4)" }}>
              <ActionLink href="/ai" variant="secondary">
                {t("common.openAiSurfaces")}
              </ActionLink>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

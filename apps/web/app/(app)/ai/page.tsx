"use client";

import { ChatIcon, GlobeIcon, SparklesIcon } from "@/components/icons";
import { ActionLink } from "@/components/ui/action-link";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";
import type { MessageKey } from "@/src/i18n/catalog";

import styles from "./ai.module.css";

const features: ReadonlyArray<{
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  icon: typeof ChatIcon;
}> = [
  {
    titleKey: "ai.featureSmartTitle",
    descriptionKey: "ai.featureSmartDescription",
    icon: ChatIcon,
  },
  {
    titleKey: "ai.featureTranslateTitle",
    descriptionKey: "ai.featureTranslateDescription",
    icon: GlobeIcon,
  },
  {
    titleKey: "ai.featureSummaryTitle",
    descriptionKey: "ai.featureSummaryDescription",
    icon: SparklesIcon,
  },
];

export default function AiPage() {
  const { t } = useI18n();

  return (
    <div className="u-stack">
      <DocumentTitle titleKey="documentTitle.ai" />
      <PageHeader
        eyebrow={t("ai.eyebrow")}
        title={t("ai.title")}
        description={t("ai.description")}
        actions={
          <ActionLink href="/settings#privacy" variant="secondary">
            {t("common.privacySettings")}
          </ActionLink>
        }
      />

      <PlaceholderNotice title={t("ai.noticeTitle")} tone="warning">
        <p>{t("ai.noticeBody")}</p>
      </PlaceholderNotice>

      <StatePanel
        kind="unsupported"
        title={t("ai.unavailableTitle")}
        description={t("ai.unavailableDescription")}
        action={
          <ActionLink href="/states" variant="secondary">
            {t("common.viewAllUiStates")}
          </ActionLink>
        }
      />

      <section aria-labelledby="ai-features-title">
        <h2 className="u-section-title" id="ai-features-title">
          {t("ai.featuresTitle")}
        </h2>
        <div className={styles.featureGrid} style={{ marginTop: "var(--space-3)" }}>
          {features.map((feature) => {
            const Icon = feature.icon;

            return (
              <article className={styles.featureCard} key={feature.titleKey}>
                <span className={styles.featureIcon} aria-hidden="true">
                  <Icon size={22} />
                </span>
                <div className={styles.featureHeader}>
                  <h3 className={styles.featureTitle}>{t(feature.titleKey)}</h3>
                  <span className={surface.badge}>{t("common.notAvailable")}</span>
                </div>
                <p className={styles.featureBody}>{t(feature.descriptionKey)}</p>
                <p className={styles.featureNote}>{t("common.noContentProcessed")}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className={styles.consent} aria-labelledby="ai-consent-title">
        <div className={styles.consentCopy}>
          <p className={styles.consentEyebrow}>{t("ai.consentEyebrow")}</p>
          <h2 className={styles.consentTitle} id="ai-consent-title">
            {t("ai.consentTitle")}
          </h2>
          <p className={styles.consentBody}>{t("ai.consentBody")}</p>
          <ul className={styles.consentList}>
            <li>{t("ai.consentList1")}</li>
            <li>{t("ai.consentList2")}</li>
            <li>{t("ai.consentList3")}</li>
            <li>{t("ai.consentList4")}</li>
          </ul>
        </div>
        <div className={styles.consentControl}>
          <label className={styles.consentCheck} htmlFor="ai-consent-preview">
            <input id="ai-consent-preview" type="checkbox" disabled />
            <span>{t("ai.consentCheck")}</span>
          </label>
          <p className={styles.consentHint}>{t("ai.consentHint")}</p>
        </div>
      </section>

      <section aria-labelledby="ai-states-title">
        <h2 className="u-section-title" id="ai-states-title">
          {t("ai.statesTitle")}
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="loading"
            title={t("ai.stateProgressTitle")}
            description={t("ai.stateProgressDescription")}
          />
          <StatePanel
            kind="error"
            title={t("ai.stateProviderTitle")}
            description={t("ai.stateProviderDescription")}
          />
          <StatePanel
            kind="unauthorized"
            title={t("ai.stateConsentTitle")}
            description={t("ai.stateConsentDescription")}
          />
        </div>
      </section>
    </div>
  );
}

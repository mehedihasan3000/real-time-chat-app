"use client";

import Link from "next/link";

import { ChevronLeftIcon } from "@/components/icons";
import { LocaleToggle } from "@/components/i18n/locale-toggle";
import { OnboardingForm } from "@/components/onboarding/onboarding-form";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { PhotoFrame } from "@/components/ui/photo-frame";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";

import styles from "./onboarding.module.css";

export default function OnboardingPage() {
  const { t } = useI18n();

  return (
    <div className={styles.shell}>
      <DocumentTitle titleKey="documentTitle.onboarding" />
      <header className={styles.header}>
        <Link href="/profile" className={styles.back}>
          <ChevronLeftIcon size={19} />
          {t("onboarding.page.back")}
        </Link>
        <div className={styles.headerActions}>
          <LocaleToggle />
          <ThemeToggle />
        </div>
      </header>

      <main id="main-content" className={styles.main} tabIndex={-1}>
        <div className={styles.layout}>
          <aside className={styles.photoPanel} aria-label={t("onboarding.page.photoAria")}>
            <PhotoFrame
              src="/images/couple-silhouette.jpg"
              alt={t("onboarding.page.photoAlt")}
              className={styles.photo}
              sizes="(min-width: 64rem) 46vw, 100vw"
              priority
              position="center 36%"
            >
              <span className={styles.photoScrim} aria-hidden="true" />
              <div className={styles.photoContent}>
                <span className={styles.photoBadge}>{t("onboarding.page.photoBadge")}</span>
                <p className={styles.photoTitle}>{t("onboarding.page.photoTitle")}</p>
                <p className={styles.photoBody}>{t("onboarding.page.photoBody")}</p>
              </div>
            </PhotoFrame>
          </aside>

          <section className={styles.formPanel} aria-labelledby="onboarding-title">
            <div className={styles.formIntro}>
              <p className={styles.eyebrow}>{t("onboarding.page.eyebrow")}</p>
              <h1 className={styles.title} id="onboarding-title">
                {t("onboarding.page.title")}
              </h1>
              <p className={styles.description}>{t("onboarding.page.description")}</p>
            </div>

            <OnboardingForm />
          </section>
        </div>
      </main>

      <footer className={styles.footer}>
        <p>{t("onboarding.page.footer")}</p>
        <nav aria-label={t("nav.secondary")}>
          <Link href="/">{t("nav.uiSurfaces")}</Link>
          <Link href="/profile">{t("nav.profilePreview")}</Link>
          <Link href="/states">{t("nav.uiStates")}</Link>
        </nav>
      </footer>
    </div>
  );
}

"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { HeartIcon } from "@/components/icons";
import { LocaleToggle } from "@/components/i18n/locale-toggle";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { PhotoFrame } from "@/components/ui/photo-frame";
import { useI18n } from "@/src/i18n/provider";

import styles from "./auth-layout.module.css";

export default function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" className={styles.home} aria-label={t("auth.layout.homeAria")}>
          <span className={styles.homeMark} aria-hidden="true">
            <HeartIcon size={17} />
          </span>
          <span>{t("shell.homeTitle")}</span>
        </Link>
        <div className={styles.headerActions}>
          <nav className={styles.headerNav} aria-label={t("nav.account")}>
            <Link href="/sign-in">{t("common.signIn")}</Link>
            <Link href="/sign-up">{t("common.createAccount")}</Link>
          </nav>
          <LocaleToggle />
          <ThemeToggle />
        </div>
      </header>

      <main id="main-content" className={styles.main} tabIndex={-1}>
        <div className={styles.layout}>
          <aside className={styles.photoPanel} aria-label={t("auth.layout.photoAria")}>
            <PhotoFrame
              src="/images/couple-silhouette.jpg"
              alt={t("auth.layout.photoAlt")}
              className={styles.photo}
              sizes="(min-width: 64rem) 55vw, 100vw"
              priority
              position="center 38%"
            >
              <span className={styles.photoScrim} aria-hidden="true" />
              <div className={styles.photoContent}>
                <span className={styles.photoBadge}>{t("common.staticPreview")}</span>
                <p className={styles.photoTitle}>{t("auth.layout.photoTitle")}</p>
                <p className={styles.photoBody}>{t("auth.layout.photoBody")}</p>
              </div>
            </PhotoFrame>
          </aside>

          <div className={styles.formPanel}>{children}</div>
        </div>
      </main>

      <footer className={styles.footer}>
        <p>{t("auth.layout.footer")}</p>
        <nav aria-label={t("nav.secondary")}>
          <Link href="/">{t("nav.uiSurfaces")}</Link>
          <Link href="/states">{t("nav.uiStates")}</Link>
          <Link href="/profile">{t("nav.profilePreview")}</Link>
        </nav>
      </footer>
    </div>
  );
}
